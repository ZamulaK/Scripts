// Shuffle's Google sign-in, kept on the server so it lasts (Dan, Nov 4, 2026). Google's one-hour sign-in (the key in the
// address) can't be made longer, so the site uses Google's other kind: the page gets a one-time code from Google's
// sign-in, this exchanges it (with the client secret, which never reaches the page) for a lasting permission (a refresh
// token), keeps that encrypted in D1, and hands the page a fresh one-hour key whenever it asks. Only requests
// Cloudflare Access let through get here (siteApi checks first).
//   POST /api/youtube/connect { code }   after Google's sign-in: keep the permission, answer with a key
//   POST /api/youtube/token              a fresh key; 409 when there's no permission kept (sign in)
//   POST /api/youtube/disconnect         ask Google to revoke it, and forget it
// The permission lasts until it's revoked (myaccount.google.com/permissions or Disconnect), or isn't used for six months.
// With the OAuth consent screen in "Testing", Google ends it after 7 days; Dan published the app ("In production").
import { json, body } from './index.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token', REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const ROW = 'youtube:auth';
const nowSec = () => Math.floor(Date.now() / 1000);
const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

// Encrypted with a key made from the client secret, so the database alone doesn't give the permission away (and a new
// secret simply means signing in again)
async function cryptKey(env) {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('xmaslounge youtube permission:' + env.GOOGLE_CLIENT_SECRET));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function keep(env, refresh, who) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await cryptKey(env), new TextEncoder().encode(refresh));
  const text = JSON.stringify({ iv: b64(iv), ct: b64(ct), by: who || '', at: Date.now() });
  await env.DB.prepare('INSERT INTO docs (name, version, body, updated) VALUES (?, 1, ?, ?) ON CONFLICT (name) DO UPDATE SET version = docs.version + 1, body = excluded.body, updated = excluded.updated')
    .bind(ROW, text, nowSec()).run();
}
async function kept(env) {
  const row = await env.DB.prepare('SELECT body FROM docs WHERE name = ?').bind(ROW).first();
  if (!row) return null;
  try {
    const d = JSON.parse(row.body);
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(d.iv) }, await cryptKey(env), unb64(d.ct)));
  } catch (e) { return null; }   // kept with another secret: as if not kept
}
const forget = env => env.DB.prepare('DELETE FROM docs WHERE name = ?').bind(ROW).run();

async function google(fetchFn, url, params) {
  let r;
  try { r = await fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() }); }
  catch (e) { return { ok: false, status: 0, d: { error: 'Google couldn\'t be reached' } }; }
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, d };
}
const why = g => g.d.error_description || g.d.error || 'Google answered ' + g.status;
const key = g => ({ access_token: g.d.access_token, expires_in: Number(g.d.expires_in) || 3600 });

export async function ytAuth(path, req, env, fetchFn, who) {
  if (req.method !== 'POST') return json(env, { error: 'POST only' }, 405);
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return json(env, { error: 'the site has no Google client secret set up (GOOGLE_CLIENT_SECRET)' }, 503);
  const client = { client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET };
  if (path === '/youtube/connect') {
    const b = await body(req, 4096);
    const code = b && typeof b.code === 'string' ? b.code : '';
    if (!code || code.length > 1024) return json(env, { error: 'expected { code } from Google\'s sign-in' }, 400);
    // The address Google sent the code to: this site's own /, never one the page names
    const g = await google(fetchFn, TOKEN_URL, Object.assign({ code, grant_type: 'authorization_code', redirect_uri: new URL(req.url).origin + '/' }, client));
    if (!g.ok || !g.d.access_token) return json(env, { error: 'Google refused the sign-in: ' + why(g) }, 502);
    if (g.d.refresh_token) await keep(env, g.d.refresh_token, who);
    return json(env, Object.assign(key(g), { kept: !!g.d.refresh_token || !!(await kept(env)) }));
  }
  if (path === '/youtube/token') {
    const refresh = await kept(env);
    if (!refresh) return json(env, { error: 'not signed in', connected: false }, 409);
    const g = await google(fetchFn, TOKEN_URL, Object.assign({ refresh_token: refresh, grant_type: 'refresh_token' }, client));
    if (g.ok && g.d.access_token) return json(env, key(g));
    // Revoked, expired, or for another client: forgotten, so the page asks to sign in again
    if (g.d.error === 'invalid_grant' || g.d.error === 'unauthorized_client' || g.d.error === 'invalid_client') {
      await forget(env);
      return json(env, { error: 'Google no longer accepts the kept sign-in (' + why(g) + ')', connected: false }, 409);
    }
    return json(env, { error: 'Google didn\'t give a new key: ' + why(g) }, 502);
  }
  if (path === '/youtube/disconnect') {
    const refresh = await kept(env);
    let revoked = false;
    if (refresh) revoked = (await google(fetchFn, REVOKE_URL, { token: refresh })).ok;
    await forget(env);
    return json(env, { ok: true, revoked });
  }
  return json(env, { error: 'not found' }, 404);
}
