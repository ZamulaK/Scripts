// The Christmas Lounge site's audio player page (player.html), on workers.dev: SomaFM turns its stream away when the page
// asking is on pages.dev, so the site plays it from this page, shown inside the site as an invisible frame (Dan, Nov 5).
// It serves that one page and nothing else; nothing is kept or read.
import PAGE from './player.html';

// Only the site may show it in a frame; the page reaches nothing but SomaFM's stream servers
const HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; media-src https://*.somafm.com; " +
    'frame-ancestors https://xmaslounge.pages.dev https://*.xmaslounge.pages.dev',
  'Cache-Control': 'public, max-age=300',
  'X-Content-Type-Options': 'nosniff',
};

export default {
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('GET only\n', { status: 405 });
    if (url.pathname !== '/') return new Response('Not found\n', { status: 404 });
    return new Response(req.method === 'HEAD' ? null : PAGE, { headers: HEADERS });
  },
};
