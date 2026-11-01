// The Christmas Lounge site's /api (soma-fm/site, xmaslounge.pages.dev, a Cloudflare Pages Function). It answers
// only requests Cloudflare Access let through (accessEmail), and serves the same data as the recorder:
//   GET  /api/config               what the page needs built in (the Google Client ID for Shuffle)
//   GET  /api/feed?channel=        SomaFM's song list, read now; the plays in it are recorded on the way through
//   GET  /api/playlist?list=       the YouTube playlist, read with YouTube's API (youtube.js)
//   GET/POST /api/plays, GET/PUT /api/state   as on the recorder (index.js)
// The recorder Worker keeps its 10-minute look and its key-protected endpoints for the userscript.
import { plays, state, record, json, UA } from './index.js';
import { validChannel } from './core.js';
import { accessEmail } from './access.js';
import { readPlaylist } from './youtube.js';

const channels = env => String(env.CHANNELS || 'christmas').split(',').map(s => s.trim()).filter(validChannel);

export async function siteApi(req, env, fetchFn = fetch) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api/, '') || '/';
  if (!await accessEmail(req, env, fetchFn)) return json(env, { error: 'sign in through Cloudflare Access (reload the page)' }, 401);
  try {
    if (path === '/config' && req.method === 'GET') return json(env, { clientId: String(env.GOOGLE_CLIENT_ID || '') });
    if (path === '/plays' && (req.method === 'GET' || req.method === 'POST')) return await plays(req, env, url);
    if (path === '/state' && (req.method === 'GET' || req.method === 'PUT')) return await state(req, env);
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
      return json(env, await readPlaylist(list, env.YT_KEY, fetchFn));
    }
    return json(env, { error: 'not found' }, 404);
  } catch (e) {
    return json(env, { error: e.message || String(e) }, e.status || 500);
  }
}
