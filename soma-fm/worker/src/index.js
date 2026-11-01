// SomaFM recorder: a Cloudflare Worker that looks at SomaFM's song list every 10 minutes (the list covers
// about the last hour) and keeps every play in a D1 database, so the userscript can fill in the stretches
// when no device had the page open. Devices also send the plays they recorded (3.22), and keep their marks,
// favorites, categories, notes and the rest in one synced document here. The playlist matching stays on the
// devices: YouTube hides region-blocked songs outside the US, and Cloudflare may run this anywhere.
import { fromFeed, cleanPlays, validChannel } from './core.js';

const UA = 'soma-recorder (personal play history for one listener)';
const MAX_ROWS = 50000, MAX_PUSH = 500, MAX_DOC = 1500000;
const nowSec = () => Math.floor(Date.now() / 1000);

const channels = env => String(env.CHANNELS || 'christmas').split(',').map(s => s.trim()).filter(validChannel);

// Stores plays; a play already stored loses its gap flag when the new copy has none (someone was recording
// before it), and is then marked changed so devices pick that up. Returns how many rows were added or changed.
const UPSERT = 'INSERT INTO plays (channel, at, artist, title, album, gap, added) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
  'ON CONFLICT (channel, at, artist, title) DO UPDATE SET gap = 0, added = excluded.added WHERE plays.gap = 1 AND excluded.gap = 0';
function upserts(env, channel, plays, added) {
  const out = [];
  for (const p of plays) out.push(env.DB.prepare(UPSERT).bind(channel, p[0], p[1], p[2], p[3] || '', p[4] ? 1 : 0, added));
  return out;
}
const changes = results => { let n = 0; for (const r of results || []) n += (r && r.meta && r.meta.changes) || 0; return n; };

// One look at a station's list. A failure is noted in runs (shown in the userscript), not thrown.
export async function record(env, channel, fetchFn = fetch) {
  let nowS = Date.now() / 1000;
  try {
    const r = await fetchFn(`https://somafm.com/songs/${channel}.json`, { headers: { 'User-Agent': UA }, cf: { cacheTtl: 0 } });
    if (!r.ok) throw new Error('SomaFM returned ' + r.status);
    const served = Date.parse(r.headers.get('Date') || '');
    if (isFinite(served)) nowS = served / 1000;
    const data = await r.json();
    const row = await env.DB.prepare('SELECT at, artist, title, album FROM plays WHERE channel = ? ORDER BY at DESC LIMIT 1').bind(channel).first();
    const { plays, breaks } = fromFeed(data && data.songs, nowS, row ? [row.at, row.artist, row.title, row.album] : null);
    const stmts = upserts(env, channel, plays, nowSec());
    for (const b of breaks) stmts.push(env.DB.prepare('INSERT OR IGNORE INTO breaks (channel, at) VALUES (?, ?)').bind(channel, b));
    const at = Math.round(nowS);
    stmts.push(env.DB.prepare('INSERT OR REPLACE INTO runs (channel, at, ok, added, note, last_ok) VALUES (?, ?, 1, ?, \'\', ?)').bind(channel, at, plays.length, at));
    await env.DB.batch(stmts);
    return { ok: true, added: plays.length };
  } catch (e) {
    const note = String(e && e.message || e).slice(0, 300);
    await env.DB.prepare('INSERT INTO runs (channel, at, ok, added, note, last_ok) VALUES (?, ?, 0, 0, ?, 0) ON CONFLICT(channel) DO UPDATE SET at = excluded.at, ok = 0, added = 0, note = excluded.note')
      .bind(channel, Math.round(nowS), note).run();
    return { ok: false, note };
  }
}

function cors(env) {
  return { 'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || 'https://somafm.com', 'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS', 'Access-Control-Max-Age': '86400', Vary: 'Origin' };
}
const json = (env, body, status = 200) => new Response(JSON.stringify(body), { status, headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, cors(env)) });

