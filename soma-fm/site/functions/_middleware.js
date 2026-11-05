// Visits to the old pages.dev addresses move to Dan's own domain (Nov 5, 2026), keeping the rest of the address, so
// bookmarks and links still land on the same page. Left alone: /api (a tab still open on the old address keeps saving
// until it's reloaded), anything but GET/HEAD, and each deployment's own address (abc123.xmaslounge.pages.dev), so a
// particular deployment can still be looked at. Temporary (302) for now: browsers hold on to a permanent one for a long
// time, so it's easy to take back. Cloudflare Access still asks for sign-in on the old address first.
const MOVES = {
  'xmaslounge.pages.dev': 'xmaslounge.zamulagh.fyi',
  'next.xmaslounge.pages.dev': 'next.xmaslounge.zamulagh.fyi',
};

export function redirectFor(request) {
  const url = new URL(request.url), to = MOVES[url.hostname];
  if (!to) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return null;
  url.hostname = to;
  return new Response(null, { status: 302, headers: { Location: url.toString(), 'Cache-Control': 'no-store' } });
}

export const onRequest = ({ request, next }) => redirectFor(request) || next();
