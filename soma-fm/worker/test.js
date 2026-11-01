// Tests for the recorder, against a real SQLite database (node:sqlite) behind a stand-in for Cloudflare's D1
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fromFeed } from './src/core.js';
import worker, { record, handle } from './src/index.js';

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

console.log(fail ? `${fail} failed` : 'all passed');
process.exit(fail ? 1 : 0);
