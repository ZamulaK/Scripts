// Cloudflare Access in front of the Christmas Lounge site: Access signs each request it lets through with a
// token (the Cf-Access-Jwt-Assertion header). The site checks it again here, so a request that got around Access
// (a preview address, a mistake in its settings) gets nothing. ACCESS_TEAM is the Zero Trust team name (or its
// whole domain), ACCESS_AUD the application's audience tag. Without both, nothing is let through.
let certs = null;   // { team, at, keys: Map(kid -> CryptoKey) }, kept for an hour

const b64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const teamDomain = t => (/\./.test(t) ? t : t + '.cloudflareaccess.com').replace(/^https?:\/\//, '').replace(/\/+$/, '');

async function keysFor(domain, fetchFn) {
  if (certs && certs.team === domain && Date.now() - certs.at < 3600000) return certs.keys;
  const r = await fetchFn(`https://${domain}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error('Access keys: ' + r.status);
  const keys = new Map();
  for (const jwk of (await r.json()).keys || []) {
    keys.set(jwk.kid, await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
  }
  certs = { team: domain, at: Date.now(), keys };
  return keys;
}

// The signed-in email when the request carries a valid Access token for this application, else null
export async function accessEmail(req, env, fetchFn = fetch) {
  const team = String(env.ACCESS_TEAM || ''), aud = String(env.ACCESS_AUD || '');
  if (!team || !aud) return null;
  const cookie = (req.headers.get('Cookie') || '').match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  const token = req.headers.get('Cf-Access-Jwt-Assertion') || (cookie ? cookie[1] : '');
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const head = JSON.parse(new TextDecoder().decode(b64url(parts[0])));
    const body = JSON.parse(new TextDecoder().decode(b64url(parts[1])));
    if (head.alg !== 'RS256') return null;
    const domain = teamDomain(team);
    let key = (await keysFor(domain, fetchFn)).get(head.kid);
    if (!key) { certs = null; key = (await keysFor(domain, fetchFn)).get(head.kid); }   // keys were rotated
    if (!key) return null;
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
    const auds = Array.isArray(body.aud) ? body.aud : [body.aud];
    const now = Date.now() / 1000;
    if (!ok || auds.indexOf(aud) < 0 || body.iss !== `https://${domain}` || !(body.exp > now) || (body.nbf && body.nbf > now + 60)) return null;
    return body.email || body.sub || 'signed in';
  } catch (e) { return null; }
}

export function forgetAccessKeys() { certs = null; }   // for tests
