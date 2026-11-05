// Tests for the recorder, against a real SQLite database (node:sqlite) behind a stand-in for Cloudflare's D1
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fromFeed } from './src/core.js';
import worker, { record, handle } from './src/index.js';
import { siteApi } from './src/site.js';
import { accessEmail, forgetAccessKeys } from './src/access.js';
import { isoSeconds, creditedArtists } from './src/youtube.js';

let fail = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : '  — ' + detail}`); if (!ok) fail++; };

function fakeD1(schema = './schema.sql') {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(new URL(schema, import.meta.url), 'utf8'));
  // Like D1: run() and batch() give { meta: { changes } }, and a SELECT in a batch gives { results }
  const exec = (sql, args) => /^\s*SELECT/i.test(sql) ? { results: db.prepare(sql).all(...args) } : { meta: { changes: Number(db.prepare(sql).run(...args).changes) } };
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) || null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => exec(sql, args),
    exec: () => exec(sql, args),
  });
  const batch = async list => { db.exec('BEGIN'); try { const out = list.map(s => s.exec()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  return { prepare: sql => stmt(sql), batch, raw: db };
}
const feed = rows => rows.map(([date, artist, title]) => ({ date: String(date), artist, title, album: 'Alb' }));
const somaFM = (rows, nowS, status = 200) => async () => new Response(JSON.stringify({ id: 'christmas', songs: feed(rows) }),
  { status, headers: { 'Content-Type': 'application/json', Date: new Date(nowS * 1000).toUTCString() } });

const KEY = 'k'.repeat(32);
const env = { DB: fakeD1(), KEY, CHANNELS: 'christmas', ALLOW_ORIGIN: 'https://somafm.com' };
const call = (path, { key = KEY, method = 'GET', body } = {}) => handle(new Request('https://rec.example' + path,
  { method, headers: key ? { Authorization: 'Bearer ' + key } : {}, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) }), env);
const titles = list => list.map(p => p[2]).join();

// core
const now = 1793500000;
const first = fromFeed(feed([[now - 100, 'B', 'Two'], [now - 200, 'SomaFM', 'Station ID'], [now - 400, 'A', 'One']]), now, null);
check('first look: every play, no gap; station IDs become breaks', first.plays.length === 2 && first.plays[0][2] === 'Two' && !first.plays[1][4] && first.breaks.join() === String(now - 200));
const next = fromFeed(feed([[now + 200, 'C', 'Three'], [now - 100, 'B', 'Two'], [now - 400, 'A', 'One']]), now + 250, [[now - 100, 'B', 'Two', 'Alb']]);
check('next look: only newer plays', next.plays.length === 1 && next.plays[0][2] === 'Three' && !next.plays[0][4]);
const late = fromFeed(feed([[now + 9000, 'E', 'Five'], [now + 8800, 'D', 'Four']]), now + 9100, [[now - 100, 'B', 'Two', 'Alb']]);
check('after missing a stretch: the oldest new play is flagged after a gap', late.plays.length === 2 && late.plays[1][4] === 1 && !late.plays[0][4]);

// record (the 10-minute job)
let r = await record(env, 'christmas', somaFM([[now - 100, 'B', 'Two'], [now - 200, 'SomaFM', 'Station ID'], [now - 400, 'A', 'One']], now));
r = await record(env, 'christmas', somaFM([[now + 200, 'C', 'Three'], [now - 100, 'B', 'Two'], [now - 400, 'A', 'One']], now + 250));
const rows = env.DB.raw.prepare('SELECT at, title, gap, added FROM plays ORDER BY at DESC').all();
check('two looks keep each play once, newest first, with when each was stored', r.ok && r.added === 1 && titles(rows.map(x => [0, 0, x.title])) === 'Three,Two,One' && rows.every(x => !x.gap && x.added > 0), JSON.stringify(rows));
r = await record(env, 'christmas', somaFM([[now + 200, 'C', 'Three']], now + 300));
check('the same list again adds nothing', r.ok && r.added === 0 && env.DB.raw.prepare('SELECT COUNT(*) n FROM plays').get().n === 3);
r = await record(env, 'christmas', somaFM([[now + 9000, 'E', 'Five'], [now + 8800, 'D', 'Four']], now + 9100));
check('a missed stretch is flagged on the first play after it', env.DB.raw.prepare("SELECT gap FROM plays WHERE title = 'Four'").get().gap === 1);
r = await record(env, 'christmas', somaFM([], now + 9200, 503));
const run = env.DB.raw.prepare('SELECT * FROM runs').get();
check('a failed look is noted, keeping when the last good one was', !r.ok && run.ok === 0 && /503/.test(run.note) && run.last_ok === now + 9100, JSON.stringify(run));
const dayAhead = await record(env, 'christmas', somaFM([[now + 9300 + 86400, 'F', 'Misdated']], now + 9400));
check('a play SomaFM dates a day ahead is recorded at the right time', dayAhead.ok && env.DB.raw.prepare("SELECT at FROM plays WHERE title = 'Misdated'").get().at === now + 9300);

// Nov 1, 2026: SomaFM's feed dated plays an hour late, then an hour early, around the end of daylight saving time
const dst = { DB: fakeD1(), KEY, CHANNELS: 'christmas' };
const H0 = now + 20000;
await record(dst, 'christmas', somaFM([[H0 - 300, 'A', 'Real 1'], [H0 - 100, 'B', 'Real 2']], H0));
await record(dst, 'christmas', somaFM([[H0 + 3600 + 200, 'C', 'Real 3'], [H0 + 3600 - 100, 'B', 'Real 2'], [H0 + 3600 - 300, 'A', 'Real 1']], H0 + 400));   // an hour late
await record(dst, 'christmas', somaFM([[H0 + 600 - 3600, 'D', 'Real 4'], [H0 + 200 - 3600, 'C', 'Real 3']], H0 + 700));                                       // an hour early
const dstRows = dst.DB.raw.prepare('SELECT at, title, gap FROM plays ORDER BY at').all();
check('a feed dated an hour late or early is recorded at the right times, with nothing copied',
  dstRows.length === 4 && dstRows.map(r => r.at - H0).join() === '-300,-100,200,600' && dstRows.every(r => !r.gap), JSON.stringify(dstRows));

// the scheduled entry point records every listed station
const jobs = [];
const realFetch = globalThis.fetch;
globalThis.fetch = somaFM([[now + 9600, 'G', 'Six']], now + 9700);
await worker.scheduled({}, env, { waitUntil: p => jobs.push(p) });
await Promise.all(jobs);
globalThis.fetch = realFetch;
check('the 10-minute job records each station listed', jobs.length === 1 && env.DB.raw.prepare("SELECT COUNT(*) n FROM plays WHERE title = 'Six'").get().n === 1);

// reading it back
let res = await call('/plays?channel=christmas&since=0', { key: null });
check('no key: refused', res.status === 401 && res.headers.get('Access-Control-Allow-Origin') === 'https://somafm.com');
res = await call('/plays?channel=christmas&since=0', { key: 'x'.repeat(32) });
check('wrong key: refused', res.status === 401);
res = await call('/plays?channel=christmas', { method: 'OPTIONS' });
check('the browser\'s preflight is answered for somafm.com, for reading and sending', res.status === 204 && /Content-Type/.test(res.headers.get('Access-Control-Allow-Headers')) && /PUT/.test(res.headers.get('Access-Control-Allow-Methods')));
res = await call('/plays?channel=christmas&since=0');
let body = await res.json();
check('with the key: every play newest first, gap flags, breaks, and how the last look went',
  res.status === 200 && body.plays.length === 7 && body.plays[0][2] === 'Six' && body.plays.find(p => p[2] === 'Four')[4] === 1 && body.plays.find(p => p[2] === 'Two').length === 4
  && body.breaks.length === 1 && body.lastRun.ok && body.recording && res.headers.get('Cache-Control') === 'no-store', JSON.stringify(body).slice(0, 300));
check('another station: nothing recorded, and it says so', (await (await call('/plays?channel=groovesalad')).json()).recording === false);
check('a bad station name is refused', (await call('/plays?channel=../x')).status === 400);
check('a weak key on the server refuses everything', (await handle(new Request('https://rec.example/plays', { headers: { Authorization: 'Bearer short' } }), Object.assign({}, env, { KEY: 'short' }))).status === 401);

// 3.22: devices send what they recorded; "since" asks by when rows were stored, so old plays sent later still reach the others
env.DB.raw.exec('UPDATE plays SET added = 1000');   // everything so far stored long ago
const before = (await (await call('/plays?channel=christmas&since=2000')).json()).plays;
res = await call('/plays?channel=christmas', { method: 'POST', body: { plays: [[now - 3000, 'Old', 'From Device', 'Alb'], [now + 8800, 'D', 'Four', 'Alb'], [now - 100, 'B', 'Two', 'Alb', 1], ['bad']] } });
body = await res.json();
const fresh = (await (await call('/plays?channel=christmas&since=2000')).json()).plays;
check('a device\'s plays: new ones stored, a gap a device recorded through is cleared, a device\'s gap never added to a stored play',
  res.status === 200 && body.received === 3 && body.changed === 2 && env.DB.raw.prepare("SELECT gap FROM plays WHERE title = 'Four'").get().gap === 0
  && env.DB.raw.prepare("SELECT gap FROM plays WHERE title = 'Two'").get().gap === 0, JSON.stringify(body));
check('since: only rows stored or changed after it, including old plays sent late', before.length === 0 && titles(fresh) === 'Four,From Device', titles(fresh));
res = await call('/plays?channel=christmas', { method: 'POST', body: { plays: Array.from({ length: 501 }, (_, i) => [now - i, 'X', 'Y' + i]) } });
check('at most 500 plays at a time', res.status === 413);
check('a body that isn\'t JSON is refused', (await call('/plays?channel=christmas', { method: 'POST', body: '{nope' })).status === 400);

// 3.22: the synced document, replaced only by a device that saw the current version
res = await call('/state');
body = await res.json();
check('before the first save: version 0, no document', res.status === 200 && body.version === 0 && body.state === null);
res = await call('/state', { method: 'PUT', body: { base: 0, state: { marks: { a: { v: 'have', at: 1 } } } } });
body = await res.json();
check('the first save makes version 1', res.status === 200 && body.version === 1);
res = await call('/state', { method: 'PUT', body: { base: 0, state: { marks: {} } } });
body = await res.json();
check('a save from an older version is refused with the current document', res.status === 409 && body.version === 1 && body.state.marks.a.v === 'have');
res = await call('/state', { method: 'PUT', body: { base: 1, state: { marks: { a: { v: 'not', at: 2 } } } } });
const got = await (await call('/state')).json();
check('a save from the current version replaces it', res.status === 200 && got.version === 2 && got.state.marks.a.v === 'not' && got.updated > 0);
check('a save that isn\'t { base, state } is refused', (await call('/state', { method: 'PUT', body: { state: 'x' } })).status === 400);
check('the document needs the key too', (await call('/state', { key: null })).status === 401);

// The 3.21 database brought up to date keeps its plays and can be asked by "since"
const old = fakeD1('./test-schema-3.21.sql');
old.raw.exec("INSERT INTO plays (channel, at, artist, title, album, gap) VALUES ('christmas', 500, 'A', 'One', '', 0)");
old.raw.exec(fs.readFileSync(new URL('./migrate-3.22.sql', import.meta.url), 'utf8'));
check('migrate-3.22.sql: old plays kept, stored time set to their play time, synced document table added',
  old.raw.prepare('SELECT added FROM plays').get().added === 500 && old.raw.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name = 'docs'").get().n === 1);

// The Christmas Lounge site's /api: only behind Cloudflare Access, with a token signed by the team's key
const TEAM = 'lounge', AUD = 'aud-123';
const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = Object.assign(await crypto.subtle.exportKey('jwk', pair.publicKey), { kid: 'k1' });
const b64u = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function jwt(claims, key = pair.privateKey, kid = 'k1') {
  const head = b64u(JSON.stringify({ alg: 'RS256', kid })), body = b64u(JSON.stringify(claims));
  return head + '.' + body + '.' + b64u(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(head + '.' + body)));
}
const nowSec = Math.floor(Date.now() / 1000);
const good = await jwt({ aud: [AUD], iss: 'https://lounge.cloudflareaccess.com', exp: nowSec + 600, email: 'dan@example.com' });
const outside = [];
const youtube = { items: [] };
const siteFetch = async (u) => {
  u = String(u); outside.push(u);
  if (u === 'https://lounge.cloudflareaccess.com/cdn-cgi/access/certs') return new Response(JSON.stringify({ keys: [jwk] }));
  if (u.startsWith('https://somafm.com/songs/christmas.json')) return new Response(JSON.stringify({ songs: feed([[now + 30000, 'Site', 'Through The Site']]) }), { headers: { Date: new Date((now + 30050) * 1000).toUTCString() } });
  if (u.includes('/youtube/v3/playlistItems')) {
    const page = new URL(u).searchParams.get('pageToken') ? 2 : 1;
    const it = (id, title, ch, privacy = 'public', description = '') => ({ snippet: { title, videoOwnerChannelTitle: ch, description }, contentDetails: { videoId: id }, status: { privacyStatus: privacy } });
    return new Response(JSON.stringify(page === 1
      ? { pageInfo: { totalResults: 5 }, nextPageToken: 'p2', items: [it('v1', 'Song One', 'Artist - Topic'), it('v2', 'Private video', '', 'private'), it('v3', 'Blocked Song', 'B')] }
      : { pageInfo: { totalResults: 5 }, items: [it('v4', 'The Holly And The Ivy', 'Billy Paul - Topic', 'public', 'Provided to YouTube by Kriztal Entertainment Group, Inc.\n\nThe Holly And The Ivy · Billy Paul Williams\n\nThe Reindeer Room II'), it('v5', 'Deleted video', '')] }));
  }
  if (u.includes('/youtube/v3/videos')) return new Response(JSON.stringify({ items: [
    { id: 'v1', contentDetails: { duration: 'PT3M25S' } }, { id: 'v3', contentDetails: { duration: 'PT2M', regionRestriction: { blocked: ['US', 'DE'] } } },
    { id: 'v4', contentDetails: { duration: 'PT1H1S', regionRestriction: { blocked: ['DE'] } } }] }));
  return new Response('{}', { status: 404 });
};
const siteEnv = { DB: fakeD1(), CHANNELS: 'christmas', ACCESS_TEAM: TEAM, ACCESS_AUD: AUD, YT_KEY: 'yt-key', GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', ALLOW_ORIGIN: 'https://xmaslounge.pages.dev' };
const site = (path, opts = {}) => siteApi(new Request('https://xmaslounge.pages.dev/api' + path, { method: opts.method || 'GET',
  headers: opts.token === null ? {} : { 'Cf-Access-Jwt-Assertion': opts.token || good }, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }), opts.env || siteEnv, siteFetch);
check('site: no Access token, refused', (await site('/config', { token: null })).status === 401);
check('site: a token for another application, refused', (await site('/config', { token: await jwt({ aud: ['other'], iss: 'https://lounge.cloudflareaccess.com', exp: nowSec + 600 }) })).status === 401);
check('site: an expired token, refused', (await site('/config', { token: await jwt({ aud: [AUD], iss: 'https://lounge.cloudflareaccess.com', exp: nowSec - 5 }) })).status === 401);
const otherPair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
check('site: a token signed by some other key, refused', (await site('/config', { token: await jwt({ aud: [AUD], iss: 'https://lounge.cloudflareaccess.com', exp: nowSec + 600 }, otherPair.privateKey) })).status === 401);
check('site: Access not set up on the site, so nothing is let through', (await site('/config', { env: Object.assign({}, siteEnv, { ACCESS_AUD: '' }) })).status === 401);
forgetAccessKeys();
check('accessEmail: the signed-in email', await accessEmail(new Request('https://x/', { headers: { Cookie: 'a=1; CF_Authorization=' + good } }), siteEnv, siteFetch) === 'dan@example.com');
res = await site('/config');
check('site: signed in, the built-in Client ID', res.status === 200 && (await res.json()).clientId === 'cid.apps.googleusercontent.com');
res = await site('/feed?channel=christmas');
body = await res.json();
check('site: SomaFM\'s list read now, and its plays recorded on the way through', res.status === 200 && body.songs[0].title === 'Through The Site'
  && siteEnv.DB.raw.prepare("SELECT COUNT(*) n FROM plays WHERE title = 'Through The Site'").get().n === 1 && siteEnv.DB.raw.prepare('SELECT ok FROM runs').get().ok === 1);
check('site: only recorded stations', (await site('/feed?channel=groovesalad')).status === 400);
res = await site('/playlist?list=PLRpb0eQM5sYC0-Fhol0BnOwYygZy_UTyt');
body = await res.json();
check('site: the playlist through YouTube\'s API, every page; private, deleted and US-blocked videos counted as hidden',
  res.status === 200 && body.items.map(i => i.id).join() === 'v1,v4' && body.items[0].ch === 'Artist - Topic' && body.items[1].ch === 'Billy Paul Williams' && body.items[0].secs === 205 && body.items[1].secs === 3601
  && body.hidden === 3 && body.complete && body.read === 5 && body.expected === 2 && outside.some(u => /key=yt-key/.test(u)), JSON.stringify(body));
check('site: no YouTube key set up says so', (await site('/playlist?list=PLRpb0eQM5sYC0-Fhol0BnOwYygZy_UTyt', { env: Object.assign({}, siteEnv, { YT_KEY: '' }) })).status === 503);
check('site: a bad playlist id is refused', (await site('/playlist?list=../x')).status === 400);
res = await site('/state', { method: 'PUT', body: { base: 0, state: { marks: {} } } });
check('site: the synced document and plays, without the recorder key', res.status === 200 && (await (await site('/state')).json()).version === 1
  && (await (await site('/plays?channel=christmas&since=0')).json()).plays.length === 1);
// The new site (site/app) sends each change on its own, merged into the one document here
const chEnv = Object.assign({}, siteEnv, { DB: fakeD1() });
const ch = patch => site('/change', { method: 'POST', body: { patch }, env: chEnv });
res = await ch({ marks: { 'a|one': { v: 'have', at: 100, id: 'v1' } }, favorites: { v1: { on: true, at: 100 } } });
body = await res.json();
check('change: the first one makes the document', res.status === 200 && body.version === 1 && body.changed && body.state.marks['a|one'].id === 'v1' && body.state.favorites.v1.on, JSON.stringify(body));
// Today's site saves its own merge in between, from version 1
await site('/state', { method: 'PUT', env: chEnv, body: { base: 1, state: Object.assign({}, body.state, { notes: { 'b|two': { t: 'from the old site', at: 150 } } }) } });
res = await ch({ notes: { 'a|one': { t: 'hello', at: 200 } } });
body = await res.json();
check('change: merged into what another device saved, nothing of theirs lost', res.status === 200 && body.version === 3 && body.state.notes['a|one'].t === 'hello'
  && body.state.notes['b|two'].t === 'from the old site' && body.state.marks['a|one'].v === 'have', JSON.stringify(body));
res = await ch({ removed: { marks: { 'a|one': 300 } } });
body = await res.json();
check('change: a cleared mark is removed and remembered as removed, so a device merging later doesn\'t bring it back',
  !('a|one' in body.state.marks) && body.state.removed.marks['a|one'] === 300);
res = await ch({ marks: { 'a|one': { v: 'have', at: 250 } } });
body = await res.json();
check('change: an older change than the removal doesn\'t bring it back; the same document is kept', body.changed === false && body.version === 4 && !('a|one' in body.state.marks));
res = await ch({ favorites: { v1: { on: false, at: 50 } }, categories: { v1: { c: 'jazz', at: 400 } } });
body = await res.json();
check('change: newer wins key by key', body.state.favorites.v1.on === true && body.state.categories.v1.c === 'jazz');
const oldSite = await (await site('/state', { env: chEnv })).json();
check('change: today\'s site reads the same document and version', oldSite.version === body.version && oldSite.state.categories.v1.c === 'jazz' && oldSite.state.notes['b|two'].t === 'from the old site');
check('change: anything but { patch } is refused', (await site('/change', { method: 'POST', body: { marks: {} }, env: chEnv })).status === 400);
check('change: needs the Access sign-in', (await site('/change', { method: 'POST', body: { patch: {} }, env: chEnv, token: null })).status === 401);
// The playlist read is kept, so pages opened soon after don't spend quota units again
const reads = () => outside.filter(u => u.includes('/youtube/v3/playlistItems')).length;
const r0 = reads();
const p1 = await (await site('/playlist?list=PLRpb0eQM5sYC0-Fhol0BnOwYygZy_UTyt&within=900', { env: chEnv })).json();
const p2 = await (await site('/playlist?list=PLRpb0eQM5sYC0-Fhol0BnOwYygZy_UTyt&within=900', { env: chEnv })).json();
const p3 = await (await site('/playlist?list=PLRpb0eQM5sYC0-Fhol0BnOwYygZy_UTyt', { env: chEnv })).json();
check('playlist: within gives the kept read while it\'s recent, without asking YouTube; without it, a fresh read',
  reads() - r0 === 4 && !p1.cached && p2.cached && p2.items.length === 2 && p2.at === p1.at - p1.at % 1000 && !p3.cached && p3.at > 0, JSON.stringify({ n: reads() - r0, p1: p1.at, p2: p2.at }));

// Nov 4: Shuffle's Google sign-in kept on the server (ytauth.js), against a stand-in for Google's token endpoint
{
  const google = { calls: [], refresh: 'rt-1', revoked: [] };
  const gFetch = async (u, opts) => {
    u = String(u);
    if (u === 'https://oauth2.googleapis.com/token') {
      const p = new URLSearchParams(opts.body); google.calls.push(Object.fromEntries(p));
      if (p.get('client_secret') !== 'GOCSPX-secret') return new Response(JSON.stringify({ error: 'invalid_client' }), { status: 401 });
      if (p.get('grant_type') === 'authorization_code') return p.get('code') === 'good-code' && p.get('redirect_uri') === 'https://xmaslounge.pages.dev/'
        ? new Response(JSON.stringify({ access_token: 'at-1', expires_in: 3599, refresh_token: google.refresh })) : new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Bad code' }), { status: 400 });
      if (p.get('grant_type') === 'refresh_token') return p.get('refresh_token') === google.refresh && !google.revoked.includes(google.refresh)
        ? new Response(JSON.stringify({ access_token: 'at-2', expires_in: 3599 })) : new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }), { status: 400 });
    }
    if (u === 'https://oauth2.googleapis.com/revoke') { google.revoked.push(new URLSearchParams(opts.body).get('token')); return new Response('{}'); }
    return siteFetch(u, opts);
  };
  const yEnv = Object.assign({}, siteEnv, { DB: fakeD1(), GOOGLE_CLIENT_SECRET: 'GOCSPX-secret' });
  const y = (path, opts = {}) => siteApi(new Request('https://xmaslounge.pages.dev/api' + path, { method: opts.method || 'POST',
    headers: opts.token === null ? {} : { 'Cf-Access-Jwt-Assertion': good }, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }), opts.env || yEnv, gFetch);
  const cfg = await (await y('/config', { method: 'GET' })).json();
  check('youtube: /config says the sign-in can be kept (secret set), and not without it', cfg.keepsSignIn === true && (await (await site('/config')).json()).keepsSignIn === false);
  res = await y('/youtube/token');
  check('youtube: no sign-in kept yet: 409, so the page asks you to sign in', res.status === 409 && (await res.json()).connected === false);
  res = await y('/youtube/connect', { body: { code: 'good-code' } });
  body = await res.json();
  const stored = yEnv.DB.raw.prepare("SELECT body FROM docs WHERE name = 'youtube:auth'").get();
  check('youtube: connect exchanges the code (to this site\'s own /) and keeps the permission, encrypted', res.status === 200 && body.access_token === 'at-1' && body.kept
    && google.calls[0].redirect_uri === 'https://xmaslounge.pages.dev/' && stored && !stored.body.includes('rt-1') && JSON.parse(stored.body).by === 'dan@example.com', JSON.stringify({ body, stored }));
  res = await y('/youtube/token');
  body = await res.json();
  check('youtube: a fresh key from the kept permission, without signing in', res.status === 200 && body.access_token === 'at-2' && body.expires_in === 3599 && google.calls.pop().refresh_token === 'rt-1');
  check('youtube: needs the Access sign-in', (await y('/youtube/token', { token: null })).status === 401);
  check('youtube: GET refused (POST only)', (await y('/youtube/token', { method: 'GET' })).status === 405);
  check('youtube: a bad code is refused and nothing new kept', (await y('/youtube/connect', { body: { code: 'bad' } })).status === 502 && (await y('/youtube/token')).status === 200);
  check('youtube: without the client secret set, says so', (await y('/youtube/token', { env: Object.assign({}, yEnv, { GOOGLE_CLIENT_SECRET: '' }) })).status === 503);
  check('youtube: kept with another secret reads as not signed in (and Google is not asked)', (await y('/youtube/token', { env: Object.assign({}, yEnv, { GOOGLE_CLIENT_SECRET: 'GOCSPX-other' }) })).status === 409);
  google.revoked.push('rt-1');   // revoked in the Google account
  res = await y('/youtube/token');
  check('youtube: revoked at Google: forgotten, 409, sign in again', res.status === 409 && !yEnv.DB.raw.prepare("SELECT 1 FROM docs WHERE name = 'youtube:auth'").get());
  google.revoked = []; google.refresh = 'rt-2';
  await y('/youtube/connect', { body: { code: 'good-code' } });
  res = await y('/youtube/disconnect');
  body = await res.json();
  check('youtube: disconnect revokes it at Google and forgets it', res.status === 200 && body.revoked && google.revoked.includes('rt-2') && (await y('/youtube/token')).status === 409);
}

// Nov 1: the API's "Billy Paul - Topic" kept two Billy Paul Williams songs from matching on the site
check('credited artists from an auto-generated video\'s description, else nothing', creditedArtists('Provided to YouTube by X\n\nChristmas Eve · Members Only\n\nAlbum') === 'Members Only'
  && creditedArtists('Provided to YouTube by X\n\nSong · A · B\n\nAlbum') === 'A, B' && creditedArtists('My own upload') === '' && creditedArtists('') === '');
check('isoSeconds', isoSeconds('PT4M5S') === 245 && isoSeconds('PT1H') === 3600 && isoSeconds('P1DT1S') === 86401 && isoSeconds('') === 0);

console.log(fail ? `${fail} failed` : 'all passed');
process.exit(fail ? 1 : 0);