// The key is set with `wrangler secret put KEY`; requests send it as "Authorization: Bearer <key>"
function authorized(req, env) {
  const want = String(env.KEY || ''), got = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (want.length < 16 || got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}
async function body(req, max) {
  const text = await req.text();
  if (text.length > max) throw Object.assign(new Error('too large'), { status: 413 });
  try { return JSON.parse(text); } catch (e) { throw Object.assign(new Error('not JSON'), { status: 400 }); }
}
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

// GET: plays stored or changed since a time, newest first. POST: plays a device recorded.
async function plays(req, env, url) {
  const channel = url.searchParams.get('channel') || 'christmas';
  if (!validChannel(channel)) return json(env, { error: 'bad channel' }, 400);
  if (req.method === 'POST') {
    const b = await body(req, 400000);
    const list = cleanPlays(isObj(b) ? b.plays : null);
    if (list.length > MAX_PUSH) return json(env, { error: `at most ${MAX_PUSH} plays at a time` }, 413);
    const res = list.length ? await env.DB.batch(upserts(env, channel, list, nowSec())) : [];
    return json(env, { received: list.length, changed: changes(res) });
  }
  const since = Math.max(0, Math.floor(Number(url.searchParams.get('since')) || 0));
  const [p, b, run] = await env.DB.batch([
    env.DB.prepare('SELECT at, artist, title, album, gap FROM plays WHERE channel = ? AND added >= ? ORDER BY at DESC LIMIT ?').bind(channel, since, MAX_ROWS),
    env.DB.prepare('SELECT at FROM breaks WHERE channel = ? AND at >= ? ORDER BY at DESC LIMIT ?').bind(channel, Math.max(0, since - 86400), MAX_ROWS),
    env.DB.prepare('SELECT at, ok, added, note, last_ok FROM runs WHERE channel = ?').bind(channel),
  ]);
  const out = [];
  for (const r of p.results || []) out.push(r.gap ? [r.at, r.artist, r.title, r.album, 1] : [r.at, r.artist, r.title, r.album]);
  const breaks = [];
  for (const r of b.results || []) breaks.push(r.at);
  const rr = (run.results || [])[0];
  return json(env, { channel, now: nowSec(), recording: channels(env).indexOf(channel) >= 0,
    lastRun: rr ? { at: rr.at, ok: !!rr.ok, added: rr.added, note: rr.note, lastOk: rr.last_ok } : null, plays: out, breaks });
}

// GET: the synced document and its version (0 and null before the first save). PUT { base, state }: replaces
// it only when base is the current version; otherwise 409 with the current one, to merge and try again.
async function state(req, env) {
  const row = await env.DB.prepare('SELECT version, body, updated FROM docs WHERE name = ?').bind('state').first();
  const version = row ? row.version : 0;
  if (req.method === 'GET') return json(env, { version, updated: row ? row.updated : 0, state: row ? JSON.parse(row.body) : null });
  const b = await body(req, MAX_DOC);
  if (!isObj(b) || !isObj(b.state) || typeof b.base !== 'number') return json(env, { error: 'expected { base, state }' }, 400);
  if (b.base !== version) return json(env, { error: 'changed since', version, state: row ? JSON.parse(row.body) : null }, 409);
  const text = JSON.stringify(b.state), at = nowSec();
  // The version check is repeated in the write itself, in case another device saved in between
  const res = version
    ? await env.DB.prepare('UPDATE docs SET version = ?, body = ?, updated = ? WHERE name = ? AND version = ?').bind(version + 1, text, at, 'state', version).run()
    : await env.DB.prepare('INSERT OR IGNORE INTO docs (name, version, body, updated) VALUES (?, 1, ?, ?)').bind('state', text, at).run();
  if (!res.meta || !res.meta.changes) return state(new Request(req.url, { method: 'GET' }), env).then(async r => json(env, Object.assign({ error: 'changed since' }, await r.json()), 409));
  return json(env, { version: version + 1, updated: at });
}

export async function handle(req, env) {
  const url = new URL(req.url);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });
  if (url.pathname === '/') return new Response('SomaFM recorder\n', { headers: { 'Content-Type': 'text/plain' } });
  const route = url.pathname === '/plays' && (req.method === 'GET' || req.method === 'POST') ? plays
    : url.pathname === '/state' && (req.method === 'GET' || req.method === 'PUT') ? state : null;
  if (!route) return json(env, { error: 'not found' }, 404);
  if (!authorized(req, env)) return json(env, { error: 'wrong or missing key' }, 401);
  try { return await route(req, env, url); }
  catch (e) { return json(env, { error: e.message || String(e) }, e.status || 500); }
}

export default {
  async scheduled(event, env, ctx) {
    for (const ch of channels(env)) ctx.waitUntil(record(env, ch));
  },
  fetch: handle,
};
