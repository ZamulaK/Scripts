// Tests for the recorder, against a real SQLite database (node:sqlite) behind a stand-in for Cloudflare's D1
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fromFeed } from './src/core.js';
import worker, { record, handle } from './src/index.js';

let fail = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : '  — ' + detail}`); if (!ok) fail++; };

function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) || null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => db.prepare(sql).run(...args),
  });
  return { prepare: sql => stmt(sql), batch: async list => { for (const s of list) await s.run(); }, raw: db };
}
const feed = rows => rows.map(([date, artist, title]) => ({ date: String(date), artist, title, album: 'Alb' }));
const somaFM = (rows, nowS, status = 200) => async () => new Response(JSON.stringify({ id: 'christmas', songs: feed(rows) }),
  { status, headers: { 'Content-Type': 'application/json', Date: new Date(nowS * 1000).toUTCString() } });

const KEY = 'k'.repeat(32);
const env = { DB: fakeD1(), KEY, CHANNELS: 'christmas', ALLOW_ORIGIN: 'https://somafm.com' };
const get = (path, key = KEY, method = 'GET') => handle(new Request('https://rec.example' + path, { method, headers: key ? { Authorization: 'Bearer ' + key } : {} }), env);

// core
const now = 1793500000;
const first = fromFeed(feed([[now - 100, 'B', 'Two'], [now - 200, 'SomaFM', 'Station ID'], [now - 400, 'A', 'One']]), now, null);
check('first look: every play, no gap; station IDs become breaks', first.plays.length === 2 && first.plays[0][2] === 'Two' && !first.plays[1][4] && first.breaks.join() === String(now - 200));
const next = fromFeed(feed([[now + 200, 'C', 'Three'], [now - 100, 'B', 'Two'], [now - 400, 'A', 'One']]), now + 250, [now - 100, 'B', 'Two', 'Alb']);
check('next look: only newer plays', next.plays.length === 1 && next.plays[0][2] === 'Three' && !next.plays[0][4]);
const late = fromFeed(feed([[now + 9000, 'E', 'Five'], [now + 8800, 'D', 'Four']]), now + 9100, [now - 100, 'B', 'Two', 'Alb']);
check('after missing a stretch: the oldest new play is flagged after a gap', late.plays.length === 2 && late.plays[1][4] === 1 && !late.plays[0][4]);

// record (the 10-minute job)
let r = await record(env, 'christmas', somaFM([[now - 100, 'B', 'Two'], [now - 200, 'SomaFM', 'Station ID'], [now - 400, 'A', 'One']], now));
r = await record(env, 'christmas', somaFM([[now + 200, 'C', 'Three'], [now - 100, 'B', 'Two'], [now - 400, 'A', 'One']], now + 250));
const rows = env.DB.raw.prepare('SELECT at, title, gap FROM plays ORDER BY at DESC').all();
check('two looks keep each play once, newest first', r.ok && r.added === 1 && rows.map(x => x.title).join() === 'Three,Two,One' && rows.every(x => !x.gap), JSON.stringify(rows));
r = await record(env, 'christmas', somaFM([[now + 200, 'C', 'Three']], now + 300));
check('the same list again adds nothing', r.ok && r.added === 0 && env.DB.raw.prepare('SELECT COUNT(*) n FROM plays').get().n === 3);
r = await record(env, 'christmas', somaFM([[now + 9000, 'E', 'Five'], [now + 8800, 'D', 'Four']], now + 9100));
check('a missed stretch is flagged on the first play after it', env.DB.raw.prepare("SELECT gap FROM plays WHERE title = 'Four'").get().gap === 1);
r = await record(env, 'christmas', somaFM([], now + 9200, 503));
const run = env.DB.raw.prepare('SELECT * FROM runs').get();
check('a failed look is noted, keeping when the last good one was', !r.ok && run.ok === 0 && /503/.test(run.note) && run.last_ok === now + 9100, JSON.stringify(run));
const dayAhead = await record(env, 'christmas', somaFM([[now + 9300 + 86400, 'F', 'Misdated']], now + 9400));
check('a play SomaFM dates a day ahead is recorded at the right time', dayAhead.ok && env.DB.raw.prepare("SELECT at FROM plays WHERE title = 'Misdated'").get().at === now + 9300);

// the scheduled entry point records every listed station
const jobs = [];
const realFetch = globalThis.fetch;
globalThis.fetch = somaFM([[now + 9600, 'G', 'Six']], now + 9700);
await worker.scheduled({}, env, { waitUntil: p => jobs.push(p) });
await Promise.all(jobs);
globalThis.fetch = realFetch;
check('the 10-minute job records each station listed', jobs.length === 1 && env.DB.raw.prepare("SELECT COUNT(*) n FROM plays WHERE title = 'Six'").get().n === 1);

// reading it back
let res = await get('/plays?channel=christmas&since=0', null);
check('no key: refused', res.status === 401 && res.headers.get('Access-Control-Allow-Origin') === 'https://somafm.com');
res = await get('/plays?channel=christmas&since=0', 'x'.repeat(32));
check('wrong key: refused', res.status === 401);
res = await get('/plays?channel=christmas', KEY, 'OPTIONS');
check('the browser\'s preflight is answered for somafm.com', res.status === 204 && /Authorization/.test(res.headers.get('Access-Control-Allow-Headers')));
res = await get('/plays?channel=christmas&since=0');
let body = await res.json();
check('with the key: every play newest first, gap flags, breaks, and how the last look went',
  res.status === 200 && body.plays.length === 7 && body.plays[0][2] === 'Six' && body.plays.find(p => p[2] === 'Four')[4] === 1 && body.plays.find(p => p[2] === 'Two').length === 4
  && body.breaks.length === 1 && body.lastRun.ok && body.recording && res.headers.get('Cache-Control') === 'no-store', JSON.stringify(body).slice(0, 300));
body = await (await get(`/plays?channel=christmas&since=${now + 8800}`)).json();
check('since: only plays from then on', body.plays.length === 4 && body.plays[body.plays.length - 1][2] === 'Four', body.plays.map(p => p[2]).join());
check('another station: nothing recorded, and it says so', (await (await get('/plays?channel=groovesalad')).json()).recording === false);
check('a bad station name is refused', (await get('/plays?channel=../x')).status === 400);
check('a weak key on the server refuses everything', (await handle(new Request('https://rec.example/plays', { headers: { Authorization: 'Bearer short' } }), Object.assign({}, env, { KEY: 'short' }))).status === 401);

console.log(fail ? `${fail} failed` : 'all passed');
process.exit(fail ? 1 : 0);
