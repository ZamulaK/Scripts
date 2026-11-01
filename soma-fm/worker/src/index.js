// SomaFM recorder: a Cloudflare Worker that looks at SomaFM's song list every 10 minutes (the list covers
// about the last hour) and keeps every play in a D1 database, so the userscript can fill in the stretches
// when no device had the page open. The playlist matching stays on the devices: YouTube hides
// region-blocked songs outside the US, and Cloudflare may run this anywhere.
import { fromFeed, validChannel } from './core.js';

const UA = 'soma-recorder (personal play history for one listener)';
const MAX_ROWS = 50000;

const channels = env => String(env.CHANNELS || 'christmas').split(',').map(s => s.trim()).filter(validChannel);

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
    const stmts = [];
    for (const p of plays) stmts.push(env.DB.prepare('INSERT OR IGNORE INTO plays (channel, at, artist, title, album, gap) VALUES (?, ?, ?, ?, ?, ?)').bind(channel, p[0], p[1], p[2], p[3], p[4] ? 1 : 0));
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
  return { 'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || 'https://somafm.com', 'Access-Control-Allow-Headers': 'Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '86400', Vary: 'Origin' };
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

export async function handle(req, env) {
  const url = new URL(req.url);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });
  if (url.pathname === '/') return new Response('SomaFM recorder\n', { headers: { 'Content-Type': 'text/plain' } });
  if (url.pathname !== '/plays' || req.method !== 'GET') return json(env, { error: 'not found' }, 404);
  if (!authorized(req, env)) return json(env, { error: 'wrong or missing key' }, 401);
  const channel = url.searchParams.get('channel') || 'christmas';
  if (!validChannel(channel)) return json(env, { error: 'bad channel' }, 400);
  const since = Math.max(0, Math.floor(Number(url.searchParams.get('since')) || 0));
  const [p, b, run] = await Promise.all([
    env.DB.prepare('SELECT at, artist, title, album, gap FROM plays WHERE channel = ? AND at >= ? ORDER BY at DESC LIMIT ?').bind(channel, since, MAX_ROWS).all(),
    env.DB.prepare('SELECT at FROM breaks WHERE channel = ? AND at >= ? ORDER BY at DESC LIMIT ?').bind(channel, since, MAX_ROWS).all(),
    env.DB.prepare('SELECT at, ok, added, note, last_ok FROM runs WHERE channel = ?').bind(channel).first(),
  ]);
  const plays = [];
  for (const r of p.results || []) plays.push(r.gap ? [r.at, r.artist, r.title, r.album, 1] : [r.at, r.artist, r.title, r.album]);
  const breaks = [];
  for (const r of b.results || []) breaks.push(r.at);
  return json(env, { channel, now: Math.round(Date.now() / 1000), recording: channels(env).indexOf(channel) >= 0,
    lastRun: run ? { at: run.at, ok: !!run.ok, added: run.added, note: run.note, lastOk: run.last_ok } : null, plays, breaks });
}

export default {
  async scheduled(event, env, ctx) {
    for (const ch of channels(env)) ctx.waitUntil(record(env, ch));
  },
  fetch: handle,
};
