// The Christmas Lounge site's /api (soma-fm/site, xmaslounge.pages.dev, a Cloudflare Pages Function). It answers
// only requests Cloudflare Access let through (accessEmail), and serves the same data as the recorder:
//   GET  /api/config               what the page needs built in (the Google Client ID for Shuffle)
//   GET  /api/feed?channel=        SomaFM's song list, read now; the plays in it are recorded on the way through
//   GET  /api/playlist?list=       the YouTube playlist, read with YouTube's API (youtube.js); with &within=secs, the
//                                  last read when it's newer than that (each read costs quota units Shuffle shares)
//   GET/POST /api/plays, GET/PUT /api/state   as on the recorder (index.js)
//   POST /api/change { patch }     the new site (site/app): one change (a mark, a favorite, a note…) merged into the
//                                  synced document here with the same rules a device merges with, so the database
//                                  stays the one copy and today's site still reads the same document
// The recorder Worker keeps its 10-minute look and its key-protected endpoints for the userscript.
import { plays, state, record, json, body, UA } from './index.js';
import { validChannel, Sync } from './core.js';
import { accessEmail } from './access.js';
import { readPlaylist } from './youtube.js';

const channels = env => String(env.CHANNELS || 'christmas').split(',').map(s => s.trim()).filter(validChannel);
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const nowSec = () => Math.floor(Date.now() / 1000);
const MAX_DOC = 1500000;

// Merges a partial document into the stored one; saved only over the version just read, else read again (another
// device or tab saved in between). Answers with the whole document as saved, so the page shows what's really kept.
export async function change(req, env) {
  const b = await body(req, MAX_DOC);
  if (!isObj(b) || !isObj(b.patch)) return json(env, { error: 'expected { patch }' }, 400);
  const patch = Sync.clean(b.patch);
  for (let tries = 0; tries < 5; tries++) {
    const row = await env.DB.prepare('SELECT version, body FROM docs WHERE name = ?').bind('state').first();
    const version = row ? row.version : 0;
    const cur = Sync.clean(row ? JSON.parse(row.body) : null);
    const merged = Sync.merge(cur, patch);
    if (row && Sync.same(merged, cur)) return json(env, { version, state: cur, changed: false });
    const text = JSON.stringify(merged);
    if (text.length > MAX_DOC) return json(env, { error: 'the document would be too large' }, 413);
    const res = version
      ? await env.DB.prepare('UPDATE docs SET version = ?, body = ?, updated = ? WHERE name = ? AND version = ?').bind(version + 1, text, nowSec(), 'state', version).run()
      : await env.DB.prepare('INSERT OR IGNORE INTO docs (name, version, body, updated) VALUES (?, 1, ?, ?)').bind('state', text, nowSec()).run();
    if (res.meta && res.meta.changes) return json(env, { version: version + 1, state: merged, changed: true });
  }
  return json(env, { error: 'the document kept changing; try again' }, 409);
}

// The playlist, read now or (with within) the last read when it's recent enough. Every read is kept for that.
async function playlist(env, list, within, fetchFn) {
  const name = 'playlist:' + list;
  if (within > 0) {
    const row = await env.DB.prepare('SELECT body, updated FROM docs WHERE name = ?').bind(name).first();
    if (row && nowSec() - row.updated < within) return Object.assign(JSON.parse(row.body), { at: row.updated * 1000, cached: true });
  }
  const read = await readPlaylist(list, env.YT_KEY, fetchFn), at = nowSec();
  try {
    await env.DB.prepare('INSERT INTO docs (name, version, body, updated) VALUES (?, 1, ?, ?) ON CONFLICT (name) DO UPDATE SET version = docs.version + 1, body = excluded.body, updated = excluded.updated')
      .bind(name, JSON.stringify(read), at).run();
  } catch (e) { /* not kept this time; the read itself is fine */ }
  return Object.assign(read, { at: at * 1000 });
}

export async function siteApi(req, env, fetchFn = fetch) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api/, '') || '/';
  if (!await accessEmail(req, env, fetchFn)) return json(env, { error: 'sign in through Cloudflare Access (reload the page)' }, 401);
  try {
    if (path === '/config' && req.method === 'GET') return json(env, { clientId: String(env.GOOGLE_CLIENT_ID || '') });
    if (path === '/plays' && (req.method === 'GET' || req.method === 'POST')) return await plays(req, env, url);
    if (path === '/state' && (req.method === 'GET' || req.method === 'PUT')) return await state(req, env);
    if (path === '/change' && req.method === 'POST') return await change(req, env);
    if (path === '/feed' && req.method === 'GET') {
      const channel = url.searchParams.get('channel') || 'christmas';
      if (channels(env).indexOf(channel) < 0) return json(env, { error: 'not a recorded station' }, 400);
      const r = await fetchFn(`https://somafm.com/songs/${channel}.json`, { headers: { 'User-Agent': UA }, cf: { cacheTtl: 0 } });
      const text = await r.text(), served = r.headers.get('Date') || new Date().toUTCString();
      // Recorded as the 10-minute look would, so the plays are there even if this page never sends them
      if (r.ok) await record(env, channel, async () => new Response(text, { status: 200, headers: { Date: served } }));
      return new Response(r.ok ? text : JSON.stringify({ error: 'SomaFM answered ' + r.status }),
        { status: r.ok ? 200 : 502, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Date: served } });
    }
    if (path === '/playlist' && req.method === 'GET') {
      const list = url.searchParams.get('list') || '';
      if (!/^[\w-]{10,64}$/.test(list)) return json(env, { error: 'bad playlist id' }, 400);
      return json(env, await playlist(env, list, Math.max(0, Number(url.searchParams.get('within')) || 0), fetchFn));
    }
    return json(env, { error: 'not found' }, 404);
  } catch (e) {
    return json(env, { error: e.message || String(e) }, e.status || 500);
  }
}
