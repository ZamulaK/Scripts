// Page check for the new Christmas Lounge site (site/app, Pocket v2), against a stand-in for its /api
//
// Loads the site's own files in headless Chromium with every /api request answered here: plays seeded like
// page-check.js, the playlist from playlist.fixture.json, and /api/change merged with the checker's own Sync rules,
// as the real server does. Google is stood in for too, so nothing outside is contacted.
// Checks each page at 1024, 600 (Dan's tablet) and 360 px, in each theme and dark mode, then the things that send
// changes (marks, links, favorites, categories, notes, gone songs), the filters in the address, Stats (Dan's two
// tweaks), Shuffle's sign-in, backup and restore, and script errors.
//
//   npm run test:next
//
// Exit code is non-zero if any check fails.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const X = require('./soma-xmas-checker.user.js');

const SITE = 'https://lounge.test/';
const APP = path.join(__dirname, 'site', 'app');
const items = JSON.parse(fs.readFileSync(path.join(__dirname, 'playlist.fixture.json'), 'utf8')).map((x, i) => Object.assign({ secs: 150 + (i * 37) % 200 }, x));
const fixtureItems = items.slice();

let fails = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : '  — ' + detail}`); if (!ok) fails++; };

// Three days of plays from a 60-song rotation, with two recording gaps, newest first (as page-check.js)
function seedHistory() {
  const pool = [];
  for (let i = 0; i < 40; i++) { const it = items[i]; const m = it.title.split(' - '); pool.push(m.length > 1 ? [m[0], m[1]] : [it.ch.replace(/ - Topic$/, ''), it.title]); }
  for (let i = 0; i < 20; i++) pool.push(['Rotation Artist ' + i, 'Rotation Song ' + i]);
  const hist = []; let t = Math.floor(Date.now() / 1000) - 600, seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 700; i++) {
    const [a, ti] = pool[Math.floor(rnd() * pool.length)];
    const gap = i === 250 || i === 500;
    hist.push(gap ? [t, a, ti, 'Album ' + (i % 7), 1] : [t, a, ti, 'Album ' + (i % 7)]);
    t -= gap ? 7 * 3600 : 215;
  }
  return hist;
}
const hist = seedHistory();

// The stand-in server: one document, merged like worker/src/site.js change()
function freshApi() {
  const archive = {};
  for (const it of items) archive[it.id] = { id: it.id, title: it.title, ch: it.ch, first: Date.now() - 864e5 * 5, last: Date.now() - 864e5 };
  archive.goneVideo1 = { id: 'goneVideo1', title: 'Rotation Song 3 - Rotation Artist 3', ch: 'Somebody', first: Date.now() - 864e5 * 5, last: Date.now() - 864e5 * 2, gone: Date.now() - 864e5 };
  const doc = X.Sync.clean({ archive, favorites: { [items[0].id]: { on: true, at: 1 } }, categories: { [items[1].id]: { c: 'jazz', at: 1 } }, notes: {} });
  return { version: 1, doc, calls: [], changes: [], posted: 0, signedIn: true, playlistReads: 0 };
}
let api = freshApi();

async function open(browser, { width = 600, height = 1000, scheme = 'light', path: p = '/', theme, init, noPlayer, site: SITE = 'https://lounge.test/' } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, timezoneId: 'America/New_York', acceptDownloads: true });
  if (init) await ctx.addInitScript(init);
  if (theme !== undefined) await ctx.addInitScript(t => localStorage.setItem('xl:theme', JSON.stringify(t)), theme);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await ctx.route('https://fonts.googleapis.com/**', r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await ctx.route('https://fonts.gstatic.com/**', r => r.abort());
  // Google's Cast sender library: here it only reports in (a check stands in for the rest where it needs to)
  await ctx.route('https://www.gstatic.com/cv/**', r => r.fulfill({ status: 200, contentType: 'text/javascript', body: 'window.__onGCastApiAvailable && window.__onGCastApiAvailable(!!(window.cast && window.cast.framework))' }));
  // Listen's player page on workers.dev (player/src/player.html), or none (as where it can't load)
  await ctx.route('https://lounge-player.soma-recorder.workers.dev/**', r => noPlayer ? r.abort() : r.fulfill({ status: 200, contentType: 'text/html', body: fs.readFileSync(path.join(__dirname, 'player', 'src', 'player.html'), 'utf8') }));
  // Video pictures: a 1-pixel stand-in, and none for a video id containing "gone" (as for a deleted video)
  await ctx.route('https://i.ytimg.com/**', r => /gone/.test(r.request().url()) ? r.fulfill({ status: 404, body: '' })
    : r.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') }));
  // Google's sign-in, standing in: straight back to the site with an access key, as the real one does after you choose an account
  await ctx.route('https://accounts.google.com/**', route => {
    const q = new globalThis.URL(route.request().url()).searchParams;
    api.authQuery = Object.fromEntries(q);
    // The lasting sign-in (keepsSignIn) asks for a one-time code, which comes back in the address's ?query
    const back = q.get('response_type') === 'code' ? q.get('redirect_uri') + '?' + new URLSearchParams({ state: q.get('state'), code: 'good-code', scope: q.get('scope') })
      : q.get('redirect_uri') + '#' + new URLSearchParams({ state: q.get('state'), access_token: 'site-token', expires_in: '3600', token_type: 'Bearer' });
    route.fulfill({ status: 200, contentType: 'text/html', body: '<script>location.replace(' + JSON.stringify(back) + ')</script>' });
  });
  await ctx.route('https://www.googleapis.com/**', route => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { message: 'stand-in refuses', errors: [{ reason: 'forbidden' }] } }) }));
  await ctx.route(SITE + '**', route => {
    const req = route.request(), u = new globalThis.URL(req.url()), pth = u.pathname;
    const send = (body, type = 'application/json', status = 200) => route.fulfill({ status, contentType: type, body: typeof body === 'string' ? body : JSON.stringify(body) });
    if (pth === '/lib/soma-xmas-checker.user.js') return send(fs.readFileSync(path.join(__dirname, 'soma-xmas-checker.user.js'), 'utf8'), 'text/javascript');
    if (pth === '/app.js') return send(fs.readFileSync(path.join(APP, 'app.js'), 'utf8'), 'text/javascript');
    if (pth === '/app.css') return send(fs.readFileSync(path.join(APP, 'app.css'), 'utf8'), 'text/css');
    // The app's manifest and icons, as files
    if (/^\/(manifest\.webmanifest|icons\/[\w.-]+)$/.test(pth) && fs.existsSync(path.join(APP, pth))) return route.fulfill({ status: 200, contentType: { webmanifest: 'application/manifest+json', png: 'image/png', svg: 'image/svg+xml' }[pth.split('.').pop()], body: fs.readFileSync(path.join(APP, pth)) });
    if (!pth.startsWith('/api/')) return send(fs.readFileSync(path.join(APP, 'index.html'), 'utf8'), 'text/html');   // Pages serves the page for every address
    api.calls.push(req.method() + ' ' + pth + u.search);
    if (!api.signedIn) return send({ error: 'sign in' }, 'application/json', 401);
    const now = Math.floor(Date.now() / 1000);
    if (pth === '/api/config') return send({ clientId: 'built-in.apps.googleusercontent.com', keepsSignIn: !!api.keeps });
    // Shuffle's lasting sign-in, as worker/src/ytauth.js answers (its own tests are the worker's)
    if (pth === '/api/youtube/connect') { if (JSON.parse(req.postData()).code !== 'good-code') return send({ error: 'Google refused the sign-in: bad code' }, 'application/json', 502); api.yt = 'kept'; return send({ access_token: 'kept-token', expires_in: 3599, kept: true }); }
    if (pth === '/api/youtube/token') { api.ytTokens = (api.ytTokens || 0) + 1; return api.yt ? send({ access_token: 'fresh-token', expires_in: 3599 }) : send({ error: 'not signed in', connected: false }, 'application/json', 409); }
    if (pth === '/api/youtube/disconnect') { api.yt = null; return send({ ok: true, revoked: true }); }
    if (pth === '/api/feed') api.fed = true;
    if (pth === '/api/feed') return send({ songs: hist.slice(0, 15).map(x => ({ date: String(x[0]), artist: x[1], title: x[2], album: x[3] })) });
    if (pth === '/api/playlist') { api.playlistReads++; return send({ items, hidden: 1, complete: true, read: items.length + 1, expected: items.length, at: Date.now() - 120000 }); }
    if (pth === '/api/plays' && req.method() === 'POST') { api.posted += JSON.parse(req.postData()).plays.length; return send({ received: 1, changed: 0 }); }
    // staleUntilFeed: the stored plays lack the newest three until SomaFM's list is read (the recorder's 10-minute look)
    if (pth === '/api/plays' && api.staleUntilFeed) { const since = Number(u.searchParams.get('since')) || 0, have = api.fed ? hist : hist.slice(3); return send({ channel: 'christmas', now, recording: true, lastRun: { at: now - 600, ok: true, added: 1, note: '', lastOk: now - 600 }, plays: have.filter(x => x[0] >= since), breaks: [] }); }
    if (pth === '/api/plays') return send({ channel: 'christmas', now, recording: true, lastRun: { at: now - 60, ok: true, added: 1, note: '', lastOk: now - 60 }, plays: Number(u.searchParams.get('since')) ? [] : hist, breaks: [] });
    if (pth === '/api/state') return send({ version: api.version, state: api.doc });
    if (pth === '/api/change') {
      const patch = JSON.parse(req.postData()).patch;
      api.changes.push(patch);
      api.doc = X.Sync.merge(api.doc, X.Sync.clean(patch)); api.version++;
      return send({ version: api.version, state: api.doc, changed: true });
    }
    return send({ error: 'not found' }, 'application/json', 404);
  });
  await page.goto(SITE.replace(/\/$/, '') + p, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector('.pr, .hero, .box'), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);
  return { ctx, page, errors };
}
// The Now card's video picture that shows (one is written for phones, one for wider screens), and where it sits
const heroThumb = page => page.evaluate(() => {
  const all = [...document.querySelectorAll('.hero .hthumb')], vis = all.filter(a => a.getBoundingClientRect().width > 0);
  if (!all.length) return null;
  const a = vis[0] || all[0], b = a.getBoundingClientRect(), h = document.querySelector('.hero').getBoundingClientRect(), img = a.querySelector('img');
  const p = document.querySelector('.hero .hmain p').getBoundingClientRect(), top = document.querySelector('.hero .hero-top').getBoundingClientRect(), acts = document.querySelector('.hero .acts').getBoundingClientRect();
  const r = document.createRange(); r.selectNodeContents(document.querySelector('.hero h2 span'));
  const words = [...document.querySelectorAll('.hero h2 > span, .hero h2 > span .nw')].flatMap(e => [...e.childNodes]).filter(n => n.nodeType === 3 && n.textContent.trim()), lr = document.createRange(); lr.selectNodeContents(words[words.length - 1]);
  const lines = [...lr.getClientRects()].filter(l => l.width > 0), last = lines[lines.length - 1], st = document.querySelector('.hero h2 .star');
  const sr = st && st.getBoundingClientRect(), starWithLast = !st || (sr.top + sr.height / 2 > last.top && sr.top + sr.height / 2 < last.bottom && sr.left >= last.left);
  const clear = [...r.getClientRects()].every(l => l.bottom <= b.top || l.top >= b.bottom || l.right <= b.left);   // the name never runs under it
  // The album on a line of its own under the artist (Dan, Nov 5); on a phone the picture starts at the album's line
  const art = document.querySelector('.hero .hmain p.hartist'), alb = document.querySelector('.hero .hmain p.halbum'), ar = art.getBoundingClientRect();
  const albumLine = !alb || (alb.getBoundingClientRect().top >= ar.bottom - 1 && !/ · /.test(art.textContent));
  const lr2 = alb ? alb.getBoundingClientRect() : ar, mid = (ar.top + lr2.bottom) / 2;
  // beside the artist and album; with an album, centered on the two lines (Dan, Nov 5)
  const atAlbum = b.left >= ar.right && (!alb || b.left >= lr2.right) && (alb ? Math.abs((b.top + b.bottom) / 2 - mid) <= 2 : b.top >= ar.top - 8 && b.top < ar.bottom);
  return { shown: vis.length, w: Math.round(b.width), h: Math.round(b.height), src: /^https:\/\/i\.ytimg\.com\/vi\/[^/]+\/mqdefault\.jpg$/.test(img.src), href: /youtube\.com\/watch\?v=/.test(a.href),
    inside: b.right <= h.right - 8 && b.top >= h.top + 8, besideArtist: b.left >= p.right && b.top >= p.top - 8, abovePlays: b.bottom <= acts.top + 2, corner: b.top <= top.top + 4 && b.right >= h.right - 30, clear, starWithLast, albumLine, atAlbum, album: !!alb };
});
const tabTo = async (page, name) => { await page.click(`.tabs a:has-text("${name}")`); await page.waitForTimeout(300); };
// Anything wider than the window, or a row of buttons spilling out of its box
const overflow = page => page.evaluate(() => {
  const w = document.documentElement.clientWidth, bad = [];
  if (document.documentElement.scrollWidth > w + 1) bad.push('page ' + document.documentElement.scrollWidth + '>' + w);
  for (const e of document.querySelectorAll('.pill,.chip,.box,.plays,.hero,.bar-line,.detail,.kv')) { const r = e.getBoundingClientRect(); if (r.width && (r.right > w + 1 || r.left < -1)) bad.push((e.className || e.tagName) + ' ' + Math.round(r.left) + '–' + Math.round(r.right)); }
  return bad.slice(0, 5);
});

(async () => {
  // The move from the pages.dev addresses to Dan's own domain (site/functions/_middleware.js, Nov 5)
  {
    const { redirectFor } = await import(require('url').pathToFileURL(path.join(__dirname, 'site', 'functions', '_middleware.js')).href);
    const to = (u, method = 'GET') => { const r = redirectFor(new Request(u, { method })); return r ? r.status + ' ' + r.headers.get('Location') : 'stays'; };
    const cases = [
      ['https://xmaslounge.pages.dev/history?q=snow&page=2', 'GET', '302 https://xmaslounge.zamulagh.fyi/history?q=snow&page=2'],
      ['https://xmaslounge.pages.dev/', 'HEAD', '302 https://xmaslounge.zamulagh.fyi/'],
      ['https://xmaslounge.pages.dev/old/', 'GET', '302 https://xmaslounge.zamulagh.fyi/old/'],
      ['https://next.xmaslounge.pages.dev/stats', 'GET', '302 https://next.xmaslounge.zamulagh.fyi/stats'],
      ['https://xmaslounge.pages.dev/api/plays?since=0', 'GET', 'stays'],
      ['https://xmaslounge.pages.dev/api/change', 'POST', 'stays'],
      ['https://3eb7faa0.xmaslounge.pages.dev/', 'GET', 'stays'],
      ['https://xmaslounge.zamulagh.fyi/', 'GET', 'stays'],
      ['https://next.xmaslounge.zamulagh.fyi/history', 'GET', 'stays'],
    ];
    const bad = cases.filter(([u, m, want]) => to(u, m) !== want).map(([u, m, want]) => `${m} ${u}: ${to(u, m)} (want ${want})`);
    check('Old addresses move to the own domain (same page; not /api, not other methods, not a deployment\'s own address)', !bad.length, bad.join(' | '));
  }
  const browser = await chromium.launch();
  let s = await open(browser);
  const now = await s.page.evaluate(() => ({ hero: ((document.querySelector('.hero h2 > span') || {}).textContent || '').replace(/[★☆]$/, ''), tag: (document.querySelector('.hero small') || {}).textContent, st: (document.querySelector('.hero .st') || {}).className, stText: (document.querySelector('.hero .st') || {}).textContent, just: document.querySelectorAll('.plays .pr:not(.ph)').length,
    tiles: [...document.querySelectorAll('.g2 .box b.big')].map(b => b.textContent), tabs: [...document.querySelectorAll('.tabs a')].map(a => a.textContent.trim()).join() }));
  check('Now: what\'s playing (from the feed), its status, two tiles and the plays just before', now.hero === hist[0][2] && now.tag === 'Now playing' && /^st (have|other|none|gone|disliked)$/.test(now.st) && now.stText.length > 3 && now.just === 7
    && now.tiles.length === 2 && /h$/.test(now.tiles[0]) && now.tiles[1] === '700' && now.tabs === 'Now,History,Stats,Shuffle,More', JSON.stringify(now));
  check('Loads the plays, the document, the playlist (the kept read, within 15 min) and the feed from /api', ['GET /api/state', 'GET /api/plays?channel=christmas&since=0', 'GET /api/feed?channel=christmas'].every(c => api.calls.indexOf(c) >= 0)
    && api.calls.some(c => /^GET \/api\/playlist\?list=.*&within=900$/.test(c)), api.calls.join());
  check('Nothing of Dan\'s data is kept in the browser: only settings in localStorage, no IndexedDB', await s.page.evaluate(async () => {
    const keys = Object.keys(localStorage); const dbs = indexedDB.databases ? await indexedDB.databases() : [];
    return keys.every(k => /^xl:(theme|live|per|histq|topSort|listAlbum|listNotes|listenVia2|device|signin:|shuffle:job)/.test(k)) && dbs.length === 0;
  }));

  // History
  await tabTo(s.page, 'History');
  let h = await s.page.evaluate(() => ({ url: location.pathname + location.search, chips: [...document.querySelectorAll('.quick .chip')].map(c => c.innerText.replace(/\s+\d[\d,]*$/, '').trim()), more: !!document.querySelector('.more-f'),
    rows: document.querySelectorAll('#plist .pr:not(.ph)').length, gaps: document.querySelectorAll('.gaprow').length, line: document.querySelector('.bar-line .grow').textContent, gone: (document.querySelector('#gonebox summary') || {}).textContent }));
  check('History: five chips to start (All, Latest, In playlist, Not in playlist, Favorites; short names at 600 px) and All filters', h.url === '/history' && h.chips.join() === 'All,Latest,In list,Not in list,★' && h.more, JSON.stringify(h));
  check('History: 50 plays a page, gap rows between plays, the playlist line and the gone-from-playlist notice', h.rows === 50 && h.gaps === 0 && /Xmas Mixed playlist · 61 songs \(1 unavailable left out\) · checked 2 min ago/.test(h.line) && /1 song is gone/.test(h.gone), JSON.stringify(h));
  await s.page.click('.more-f');
  const panel = await s.page.evaluate(() => ({ heads: [...document.querySelectorAll('.fpanel h5')].map(x => x.textContent).join('|'), chips: document.querySelectorAll('.fpanel .chip').length, latest: (document.querySelectorAll('.fpanel .grp')[0].children[1] || {}).dataset.act === 'flatest' }));
  check('History: All filters opens Status (Latest play only second) / Favorites and categories, with Clear all and Done', panel.heads === 'Status|Favorites and categories' && panel.latest && panel.chips >= 12, JSON.stringify(panel));
  await s.page.click('.fpanel .chip:has-text("Other version")');
  await s.page.click('.fpanel .chip:has-text("Jazz/Piano")');
  await s.page.click('.fpanel [data-act="fdone"]');
  h = await s.page.evaluate(() => ({ url: location.pathname + location.search, chips: [...document.querySelectorAll('.quick .chip')].map(c => c.firstChild.textContent.trim()).join(), badge: (document.querySelector('.more-f .badge') || {}).textContent }));
  check('History: filters that are on stay among the chips, with "N on", and live in the address', h.url === '/history?status=other&cat=jazz' && /Other version/.test(h.chips) && /Jazz/.test(h.chips) && h.badge === '2 on', JSON.stringify(h));
  await s.page.click('.more-f'); await s.page.click('[data-act="fclear"]'); await s.page.click('[data-act="fdone"]');
  await s.page.click('.quick .chip[data-v="none"]');
  const none = await s.page.evaluate(() => [...document.querySelectorAll('#plist .pr:not(.ph) .m-side .st')].map(x => x.textContent));
  check('History: Not in playlist shows only those (and songs gone from it)', none.length > 0 && none.every(t => /Not in playlist|Gone from playlist/.test(t)), [...new Set(none)].join());
  await s.page.fill('#find', 'rotation song 1');
  await s.page.waitForTimeout(200);
  const found = await s.page.evaluate(() => ({ titles: [...new Set([...document.querySelectorAll('#plist .pr:not(.ph) .c-song b')].map(b => b.textContent))], focus: document.activeElement.id, url: location.search }));
  check('History: the search box narrows the plays as you type, keeping the focus, and goes in the address', found.titles.length > 0 && found.titles.every(t => /^Rotation Song 1/.test(t)) && found.focus === 'find' && /q=rotation/.test(found.url), JSON.stringify(found));
  await s.page.fill('#find', '');
  await s.page.click('.quick .chip:has-text("All")');

  // A song's row: its choices, and each change sent to /api/change
  const rowFor = title => s.page.locator('#plist .pr:not(.ph)', { has: s.page.locator('.c-song b', { hasText: new RegExp('^' + title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s☆★✎]*$') }) }).first();
  await rowFor('Rotation Song 2').click();
  let d = await s.page.evaluate(() => { const x = document.querySelector('.pr.open .detail'); return x && { rows: x.querySelectorAll('.row').length, buttons: [...x.querySelectorAll('.row button, .row a')].map(b => b.textContent.trim()), log: x.querySelectorAll('.log li').length }; });
  check('Row: tapping opens I have it, Dislike and Add a note in one row, and every play of the song', d && d.rows === 1 && d.buttons.join() === '✓ I have it,👎 Dislike,✎ Add a note' && d.log > 1, JSON.stringify(d));
  const icons = await s.page.evaluate(() => [...document.querySelectorAll('#plist .pr:not(.ph)')].map(r => ({ st: r.querySelector('.m-side .st').textContent, open: !!r.querySelector('.c-go a.open'), search: !!r.querySelector('.c-go a[href*="results?search_query"]'), star: !!r.querySelector('.c-song .star') })));
  check('Rows: an Open icon for songs you have, a Search icon for ones you don\'t (both for another version), a star on songs in the playlist',
    icons.every(x => x.st === 'In playlist' ? x.open && !x.search && x.star : x.st === 'Not in playlist' ? !x.open && x.search && !x.star : x.st === 'Different mix' || x.st === 'Other version' ? x.open && x.search : true), JSON.stringify(icons.slice(0, 6)));
  await s.page.click('.pr.open [data-act="pick"]');
  const pick = await s.page.evaluate(() => ({ q: document.activeElement.id, n: document.querySelectorAll('.choice').length }));
  await s.page.fill('#pick-q', 'marshmallow');
  await s.page.waitForTimeout(100);
  const choices = await s.page.evaluate(() => [...document.querySelectorAll('.choice')].map(c => c.textContent));
  check('Row: I have it opens "Which playlist song is it?", searching the playlist as you type', pick.q === 'pick-q' && choices.length >= 1 && choices.every(c => /Marshmallow/i.test(c)), JSON.stringify({ pick, choices }));
  api.changes = [];
  await s.page.click('.choice >> nth=0');
  await s.page.waitForTimeout(1300);
  const key = X.markKey('Rotation Artist 2', 'Rotation Song 2');
  let ch = api.changes[0] || {};
  check('Row: choosing links it, sent as one change: the mark with the video, and the row is In playlist', ch.marks && ch.marks[key] && ch.marks[key].v === 'have' && /^[\w-]{11}$/.test(ch.marks[key].id)
    && api.doc.marks[key] && await rowFor('Rotation Song 2').locator('.m-side .st').textContent() === 'In playlist', JSON.stringify(ch));
  const wasOpen = await s.page.evaluate(() => !!document.querySelector('.pr.open'));
  await rowFor('Rotation Song 2').locator('.star').click();
  await s.page.waitForTimeout(300);
  const vid = api.doc.marks[key].id;
  check('Row: the ☆ on the row stars the linked video, without opening or closing the row', api.doc.favorites[vid] && api.doc.favorites[vid].on === true
    && await rowFor('Rotation Song 2').locator('.star').textContent() === '★' && await s.page.evaluate(() => !!document.querySelector('.pr.open')) === wasOpen);
  if (!wasOpen) await rowFor('Rotation Song 2').locator('.c-time').click();
  await s.page.click('.pr.open [data-act="catmenu"]');
  await s.page.click('.menu button:has-text("Mellow")');
  await s.page.waitForTimeout(300);
  check('Row: the category menu (in the page\'s colors) sets the category', api.doc.categories[vid] && api.doc.categories[vid].c === 'mellow' && /Mellow/.test(await s.page.locator('.pr.open [data-act="catmenu"]').textContent()));
  await s.page.click('.pr.open [data-act="note"]');
  check('Row: Add a note opens a box with the focus in it', await s.page.evaluate(() => document.activeElement.id === 'note-text'));
  await s.page.fill('#note-text', 'Found it on YouTube');
  await s.page.click('[data-act="noteSave"]');
  await s.page.waitForTimeout(300);
  check('Row: the note is saved and shown, with an edit icon beside it (Add a note gone)', api.doc.notes[key] && api.doc.notes[key].t === 'Found it on YouTube' && await s.page.locator('.pr.open .note').textContent() === 'Found it on YouTube'
    && await s.page.locator('.pr.open .notewrap .icon[data-act="note"]').count() === 1 && await s.page.locator('.pr.open .row [data-act="note"]').count() === 0);
  await s.page.click('.pr.open .notewrap .icon');
  check('Row: the edit icon opens the note to edit', await s.page.evaluate(() => document.activeElement.id === 'note-text' && document.activeElement.value === 'Found it on YouTube'));
  await s.page.click('[data-act="noteCancel"]');
  await s.page.click('.pr.open [data-act="unlink"]');
  await s.page.waitForTimeout(300);
  check('Row: Unlink keeps "I have it" without the video', api.doc.marks[key] && api.doc.marks[key].v === 'have' && !api.doc.marks[key].id, JSON.stringify(api.doc.marks[key]));
  await s.page.click('.pr.open [data-act="unmark"]');
  await s.page.waitForTimeout(300);
  check('Row: Undo clears the mark, remembered as removed (so today\'s site doesn\'t bring it back)', !api.doc.marks[key] && api.doc.removed.marks[key] > 0 && await rowFor('Rotation Song 2').locator('.m-side .st').textContent() === 'Not in playlist');
  await s.page.click('.pr.open [data-act="dislike"]');
  await s.page.waitForTimeout(300);
  check('Row: Dislike', api.doc.dislikes[key] > 0 && await rowFor('Rotation Song 2').locator('.m-side .st').textContent() === 'Disliked');
  await s.page.click('.pr.open [data-act="undislike"]');
  await s.page.waitForTimeout(300);
  check('Row: Undo dislike', !api.doc.dislikes[key] && api.doc.removed.dislikes[key] > 0);
  await s.page.click('#gonebox summary');
  await s.page.click('#gonebox [data-act="dismiss"]');
  await s.page.waitForTimeout(300);
  check('History: Dismiss on a song gone from the playlist', api.doc.archive.goneVideo1.dismissed > 0 && !(await s.page.$('#gonebox')));
  // Back and forward
  await tabTo(s.page, 'Stats');
  await s.page.goBack(); await s.page.waitForTimeout(300);
  check('The back button goes back to the page before', await s.page.evaluate(() => location.pathname === '/history' && !!document.querySelector('#find')));
  check('No script errors (phone layout, every change)', s.errors.length === 0, s.errors.join(' | '));
  await s.ctx.close();

  // Stats, with Dan's two tweaks
  s = await open(browser, { path: '/stats' });
  const t = await s.page.evaluate(() => ({ big: [...document.querySelectorAll('.g3 .box')].map(b => b.textContent.trim()), status: [...document.querySelectorAll('.kv.stat')].map(k => k.textContent.replace(/\s+/g, ' ').trim()),
    heads: [...document.querySelectorAll('h3')].map(x => x.firstChild.textContent.trim()) }));
  const total = items.reduce((a, it) => a + it.secs, 0), mins = Math.round(total / 60), want = Math.floor(mins / 60) + ' h ' + (mins % 60) + ' min';
  check('Stats: total playlist time as "9 h 38 min", from the real lengths (tweak 1)', t.big[1] === want + 'total length', JSON.stringify(t.big) + ' want ' + want);
  check('Stats: songs by status, as a share of songs and of plays (tweak 2), leaving In playlist and Disliked to the cards', t.status.length >= 2 && t.status.every(x => !/^(In playlist|Disliked)/.test(x) && /\d+ songs? · \d+%\s*\d+ plays? · \d+%/.test(x)), JSON.stringify(t.status));
  check('Stats: Songs by status right under the playlist cards', t.heads[0] === 'Your playlist' && t.heads[1] === 'Songs by status' && t.heads[2] === 'Heard so far', t.heads.join('|'));
  // "Of the last 100 plays, heard for the first time": left out at 0; otherwise split only at its comma, the figures on one line
  const ft = await s.page.evaluate(() => { const kv = [...document.querySelectorAll('.kv')].find(x => /heard for the first time/.test(x.textContent)); return kv ? { v: kv.querySelector('b').textContent, parts: kv.querySelectorAll('span.nw').length, oneLine: kv.querySelector('b').getClientRects().length === 1 } : null; });
  check('Stats: the first-time share left out at 0, else broken only at the comma', ft === null || (!/^0 /.test(ft.v) && ft.parts === 2 && ft.oneLine), JSON.stringify(ft));
  check('Stats: every section',['Your playlist', 'Categories', 'Songs by status', 'SomaFM rotation', 'Most played', "Most played that you don't have (", 'Recording'].every(x => t.heads.some(hh => hh.indexOf(x) === 0)), t.heads.join('|'));
  await s.page.click('[data-act="topSort"][data-v="recent"]');
  check('Stats: Most played sorts by latest too, and its rows open like History', await s.page.evaluate(() => /Most recently replayed/.test(document.body.textContent)) && (await s.page.locator('h3:has-text("Most recently replayed") + .plays .pr:not(.ph)').first().click(), await s.page.evaluate(() => !!document.querySelector('.pr.open .detail .log'))));
  check('No script errors (Stats)', s.errors.length === 0, s.errors.join(' | '));
  await s.ctx.close();

  // Dan's tweaks of Nov 4, on a phone (360 px)
  {
    const nowKey = X.markKey(hist[0][1], hist[0][2]);
    api.doc.notes[nowKey] = { t: 'First line of the note\nSecond line', at: Date.now() };
    s = await open(browser, { width: 360 });
    const root = await s.page.evaluate(() => { const c = getComputedStyle(document.documentElement); return [c.getPropertyValue('--muted').trim(), c.getPropertyValue('--faint').trim()]; });
    check('Text in three levels: secondary text brighter, the old color kept for the third level', root[0] === '#bcc6db' && root[1] === '#97a3bd', root.join());
    check('Now: the line under the title is just "SomaFM Christmas Lounge"', await s.page.locator('header.top .sub').textContent() === 'SomaFM Christmas Lounge');
    const tileText = pg => pg.evaluate(() => [...document.querySelectorAll('.g2 .box')].slice(0, 2).map(b => b.innerText.replace(/\s+/g, ' ').trim()));
    const tl360 = await tileText(s.page);
    const w600 = await open(browser, { width: 600 }), tl600 = await tileText(w600.page);
    const beside = await w600.page.evaluate(() => [...document.querySelectorAll('.g2 .tl')].every(r => { const b = r.querySelector('b').getBoundingClientRect(), k = r.querySelector('.k').getBoundingClientRect(); return k.left > b.right - 1 && Math.abs(k.bottom - b.bottom) < 8; }));
    // "until a song repeats" is one line beside a card of two: centered top to bottom (Dan, Nov 4)
    const mid = await w600.page.evaluate(() => { const box = document.querySelector('.g2 .box').getBoundingClientRect(), tl = document.querySelector('.g2 .box .tl').getBoundingClientRect(); return Math.abs((tl.top - box.top) - (box.bottom - tl.bottom)); });
    await w600.ctx.close();
    check('Now (600 px): the repeat card\'s line centered top to bottom', mid < 2, String(mid));
    check('Now cards: "until a song repeats"; plays and distinct songs, short words on a phone', /^[\d.]+ h until a song repeats$/.test(tl360[0]) && /^700 plays \d+ songs$/.test(tl360[1]) && /^700 plays recorded \d+ distinct songs$/.test(tl600[1]), JSON.stringify({ tl360, tl600 }));
    check('Now cards (600 px): the words beside each count', beside);
    const feeds = () => api.calls.filter(c => /^GET \/api\/feed/.test(c)).length;
    let f0 = feeds();
    await s.page.click('header.top .hre');
    await s.page.waitForTimeout(500);
    check('The ↻ beside the title reads the latest now', feeds() > f0 && /Read again/.test(await s.page.locator('#toast').textContent()), String(feeds() - f0));
    f0 = feeds();
    await s.page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await s.page.waitForTimeout(500);
    check('A tab brought back (from the back/forward cache here) reads the latest at once', feeds() > f0, String(feeds() - f0));
    const hero = await s.page.evaluate(() => { const acts = [...document.querySelectorAll('.hero .acts > *')];
      return { note: (document.querySelector('.hero .hnote') || {}).textContent, lines: new Set(acts.map(a => Math.round(a.getBoundingClientRect().top))).size, right: Math.max(...acts.map(a => a.getBoundingClientRect().right)), edge: document.querySelector('.hero').getBoundingClientRect().right,
        have: /\bhave\b/.test((document.querySelector('.hero .st') || {}).className), star: !!document.querySelector('.hero h2 .star'), favPill: !!document.querySelector('.hero .acts [data-act="fav"]') }; });
    const th = await heroThumb(s.page);
    check('Now card (360 px): a small picture from the video when the song is in the playlist, beside the artist and album (each on its own line, the picture centered on them), above the play count', hero.have ? !!th && th.shown === 1 && th.src && th.href && th.w === 88 && th.h >= 49 && th.h <= 50 && th.besideArtist && th.abovePlays && th.inside && th.starWithLast && th.albumLine && th.album && th.atAlbum : !th, JSON.stringify(th));
    for (const width of [600, 1024]) {
      const w = await open(browser, { width });
      const tw = await heroThumb(w.page);
      check(`Now card (${width} px): the picture in the top right corner, the name wrapping around it, the star on the line with its last word`, hero.have ? !!tw && tw.shown === 1 && tw.w === 128 && tw.corner && tw.clear && tw.abovePlays && tw.inside && tw.starWithLast && tw.albumLine && tw.album : !tw, JSON.stringify(tw));
      await w.ctx.close();
    }
    check('Now card: the whole note at the bottom', hero.note === 'First line of the note\nSecond line', JSON.stringify(hero));
    check('Now card (360 px): its buttons on one line, inside the card; Favorite is a star beside the name', hero.lines === 1 && hero.right <= hero.edge && !hero.favPill && hero.star === hero.have, JSON.stringify(hero));
    await s.page.click('.hero h2 span');
    const heroOpen = await s.page.evaluate(() => ({ open: document.querySelector('.hero').classList.contains('open'), exp: document.querySelector('.hero').getAttribute('aria-expanded'), detail: !!document.querySelector('.hero-detail .detail'), turned: getComputedStyle(document.querySelector('.hero .chev svg')).transform !== 'none', stop: !!document.querySelector('.hero .acts a[data-stop]') }));
    await s.page.click('.hero .hcount');
    const heroShut = await s.page.evaluate(() => !document.querySelector('.hero.open') && !document.querySelector('.hero-detail'));
    check('Now card opens and closes like a row: tap anywhere on it, its chevron turned over while open', heroOpen.open && heroOpen.exp === 'true' && heroOpen.detail && heroOpen.turned && heroOpen.stop && heroShut, JSON.stringify({ heroOpen, heroShut }));
    await tabTo(s.page, 'History');
    const first = s.page.locator('#plist .pr:not(.ph)').first();
    check('Lists: the date under a time in the brighter secondary text', await first.evaluate(r => getComputedStyle(r.querySelector('.c-time small')).color) === 'rgb(188, 198, 219)');
    const ln = await first.evaluate(r => { const n = r.querySelector('.lnote'); return n && { t: n.textContent, cls: n.className, color: getComputedStyle(n).color, icon: !!r.querySelector('.c-song .ic') }; });
    check('Lists: a song\'s note shows its first line under the song, in the third text level', ln && ln.t === 'First line of the note' && /\bone\b/.test(ln.cls) && ln.color === 'rgb(151, 163, 189)' && !ln.icon, JSON.stringify(ln));
    // The list's rows: the time as 24-hour hh:mm on one line (phones); the icon and the status on one line, the count and chevron below
    const lay = await s.page.evaluate(() => [...document.querySelectorAll('#plist .pr:not(.ph)')].slice(0, 8).map(r => {
      const R = e => e.getBoundingClientRect(), tm = r.querySelector('.c-time'), clock = tm.querySelector('.t24');
      const go = r.querySelector('.c-go'), st = R(r.querySelector('.m-st')), cnt = R(r.querySelector('.m-cnt')), song = R(r.querySelector('.c-song'));
      return { timeLines: clock.getClientRects().length, nowBelow: !r.querySelector('.now-tag') || r.querySelector('.now-tag').getBoundingClientRect().top >= tm.querySelector('small').getBoundingClientRect().bottom - 1, align: (() => { const b = r.querySelector('.c-song b'), rg = document.createRange(); rg.selectNodeContents(b); const tl = rg.getClientRects()[0], cl = clock.getClientRects()[0], base = (x, el) => x.bottom - 0.22 * parseFloat(getComputedStyle(el).fontSize); return Math.round((base(cl, clock) - base(tl, b)) * 10) / 10; })(), weight: getComputedStyle(tm).fontWeight, t24: clock.textContent, hidden12: getComputedStyle(tm.querySelector('.t12')).display === 'none', sameLine: !go.children.length || Math.abs((R(go).top + R(go).bottom) / 2 - (st.top + st.bottom) / 2) < 4, below: cnt.top >= st.bottom - 1, songRight: song.right <= R(go.children.length ? go : r.querySelector('.m-st')).left };
    }));
    check('Rows (360 px): 24-hour time (hh:mm) on one line, not bold, level with the first line of the title, the icon beside the status, the count below them, NOW under the date', lay.length && lay.every(x => x.timeLines === 1 && x.nowBelow && Math.abs(x.align) <= 1.5 && +x.weight < 600 && /^[0-2][0-9]:[0-5][0-9]$/.test(x.t24) && x.hidden12 && x.sameLine && x.below && x.songRight), JSON.stringify(lay.slice(0, 3)));
    const turn = el => el.evaluate(r => getComputedStyle(r.querySelector('.m-side .chev svg')).transform);
    const closedT = await turn(first);
    await first.locator('.c-time').click();
    const opened = s.page.locator('#plist .pr.open').first();
    const openT = await turn(opened);
    check('Rows: a round chevron shows open or closed, turned over while open (and the note preview gives way to the note)', closedT === 'none' && openT !== 'none' && await opened.locator('.lnote').isHidden(), closedT + ' / ' + openT);
    await opened.locator('.c-time').click();
    await s.page.click('.more-f');
    const grp = await s.page.evaluate(() => [...document.querySelectorAll('.fpanel .grp')].map(g => [...g.querySelectorAll('.chip')].map(c => c.classList.contains('zero') ? 0 : 1).join('')));
    check('All filters: Latest second, and filters with nothing in them dim at the end of their group', grp.length === 2 && grp.join('').indexOf('0') >= 0 && grp.every(g => /^1*0*$/.test(g)), JSON.stringify(grp));
    await s.page.click('[data-act="fdone"]');
    // More → Song lists: the whole note, none, and the album on a phone
    await tabTo(s.page, 'More');
    check('More (360 px): the theme swatches line up though Xmas Green takes two lines', await s.page.evaluate(() => new Set([...document.querySelectorAll('.theme i')].map(i => Math.round(i.getBoundingClientRect().top))).size === 1 && new Set([...document.querySelectorAll('.theme')].map(b => Math.round(b.getBoundingClientRect().height))).size === 1));
    await s.page.click('[data-act="listNotes"][data-v="all"]');
    await s.page.click('[data-act="listAlbum"][data-v="1"]');
    await tabTo(s.page, 'History');
    const all = await s.page.locator('#plist .pr:not(.ph)').first().evaluate(r => ({ t: (r.querySelector('.lnote.all') || {}).textContent, alb: getComputedStyle(r.querySelector('.alb')).display }));
    check('Song lists: the whole note, and the album on a phone, when chosen in More', all.t === 'First line of the note\nSecond line' && all.alb === 'block', JSON.stringify(all));
    await tabTo(s.page, 'More');
    await s.page.click('[data-act="listNotes"][data-v="off"]');
    await tabTo(s.page, 'History');
    const off = await s.page.locator('#plist .pr:not(.ph)').first().evaluate(r => ({ n: r.querySelectorAll('.lnote').length, icon: !!r.querySelector('.c-song .ic') }));
    check('Song lists: notes off leaves the ✎ beside the name', off.n === 0 && off.icon, JSON.stringify(off));
    await tabTo(s.page, 'Stats');
    const st3 = await s.page.evaluate(() => ({ tops: new Set([...document.querySelectorAll('.g3 .box')].map(b => Math.round(b.getBoundingClientRect().top))).size,
      io: [...document.querySelectorAll('.box.io')].map(b => { const pc = b.querySelector('b.big').getBoundingClientRect(), l = b.querySelector('.io-l'), lr = l.getBoundingClientRect();
        return { text: b.innerText.replace(/\s+/g, ' ').trim(), below: lr.top >= pc.bottom - 1, oneLine: l.getClientRects().length === 1 && lr.height < 24, dis: !!b.querySelector('.io-in.dis b.big'), weight: getComputedStyle(l).fontWeight }; }) }));
    const rep = await s.page.evaluate(() => { const kv = [...document.querySelectorAll('.kv')].find(x => /Between/.test(x.textContent)); return kv && [...kv.querySelectorAll('.lines > span')].map(x => ({ t: x.textContent, top: Math.round(x.getBoundingClientRect().top), bold: [...x.querySelectorAll('b')].map(b => b.textContent).join(' ') })); });
    check('Stats (360 px): "Between replays", the short name on a phone', await s.page.evaluate(() => [...document.querySelectorAll('.kv')].some(x => x.firstElementChild.innerText.trim() === 'Between replays')));
    check('Stats: the replay average and median each on a line of their own, only the figures bold', rep && rep.length === 2 && / average$/.test(rep[0].t) && / median$/.test(rep[1].t) && rep[1].top > rep[0].top && rep.every(x => /^[\d ]+$/.test(x.bold)), JSON.stringify(rep));
    check('Stats (360 px): the three playlist cards on one row', st3.tops === 1, String(st3.tops));
    const tl = await s.page.evaluate(() => { const b = document.querySelectorAll('.g3 .box')[1].querySelector('b.big'), box = b.parentElement.getBoundingClientRect(), w = [...document.querySelectorAll('.g3 .box')].map(x => Math.round(x.getBoundingClientRect().width));
      return { text: b.textContent, oneLine: b.getBoundingClientRect().height < parseFloat(getComputedStyle(b).fontSize) * 1.8, inside: b.scrollWidth <= b.clientWidth + 1 && b.getBoundingClientRect().right <= box.right, w }; });
    check('Stats (360 px): "9 h 38 min" on one line in a wider middle card', /^\d+ h \d+ min$/.test(tl.text) && tl.oneLine && tl.inside && tl.w[1] > tl.w[0] && tl.w[0] === tl.w[2], JSON.stringify(tl));
    const sh = await s.page.evaluate(() => { const kv = [...document.querySelectorAll('.kv')].find(x => /^Shortest/.test(x.textContent)); return kv && [...kv.querySelectorAll('.chunk')].map(c => ({ t: c.textContent, lines: Math.round(c.getBoundingClientRect().height / parseFloat(getComputedStyle(c).lineHeight || 18)) })); });
    check('Stats: Longest and Shortest titles wrap at " - " and before "(", each piece whole', sh && sh.length >= 2 && sh.every((c, k) => k || /·/.test(c.t)) && sh.some(c => /^Winter Wonderland$|^\(/.test(c.t)), JSON.stringify(sh));
    check('Stats (360 px): in playlist and disliked, laid out alike: the %, the words under it on one line (not bold), the count below', st3.io.length === 2
      && /^\d+% of songs in playlist \d+ of 60 \d+% of songs disliked \d+ of 60$/.test(st3.io[0].text) && /^\d+% of plays in playlist \d+ of 700 \d+% of plays disliked \d+ of 700$/.test(st3.io[1].text) && st3.io.every(x => x.below && x.oneLine && x.dis && x.weight === '400'), JSON.stringify(st3.io));
    const io600 = await (async () => { const w = await open(browser, { width: 600, path: '/stats' }); const r = await w.page.evaluate(() => [...document.querySelectorAll('.box.io')].map(b => ({ text: b.innerText.replace(/\s+/g, ' ').trim(), beside: b.querySelector('.io-l').getBoundingClientRect().left > b.querySelector('b.big').getBoundingClientRect().right }))); await w.ctx.close(); return r; })();
    check('Stats (600 px): the words beside the %', io600.length === 2 && io600.every(x => x.beside) && /of songs in your playlist/.test(io600[0].text), JSON.stringify(io600));
    check('No script errors (Nov 4 tweaks)', s.errors.length === 0, s.errors.join(' | '));
    await s.ctx.close();
    // History on a phone (Dan, Nov 5): the search box on the line with All ▾ while the filters are folded, its own line when open
    s = await open(browser, { width: 360, path: '/history' });
    const fl = () => s.page.evaluate(() => { const f = document.querySelector('#find'), m = document.querySelector('.more-f'), r = f.getBoundingClientRect();
      return { ph: f.placeholder, inRow: !!f.closest('.quick'), sameLine: !!m && Math.abs((r.top + r.bottom) / 2 - (m.getBoundingClientRect().top + m.getBoundingClientRect().bottom) / 2) <= 3, w: Math.round(r.width), right: Math.round(r.right), page: document.documentElement.scrollWidth }; });
    const f1 = await fl();
    check('History (360 px, a full second row): the search box beside All ▾, the hint shortened to "Search…" to fit', f1.ph === 'Search…' && f1.inRow && f1.sameLine && f1.w >= 60 && f1.right <= 360 && f1.page <= 360, JSON.stringify(f1));
    await s.page.fill('#find', 'rotation song 1');
    await s.page.waitForTimeout(300);
    const typed = await s.page.evaluate(() => ({ focus: document.activeElement && document.activeElement.id, rows: document.querySelectorAll('#plist .pr').length, first: (document.querySelector('#plist .pr[data-act]') || {}).textContent || '' }));
    check('History (360 px): searching there keeps the box focused and filters the list', typed.focus === 'find' && typed.rows > 0 && /Rotation Song 1/.test(typed.first), JSON.stringify(typed).slice(0, 200));
    await s.page.fill('#find', '');
    await s.page.click('.more-f'); await s.page.waitForTimeout(300);
    const f2 = await s.page.evaluate(() => { const f = document.querySelector('#find'); return { inRow: !!f.closest('.quick'), below: f.getBoundingClientRect().top >= document.querySelector('.fpanel').getBoundingClientRect().bottom - 1 }; });
    check('History (360 px): with all the filters open, the search box below them', !f2.inRow && f2.below, JSON.stringify(f2));
    await s.ctx.close();
    // Opening the site (Dan, Nov 6): the stored plays can be 10 minutes old; reading SomaFM's list records the rest, and the
    // page reads the plays again right after, so it shows what's on now well before the first live update
    const keptApi = api; api = freshApi(); api.staleUntilFeed = true;
    s = await open(browser, { width: 412, path: '/' });
    await s.page.waitForTimeout(1500);
    const opening = await s.page.evaluate(() => (document.querySelector('.hero h2') || {}).textContent || '');
    check('Opening the site: Now shows the latest play at once, not the recorder’s last look', opening.includes(hist[0][2]) && api.fed, JSON.stringify({ opening, want: hist[0][2] }));
    await s.ctx.close();
    api = keptApi;
    // Dan's Pixel 8 Pro (412 px), where All ▾ had a line to itself: the box beside it with the whole hint
    s = await open(browser, { width: 412, path: '/history' });
    const f3 = await fl();
    check('History (412 px): the search box beside All ▾, the whole hint where it fits', (f3.w >= 300 ? f3.ph === 'Search: song, artist, or album' : f3.w < 240 ? f3.ph === 'Search…' : true) && f3.inRow && f3.sameLine && f3.right <= 412 && f3.page <= 412, JSON.stringify(f3));
    // Tighter chips (Dan, Nov 6): with four-digit counts, All, Latest, In list, Not in list and ★ still share the first line,
    // All ▾ alone on the next (with the search); in All filters, the short category names on a phone
    const chipRow = await s.page.evaluate(() => { const v = ['1,388', '1,016', '372', '24']; [...document.querySelectorAll('.quick .chip .n')].forEach((n, i) => n.textContent = v[i]);
      const k = [...document.querySelectorAll('.quick .chip')], m = document.querySelector('.quick .more-f'), t = k.map(e => Math.round(e.getBoundingClientRect().top));
      return { n: k.length, oneLine: t.every(x => x === t[0]), moreBelow: m.getBoundingClientRect().top > t[0] + 10, right: Math.round(k[k.length - 1].getBoundingClientRect().right) }; });
    check('History (412 px): the five first-row chips on one line with four-digit counts, All ▾ on the next', chipRow.n === 5 && chipRow.oneLine && chipRow.moreBelow && chipRow.right <= 412 - 16, JSON.stringify(chipRow));
    await s.page.click('.more-f'); await s.page.waitForTimeout(300);
    const catNames = await s.page.evaluate(() => [...document.querySelectorAll('.fpanel [data-act=fcat]')].map(e => e.innerText.replace(/\s*\d+$/, '').trim()));
    check('History (412 px): All filters shows Swing, Jazz and Funk for the categories', ['Swing', 'Jazz', 'Funk', 'Classics', 'No category'].every(x => catNames.includes(x)) && !catNames.some(x => /\//.test(x)), JSON.stringify(catNames));
    // Stats on the phone: "avg song", Latest replays on the heading's line, Time recorded on two lines
    await tabTo(s.page, 'Stats');
    await s.page.click('[data-act=topSort][data-v=recent]'); await s.page.waitForTimeout(300);
    const st412 = await s.page.evaluate(() => { const h = [...document.querySelectorAll('h3')].find(e => e.querySelector('.seg')), tt = h.firstElementChild.getBoundingClientRect(), sg = h.querySelector('.seg').getBoundingClientRect();
      const avg = [...document.querySelectorAll('.box .k')].find(e => /avg/.test(e.innerText)), rec = document.querySelector('.ph2');
      return { title: h.firstElementChild.innerText, oneLine: Math.abs(tt.top + tt.height / 2 - (sg.top + sg.height / 2)) <= 6 && tt.height < 26, avg: avg && avg.innerText, avgLines: avg && Math.round(avg.getBoundingClientRect().height / parseFloat(getComputedStyle(avg).lineHeight)), rec: rec && rec.innerText.split('\n') }; });
    check('Stats (412 px): "avg song" on one line, "Latest replays" beside its sort, Time recorded as total then songs an hour', st412.avg === 'avg song' && st412.avgLines === 1 && st412.title === 'Latest replays' && st412.oneLine && st412.rec && st412.rec.length === 2 && / h /.test(st412.rec[0]) && /songs an hour$/.test(st412.rec[1]), JSON.stringify(st412));
    // "until a song comes back" is the measured average between replays (Dan, Nov 6), the same as that row's average
    const back = await s.page.evaluate(() => { const tile = [...document.querySelectorAll('.box')].find(b => /until a song comes back/.test(b.innerText)), row = [...document.querySelectorAll('.kv')].find(k => /Between/.test(k.innerText));
      const m = /(?:(\d+) h )?(\d+) min average/.exec(row.innerText.replace(/\s+/g, ' ')); return { tile: tile.querySelector('b.big').innerText, avgH: m ? ((+m[1] || 0) + +m[2] / 60) : null, note: /measured average time between a song's replays/.test(document.body.innerText) }; });
    check('Stats: "until a song comes back" is the measured average between replays', back.avgH !== null && Math.abs(parseFloat(back.tile) - back.avgH) <= 0.06 && back.note, JSON.stringify(back));
    await s.ctx.close();
    // Listen (Dan, Nov 5): the station's stream from the bar of pages. Playing is stood in for (no sound here): the first
    // server refuses, so the next one is tried; the phone's media controls get the song and its picture.
    s = await open(browser, { width: 360, init: () => {
      window.__plays = []; window.__opened = [];
      const vd = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
      Object.defineProperty(HTMLMediaElement.prototype, 'volume', { configurable: true, get() { return vd.get.call(this); }, set(v) { window.__vol = v; vd.set.call(this, v); } });
      window.open = (u, n, f) => { window.__opened.push([u, n, f || '']); return {}; };
      HTMLMediaElement.prototype.play = function () {
        const src = this.getAttribute('src') || ''; window.__plays.push(src);
        setTimeout(() => this.dispatchEvent(new Event(window.__failAll || /ice6\./.test(src) ? 'error' : 'playing')), 50);
        return Promise.resolve();
      };
    } });
    const pframe = () => s.page.frames().find(f => f.url().startsWith('https://lounge-player.'));
    const fplays = async () => { const f = pframe(); return f ? f.evaluate(() => window.__plays.slice()) : []; };
    const fmeta = async () => { const f = pframe(); return f ? f.evaluate(() => { const m = navigator.mediaSession.metadata; return m ? { title: m.title, art: (m.artwork[0] || {}).src, state: navigator.mediaSession.playbackState } : { state: navigator.mediaSession.playbackState }; }) : null; };
    const bar = async () => Object.assign(await s.page.evaluate(() => { const b = document.querySelector('.tabs .listen'), items = [...document.querySelectorAll('.tabs a, .tabs .listen')];
      const md = navigator.mediaSession && navigator.mediaSession.metadata;
      return { text: b && b.textContent.trim(), cls: b && b.className, pressed: b && b.getAttribute('aria-pressed'), plays: window.__plays.slice(), right: Math.max(...items.map(i => i.getBoundingClientRect().right)), top: new Set(items.map(i => Math.round(i.getBoundingClientRect().top))).size,
        meta: md ? { title: md.title, artist: md.artist, art: (md.artwork[0] || {}).src } : null, state: navigator.mediaSession && navigator.mediaSession.playbackState, hero: ((document.querySelector('.hero h2 > span') || {}).textContent || '').replace(/[★☆]$/, ''),
        heroVid: ((document.querySelector('.hero .hthumb img') || {}).src || '') }; }), { plays: await fplays(), direct: await s.page.evaluate(() => window.__plays.length) });
    const l0 = await bar();
    const fr = await s.page.evaluate(() => { const f = document.querySelector('iframe[src^="https://lounge-player."]'); const r = f && f.getBoundingClientRect(); return f && { allow: f.allow, w: r.width, op: getComputedStyle(f).opacity, hidden: f.getAttribute('aria-hidden') }; });
    check('Listen: the player page on workers.dev sits in an invisible frame, allowed to play sound', !!fr && fr.allow === 'autoplay' && fr.w <= 1 && fr.op === '0' && fr.hidden === 'true', JSON.stringify(fr));
    check('Listen (360 px): in the bar of pages beside the five pages, all on one line inside the window', l0.text === 'Listen' && l0.pressed === 'false' && l0.top === 1 && l0.right <= 360, JSON.stringify(l0));
    { // The "pop" when the page changes (as in the EPGSA app): a ghost pill grows behind the new page's icon, then goes
      const p0 = await s.page.evaluate(() => !!document.querySelector(".nav-ghost"));
      await s.page.click(".tabs a:has-text(\"Stats\")"); await s.page.waitForTimeout(60);
      const p1 = await s.page.evaluate(() => { const g = document.querySelector(".nav-ghost"), a = document.querySelector(".tabs a.on"); return { ghost: !!g, ghosted: !!(a && a.classList.contains("nav-ghosted")), on: a && a.textContent.trim() }; });
      await s.page.waitForTimeout(500);
      const p2 = await s.page.evaluate(() => ({ ghost: !!document.querySelector(".nav-ghost"), ghosted: !!document.querySelector(".tabs a.nav-ghosted"), bg: getComputedStyle(document.querySelector(".tabs a.on svg")).backgroundColor }));
      check("Bar: a new page pops in (a ghost pill grows behind it, then the real pill is back); none on first load", !p0 && p1.ghost && p1.ghosted && p1.on === "Stats" && !p2.ghost && !p2.ghosted && p2.bg !== "rgba(0, 0, 0, 0)", JSON.stringify([p0, p1, p2]));
      await tabTo(s.page, "Now"); await s.page.waitForTimeout(400); }
    await s.page.click('.tabs .listen'); await s.page.waitForTimeout(400);
    const l1 = await bar();
    check('Listen: plays SomaFM\'s stream from the player page (not the site), on to the next server when one refuses; the button turns to Stop', l1.direct === 0 && l1.text === 'Stop' && /\bon\b/.test(l1.cls) && l1.plays.length === 2 && /^https:\/\/ice6\.somafm\.com\/christmas-/.test(l1.plays[0]) && /^https:\/\/ice2\.somafm\.com\/christmas-/.test(l1.plays[1]), JSON.stringify(l1));
    check('Listen: the phone\'s media controls show the song playing, with its video\'s picture when it\'s in the playlist', !!l1.meta && l1.meta.title === l1.hero && l1.state === 'playing' && (l1.heroVid ? l1.meta.art === l1.heroVid : /somafm\.com\/logos/.test(l1.meta.art)), JSON.stringify(l1.meta) + ' ' + l1.heroVid);
    const fm = await fmeta();
    check('Listen: the player page gets the song too (the controls of a phone read it from where the sound plays)', !!fm && fm.title === l1.hero && fm.state === 'playing', JSON.stringify(fm));
    await tabTo(s.page, 'History');
    const l2 = await bar();
    check('Listen: keeps playing on another page', l2.text === 'Stop' && l2.plays.length === 2, JSON.stringify(l2));
    // While it plays, the bar's Listen is white like the Now card's Listen, not the accent of the page you're on (Dan, Nov 6)
    const lic = await s.page.evaluate(() => ({ on: getComputedStyle(document.querySelector('.tabs .listen.on .lic')).backgroundColor, page: getComputedStyle(document.querySelector('.tabs a.on svg')).backgroundColor }));
    check('Listen: white in the bar while it plays, unlike the current page’s pill', lic.on === 'rgb(255, 255, 255)' && lic.page !== lic.on, JSON.stringify(lic));
    await s.page.click('.tabs .listen'); await s.page.waitForTimeout(200);
    const l3 = await s.page.evaluate(() => ({ text: document.querySelector('.tabs .listen').textContent.trim(), state: navigator.mediaSession.playbackState }));
    const fm3 = await fmeta();
    check('Listen: Stop lets the stream go', l3.text === 'Listen' && l3.state === 'none' && fm3.state === 'none', JSON.stringify(l3) + JSON.stringify(fm3));
    // A device where none of the servers plays (Dan's TV): it stops, and the Now page says what each try came to
    await tabTo(s.page, 'Now');
    await pframe().evaluate(() => { window.__failAll = true; });
    await s.page.click('.tabs .listen'); await s.page.waitForTimeout(800);
    const l4 = await s.page.evaluate(() => { const w = document.querySelector('.listen-fail'); return { text: document.querySelector('.tabs .listen').textContent.trim(), box: !!w, open: !!(w && w.querySelector('[data-act="listenSoma"]')), lines: w ? w.querySelector('pre').textContent.split('\n') : [] }; });
    check('Listen: when no server plays, it stops, the Now page shows each try and offers SomaFM\'s player; the button becomes Listen ↗', l4.text === 'Listen ↗' && l4.box && l4.open && l4.lines.filter(l => /^ice\d \d+-\w+ — error/.test(l)).length >= 3 && /audio\/mpeg: /.test(l4.lines.join(' ')), JSON.stringify(l4));
    await s.page.click('.listen-fail [data-act="listenSoma"]'); await s.page.waitForTimeout(200);
    await s.page.click('.tabs .listen'); await s.page.waitForTimeout(200);
    const l5 = await s.page.evaluate(() => ({ box: !!document.querySelector('.listen-fail'), opened: window.__opened, plays: window.__plays.length, kept: localStorage.getItem('xl:listenVia2') }));
    check('Listen ↗: opens SomaFM\'s player in a tab (the same one each time), not the stream; remembered on the device', !l5.box && l5.opened.length === 2 && l5.opened.every(o => o[0] === 'https://somafm.com/player24/station/christmas' && o[1] === 'somafm-player' && !o[2]) && l5.kept === '"somafm"', JSON.stringify(l5));
    // More → Listen → Here: back to playing inside the site
    await pframe().evaluate(() => { window.__failAll = false; });
    await tabTo(s.page, 'More');
    await s.page.click('[data-act="listenVia"][data-v=""]'); await s.page.waitForTimeout(200);
    await s.page.click('.tabs .listen'); await s.page.waitForTimeout(400);
    const l6 = await s.page.evaluate(() => ({ text: document.querySelector('.tabs .listen').textContent.trim(), kept: localStorage.getItem('xl:listenVia2'), here: (document.querySelector('[data-act="listenVia"][data-v=""]') || {}).className }));
    check('More → Listen → Here plays inside the site again', l6.text === 'Stop' && l6.kept === null && /\bon\b/.test(l6.here), JSON.stringify(l6));
    await s.page.click('.tabs .listen');
    const man = await s.page.evaluate(async () => { const l = document.querySelector('link[rel="manifest"]'); const m = await (await fetch(l.href, { credentials: 'include' })).json();
      const ok = await Promise.all(m.icons.map(async i => { const r = await fetch(i.src); const b = await createImageBitmap(await r.blob()); return b.width + 'x' + b.height === i.sizes; }));
      return { cred: l.crossOrigin, name: m.name, display: m.display, start: m.start_url, icons: ok, maskable: m.icons.some(i => i.purpose === 'maskable') }; });
    check('Installable: a manifest (read with the sign-in cookie), standalone, its icons the sizes it says', man.cred === 'use-credentials' && man.name === 'Christmas Lounge' && man.display === 'standalone' && man.start === '/' && man.icons.length >= 3 && man.icons.every(Boolean) && man.maskable, JSON.stringify(man));
    { // The public install page (for PWABuilder and the like): names the manifest, and everything it uses is a real file
      const ip = fs.readFileSync(path.join(APP, "install", "index.html"), "utf8");
      const used = [...ip.matchAll(/(?:href|src)="(\/[^"]*)"/g)].map(m => m[1]).filter(u => u !== "/");
      check("Install page: links the manifest, and its icons and manifest exist", /<link rel="manifest" href="\/manifest\.webmanifest">/.test(ip) && used.every(u => fs.existsSync(path.join(APP, u))), used.join(" ")); }
      const al = JSON.parse(fs.readFileSync(path.join(APP, ".well-known", "assetlinks.json"), "utf8"))[0];
      check("Android app link: assetlinks.json names the PWABuilder package and its key", al.target.package_name === "fyi.zamulagh.xmaslounge" && /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(al.target.sha256_cert_fingerprints[0]), JSON.stringify(al));
    // Listen on the Now Playing card: first in its row of buttons, short words on a phone; the volume under them while it
    // plays. No Note button since Nov 6 (Dan: Add a note is in the opened card), so "YouTube" fits in full on a phone
    await tabTo(s.page, 'Now');
    const acts = () => s.page.evaluate(() => { const kids = [...document.querySelectorAll('.hero .acts > *')], hero = document.querySelector('.hero').getBoundingClientRect(), r = document.getElementById('hlisten');
      const shown = el => [...el.querySelectorAll('.lw, .ln')].filter(x => x.offsetWidth).map(x => x.textContent).join('') || el.textContent.trim();
      return { first: kids[0] && kids[0].id, labels: kids.map(shown), lines: new Set(kids.map(k => Math.round(k.getBoundingClientRect().top))).size, right: Math.max(...kids.map(k => k.getBoundingClientRect().right)), edge: hero.right,
        vol: !!(r && r.querySelector('#vol')), volRight: r && r.querySelector('#vol') ? r.getBoundingClientRect().right : 0, bar: document.querySelector('.tabs .listen').textContent.trim(),
        ytColor: (() => { const y = document.querySelector('.hero .acts .yt svg .ytbg'); return y ? y.getAttribute('fill') : ''; })(), listenSolid: document.getElementById('hlbtn').classList.contains('solid') }; });
    const h0 = await acts();
    check('Now card (360 px): Listen first in the row of buttons, "Listen", "YouTube" (no Note) and the plays as "14×" on a phone, all on one line; no volume while it isn\'t playing', h0.first === 'hlbtn' && h0.labels[0] === 'Listen' && h0.labels.includes('YouTube') && !h0.labels.some(l => /Note/.test(l)) && /^[0-9]+×$/.test(h0.labels[h0.labels.length - 1]) && h0.lines === 1 && h0.right <= h0.edge && !h0.vol, JSON.stringify(h0));
    check('Now card: the YouTube mark is YouTube\'s red with a white ▶; Listen has the highlight', h0.ytColor === '#f00' && h0.listenSolid, JSON.stringify(h0));
    const rowYt = await s.page.evaluate(() => { const b = document.querySelector('.plays .icon.open'), c = document.querySelector('.plays .icon:not(.open)'); return b && { bg: getComputedStyle(b).backgroundColor, plain: c && getComputedStyle(c).backgroundColor, rect: b.querySelector('.ytbg') && b.querySelector('.ytbg').getAttribute('fill') }; });
    check('Song rows: the open button is the small red YouTube mark on the plain round button (like the search one)', !!rowYt && rowYt.rect === '#f00' && (!rowYt.plain || rowYt.bg === rowYt.plain), JSON.stringify(rowYt));
    await s.page.click('#hlbtn'); await s.page.waitForTimeout(400);
    const h1 = await acts();
    check('Now card (360 px): Listen there plays (the bar agrees), its button turns to Stop, and a volume slider shows under the buttons', h1.labels[0] === 'Stop' && h1.bar === 'Stop' && h1.lines === 1 && h1.vol && h1.volRight <= h1.edge, JSON.stringify(h1));
    await s.page.evaluate(() => { const v = document.getElementById('vol'); v.value = '40'; v.dispatchEvent(new Event('input', { bubbles: true })); });
    await s.page.click('#vol'); await s.page.waitForTimeout(300);
    const h2 = await s.page.evaluate(() => ({ label: document.getElementById('volv').textContent, kept: localStorage.getItem('xl:volume'), open: document.querySelector('.hero').classList.contains('open') }));
    const fv = await pframe().evaluate(() => window.__vol);
    check('Volume: sets the player\'s volume (in the player page), kept on the device; tapping the slider doesn\'t open the card', /%$/.test(h2.label) && Number(h2.kept) >= 0 && Math.abs(fv - Number(h2.kept) / 100) < 0.011 && !h2.open, JSON.stringify(h2) + ' frame ' + fv);
    await s.page.click('#hlbtn'); await s.page.waitForTimeout(300);
    const h3 = await acts();
    check('Now card: Stop there stops it (the bar agrees) and the volume goes', h3.labels[0] === 'Listen' && h3.bar === 'Listen' && !h3.vol, JSON.stringify(h3));
    check('No script errors (Listen)', s.errors.length === 0, s.errors.join(' | '));
    await s.ctx.close();
    // Cast (Dan, Nov 5): Google's sender library stood in for, with one Chromecast "Living Room TV" on the network
    s = await open(browser, { width: 360, init: () => {
      HTMLMediaElement.prototype.play = function () { setTimeout(() => this.dispatchEvent(new Event('playing')), 30); return Promise.resolve(); };
      window.__cast = { loads: [], requested: 0, ended: 0 };
      const ls = {}, fire = (t, e) => (ls[t] || []).forEach(f => f(e));
      let state = 'NOT_CONNECTED', session = null;
      const ctx = { setOptions() {}, getCastState: () => state, getCurrentSession: () => session, addEventListener(t, f) { (ls[t] = ls[t] || []).push(f); },
        requestSession() {
          window.__cast.requested++;
          session = { getCastDevice: () => ({ friendlyName: 'Living Room TV' }), loadMedia(req) { const m = req.media; window.__cast.loads.push({ url: m.contentId, type: m.contentType, live: m.streamType, title: m.metadata.title, artist: m.metadata.artist, img: m.metadata.images[0].url, autoplay: req.autoplay }); return Promise.resolve(); } };
          state = 'CONNECTED'; fire('cs', {}); fire('ss', { sessionState: 'SESSION_STARTED', session }); return Promise.resolve();
        },
        endCurrentSession() { window.__cast.ended++; session = null; state = 'NOT_CONNECTED'; fire('ss', { sessionState: 'SESSION_ENDED' }); fire('cs', {}); } };
      window.cast = { framework: { CastState: { NO_DEVICES_AVAILABLE: 'NO_DEVICES_AVAILABLE', NOT_CONNECTED: 'NOT_CONNECTED', CONNECTED: 'CONNECTED' }, SessionState: { SESSION_STARTED: 'SESSION_STARTED', SESSION_ENDED: 'SESSION_ENDED' },
        CastContextEventType: { CAST_STATE_CHANGED: 'cs', SESSION_STATE_CHANGED: 'ss' }, CastContext: { getInstance: () => ctx } } };
      window.chrome = Object.assign(window.chrome || {}, { cast: { AutoJoinPolicy: { ORIGIN_SCOPED: 'origin_scoped' }, Image: function (u) { this.url = u; },
        media: { DEFAULT_MEDIA_RECEIVER_APP_ID: 'CC1AD845', StreamType: { LIVE: 'LIVE' }, MediaInfo: function (id, type) { this.contentId = id; this.contentType = type; }, MusicTrackMediaMetadata: function () {}, LoadRequest: function (m) { this.media = m; } } } });
    } });
    await s.page.waitForTimeout(300);
    const c0 = await s.page.evaluate(() => { const b = document.getElementById('castbtn'), h = document.querySelector('.hero').getBoundingClientRect(), t = document.querySelector('.hero-top').children;
      return b && { tag: b.tagName, right: b.getBoundingClientRect().right, edge: h.right, lines: new Set([...t].map(x => Math.round(x.getBoundingClientRect().top + x.getBoundingClientRect().height / 2))).size }; });
    check('Cast (360 px): a cast button on the card\'s top line when a Chromecast is around, inside the card', !!c0 && c0.tag === 'BUTTON' && c0.right <= c0.edge && c0.lines === 1, JSON.stringify(c0));
    await s.page.click('#hlbtn'); await s.page.waitForTimeout(300);
    await s.page.click('#castbtn'); await s.page.waitForTimeout(400);
    const c1 = await s.page.evaluate(() => ({ cast: window.__cast, on: document.getElementById('castbtn').classList.contains('on'), listen: document.getElementById('hlbtn').textContent.trim(), hero: ((document.querySelector('.hero h2 > span') || {}).textContent || '').replace(/[★☆]$/, '') }));
    const ld = c1.cast.loads[0] || {};
    check('Cast: asks for a device, then the Chromecast plays SomaFM\'s stream itself (live, with the song); Listen here stops', c1.cast.requested === 1 && /^https:\/\/ice\d\.somafm\.com\/christmas-256-mp3$/.test(ld.url) && ld.type === 'audio/mpeg' && ld.live === 'LIVE' && ld.title === c1.hero && ld.autoplay === true && c1.on && /Listen/.test(c1.listen), JSON.stringify(c1));
    await s.page.click('#castbtn'); await s.page.waitForTimeout(300);
    const c2 = await s.page.evaluate(() => ({ ended: window.__cast.ended, on: document.getElementById('castbtn').classList.contains('on') }));
    check('Cast: tapping it again stops casting', c2.ended === 1 && !c2.on, JSON.stringify(c2));
    check('No script errors (Cast)', s.errors.length === 0, s.errors.join(' | '));
    await s.ctx.close();
    // Where the player page can't load, the site plays the stream itself
    s = await open(browser, { width: 360, noPlayer: true, init: () => {
      window.__plays = [];
      HTMLMediaElement.prototype.play = function () { const src = this.getAttribute('src') || ''; window.__plays.push(src); setTimeout(() => this.dispatchEvent(new Event('playing')), 50); return Promise.resolve(); };
    } });
    await s.page.click('.tabs .listen'); await s.page.waitForTimeout(400);
    const l7 = await s.page.evaluate(() => ({ text: document.querySelector('.tabs .listen').textContent.trim(), plays: window.__plays.slice() }));
    await s.ctx.close();
    // On Dan's own domain SomaFM plays to the site itself: no player frame there
    s = await open(browser, { width: 360, site: 'https://xmaslounge.zamulagh.fyi/', init: () => {
      window.__plays = [];
      HTMLMediaElement.prototype.play = function () { window.__plays.push(this.getAttribute('src') || ''); setTimeout(() => this.dispatchEvent(new Event('playing')), 50); return Promise.resolve(); };
    } });
    await s.page.click('.tabs .listen'); await s.page.waitForTimeout(400);
    const l8 = await s.page.evaluate(() => ({ frame: !!document.querySelector('iframe[src^="https://lounge-player."]'), text: document.querySelector('.tabs .listen').textContent.trim(), plays: window.__plays.slice() }));
    check('Listen on xmaslounge.zamulagh.fyi: no player frame, the site plays the stream itself', !l8.frame && l8.text === 'Stop' && l8.plays.length === 1 && /^https:\/\/ice6\.somafm\.com\//.test(l8.plays[0]), JSON.stringify(l8));
    check('Listen: without the player page, the site plays the stream itself', l7.text === 'Stop' && l7.plays.length === 1 && /^https:\/\/ice6\.somafm\.com\//.test(l7.plays[0]), JSON.stringify(l7));
    await s.ctx.close();
    // Shuffle on a phone, with the original order saved: nothing wider than the window, the reset time wraps before its "(…)"
    api.doc.original = { at: Date.now() - 864e5 * 9, playlistId: 'PLRpb0eQM5sYC0-Fhol0BnOwYygZy_UTyt', songs: items.slice(0, 40).map((it, k) => ({ id: 'pi' + k, videoId: it.id, title: it.title })) };
    s = await open(browser, { width: 360, path: '/shuffle' });
    await s.page.waitForTimeout(400);
    const shOver = await overflow(s.page);
    const sh360 = await s.page.evaluate(() => { const dl = document.querySelector('[data-act="shDownload"]'), kv = [...document.querySelectorAll('.kv')].find(x => /^Resets/.test(x.textContent)), par = kv && kv.querySelector('.nw');
      return { dl: dl && dl.getBoundingClientRect().right <= document.documentElement.clientWidth, par: par && par.getClientRects().length === 1 && /^\(.*\)$/.test(par.textContent), text: (document.querySelector('.box .k') || {}).textContent }; });
    check('Shuffle (360 px): fits the window, Download in sight, the reset time\'s "(…)" kept whole, the short sign-in line', !shOver.length && sh360.dl && sh360.par && sh360.text === 'Sign in with the Google account that owns Xmas Mixed.', JSON.stringify({ shOver, sh360 }));
    await s.ctx.close();
    delete api.doc.original;
    // Not in playlist is left off the first row while there are none: every such song disliked
    const saved = JSON.parse(JSON.stringify(api.doc));
    for (const p of hist) { const k = X.markKey(p[1], p[2]); const st = X.check(p[1], p[2], items).status; if (st === 'other') api.doc.marks[k] = { v: 'have', at: Date.now() }; else if (st !== 'have') api.doc.dislikes[k] = Date.now(); }
    delete api.doc.archive.goneVideo1;   // a song gone from the playlist counts as not in it too
    s = await open(browser, { path: '/history' });
    const nz = await s.page.evaluate(() => ({ quick: [...document.querySelectorAll('.quick .chip')].map(c => c.dataset.v || c.dataset.act).join(), none: (document.querySelector('.quick [data-v="none"]') || {}).outerHTML }));
    await s.page.click('.more-f');
    const nzPanel = await s.page.evaluate(() => { const c = document.querySelector('.fpanel [data-v="none"]'); return c && { zero: c.classList.contains('zero'), last: c === [...c.parentElement.children].pop() || c.nextElementSibling.classList.contains('zero') }; });
    check('Filters: Not in playlist left off the first row with none in it, dim at the end in All filters', !nz.none && nzPanel && nzPanel.zero && nzPanel.last, JSON.stringify({ nz, nzPanel }));
    await tabTo(s.page, 'Stats');
    const sb = await s.page.evaluate(() => ({ rows: [...document.querySelectorAll('.kv.stat')].map(x => x.textContent).join('|') || 0, cards: document.querySelectorAll('.box.io').length }));
    check('Stats: no Songs by status box when nothing is an other version or not in the playlist (the cards stay)', sb.rows === 0 && sb.cards === 2, JSON.stringify(sb));
    check('Stats: no "Most played that you don\'t have" when there are none', await s.page.evaluate(() => ![...document.querySelectorAll('h3')].some(h => /that you don't have/.test(h.textContent)) && !/Nothing to find/.test(document.body.textContent)));
    await s.ctx.close();
    api.doc = saved;
  }

  // Every page at three widths, in each theme and in dark mode: nothing wider than the window
  for (const [width, scheme, theme] of [[1024, 'light', undefined], [600, 'light', undefined], [600, 'dark', undefined], [360, 'light', undefined], [360, 'dark', 'candy'], [600, 'light', 'candy'], [600, 'dark', 'evergreen']]) {
    s = await open(browser, { width, scheme, theme, height: 900 });
    const bad = [];
    for (const tab of ['Now', 'History', 'Stats', 'Shuffle', 'More']) {
      await tabTo(s.page, tab);
      if (tab === 'History') { await s.page.locator('#plist .pr:not(.ph)').nth(1).click(); await s.page.waitForTimeout(150); }
      const o = await overflow(s.page);
      if (o.length) bad.push(tab + ': ' + o.join(', '));
      // SHOTS=<folder> saves each page, to look at
      if (process.env.SHOTS) await s.page.screenshot({ path: path.join(process.env.SHOTS, `${width}-${theme || scheme}-${tab.toLowerCase()}.png`), fullPage: true });
    }
    const look = await s.page.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor, table: getComputedStyle(document.querySelector('.tabs')).position }));
    check(`Layout ${width} px ${theme || 'Midnight'} (device ${scheme}): every page fits, an open row too`, !bad.length && look.table === 'fixed', bad.join(' | '));
    if (width === 1024) {
      await tabTo(s.page, 'History');
      const cols = await s.page.evaluate(() => getComputedStyle(document.querySelector('.pr.ph')).display !== 'none' && [...document.querySelectorAll('.pr.ph div')].map(x => x.textContent).join());
      check('History from 900 px: a table, Time | Song | Status | Category | Plays | Actions', cols === 'Time,Song,Status,Category,Plays,Actions', String(cols));
      const full = await s.page.evaluate(() => [...document.querySelectorAll('#plist .pr:not(.ph) .c-status .stl')].slice(0, 5).map(x => Math.round(x.getBoundingClientRect().width)));
      check('History from 900 px: the status in words where it fits', full.length && full.every(w => w > 30), JSON.stringify(full));
      // The half-width Just played on a wide screen (Dan's TV, Nov 6): column names and Category, the status as its dot;
      // Open and Search on a subtle tint
      await tabTo(s.page, 'Now');
      const half = await s.page.evaluate(() => { const l = document.querySelector('.plays'), h = l.querySelector('.pr.ph'), row = l.querySelector('.pr:not(.ph)'), ic = l.querySelector('.c-go .icon');
        return { w: Math.round(l.getBoundingClientRect().width), head: h.innerText.replace(/\s+/g, ' ').trim(), dot: Math.round(row.querySelector('.m-side .stl').getBoundingClientRect().width), cat: row.querySelector('.c-cat').getBoundingClientRect().width > 0, bg: getComputedStyle(ic).backgroundColor, card: getComputedStyle(l).backgroundColor }; });
      check('Now (1024 px): Just played, half width, with Time, Song, Category names and the status as its dot; Open/Search tinted', half.w < 860 && /^Time Song Category$/i.test(half.head) && half.dot <= 1 && half.cat && half.bg !== half.card && !/rgba\(0, 0, 0, 0\)/.test(half.bg), JSON.stringify(half));
      await tabTo(s.page, 'History');
    }
    if (!theme) check(`Midnight, dark, whatever the device is set to (${scheme})`, look.bg === 'rgb(11, 16, 32)', look.bg);
    if (theme === 'candy') check('Xmas Red (saved as candy), a dark theme, remembered', look.bg === 'rgb(25, 17, 19)', look.bg);
    if (width === 360) {
      check('Phone (360 px): the Now card leaves the category out', await s.page.evaluate(() => { const c = document.querySelector('.hero .hcat'); return !c || c.getBoundingClientRect().width === 0; }));
      await tabTo(s.page, 'History');
      const dots = await s.page.evaluate(() => [...document.querySelectorAll('#plist .m-side .st')].slice(0, 5).map(x => ({ w: Math.round(x.querySelector('.stl').getBoundingClientRect().width), name: x.textContent })));
      const cut = await s.page.evaluate(() => [...document.querySelectorAll('#plist .c-song b, #plist .c-song .by')].filter(e => e.scrollWidth > e.clientWidth + 1).length);
      check('Phone (360 px): song names and artists wrap, none cut off', cut === 0, String(cut));
      check('Phone (360 px): rows without column names', await s.page.evaluate(() => document.querySelector('#plist .pr.ph').getBoundingClientRect().height === 0));
      check('Phone (360 px): History rows show the status as its dot alone, the name kept for screen readers', dots.length && dots.every(d => d.w <= 1 && d.name.length > 1), JSON.stringify(dots));
    }
    if (width === 600 && !theme && scheme === 'light') {
      await tabTo(s.page, 'History');
      // Tablet (Dan, Nov 6): the rows as on a phone (Open/Search, the status as its dot, plays and chevron at the right end)
      // plus a Category column with the short names, and names over Time, Song and Category; on Now too
      const tab = () => s.page.evaluate(() => { const l = document.querySelector('#plist .plays') || document.querySelector('.plays'), h = l.querySelector('.pr.ph'), rows = [...l.querySelectorAll('.pr:not(.ph)')].slice(0, 12);
        return { head: h && h.getBoundingClientRect().height > 0 ? h.innerText.replace(/\s+/g, ' ').trim() : '', dots: rows.map(x => Math.round(x.querySelector('.m-side .stl').getBoundingClientRect().width)), cols: rows.some(x => ['.c-status', '.c-plays', '.c-act'].some(c => x.querySelector(c).getBoundingClientRect().width > 0)), side: rows.every(x => x.querySelector('.m-side').getBoundingClientRect().width > 0),
          cats: rows.map(x => x.querySelector('.c-cat').innerText.trim()), song: Math.round(rows[0].querySelector('.c-song').getBoundingClientRect().width),
          lined: rows.every(x => Math.abs(x.querySelector('.c-cat').getBoundingClientRect().left - h.children[3].getBoundingClientRect().left) <= 1) }; });
      const th = await tab();
      check('Tablet (600 px): History rows as on a phone plus Category (short names), names over Time, Song, Category', /^Time Song Category$/i.test(th.head) && !th.cols && th.dots.every(w => w <= 1) && th.side && th.cats.every(c => /^(—|Swing|Classics|Dance|Jazz|Mellow|Funk|)$/.test(c)) && th.cats.includes('') && th.song >= 250 && th.lined, JSON.stringify(th));
      await tabTo(s.page, 'Now');
      const tn = await tab();
      // The Now card's category above its play count, on the tablet (Dan, Nov 6)
      // Nothing at all for a song without one (Dan, Nov 6: rather nothing than "No category"), here and in the lists
      const heroCat = () => s.page.evaluate(() => { const c = document.querySelector('.hero .hcat'), p = document.querySelector('.hero .hct > span:last-child'); if (!c) return { none: !/No category/.test(document.querySelector('.hero').textContent) }; const a = c.getBoundingClientRect(), b = p.getBoundingClientRect();
        return { text: c.textContent, above: a.bottom <= b.top + 1 && a.width > 0, right: Math.abs(a.right - b.right) <= 1 }; });
      const nowItem = items.find(it => { const m = it.title.split(' - '), a = m.length > 1 ? [m[0], m[1]] : [it.ch.replace(/ - Topic$/, ''), it.title]; return a[0] === hist[0][1] && a[1] === hist[0][2]; });
      const hc0 = await heroCat();
      const keptCats = api.doc.categories;
      api.doc.categories = Object.assign({}, keptCats, { [nowItem.id]: { c: 'jazz', at: Date.now() } }); api.version++;
      await s.page.reload({ waitUntil: 'load' }); await s.page.waitForSelector('.hero'); await s.page.waitForTimeout(800);
      const hc = await heroCat();
      api.doc.categories = keptCats; api.version++;
      await s.page.reload({ waitUntil: 'load' }); await s.page.waitForSelector('.hero'); await s.page.waitForTimeout(800);
      check('Tablet (600 px): the Now card shows the song’s category above its play count, and nothing without one', hc.text === 'Jazz/Piano' && hc.above && hc.right && hc0.none === true && !hc0.text, JSON.stringify({ hc, hc0 }));
      // Opened, the Now card's details hang from it as one piece (Dan, Nov 6)
      await s.page.click('.hero .hero-top small'); await s.page.waitForTimeout(300);
      const joined = await s.page.evaluate(() => { const h = document.querySelector('.hero'), d = document.querySelector('.hero-detail .detail'); if (!d) return null; const a = h.getBoundingClientRect(), b = d.getBoundingClientRect(), hs = getComputedStyle(h), ds = getComputedStyle(d);
        return { touch: Math.abs(b.top - a.bottom) <= 1, sameWidth: Math.abs(a.width - b.width) <= 1, heroBottom: hs.borderBottomLeftRadius, detailTop: ds.borderTopLeftRadius, detailBottom: ds.borderBottomLeftRadius }; });
      check('Tablet (600 px): the opened Now card’s details join the card (no gap, square where they meet, round at the bottom)', joined && joined.touch && joined.sameWidth && joined.heroBottom === '0px' && joined.detailTop === '0px' && parseFloat(joined.detailBottom) >= 20, JSON.stringify(joined));
      await s.page.click('.hero .hero-top small'); await s.page.waitForTimeout(300);
      check('Tablet (600 px): Just played on Now the same', /^Time Song Category$/i.test(tn.head) && !tn.cols && tn.dots.every(w => w <= 1) && tn.side && tn.lined, JSON.stringify(tn));
      await tabTo(s.page, 'History');
      // The star right after the title's last word, also when the title wraps (Dan, Nov 6)
      const stars = await s.page.evaluate(() => [...document.querySelectorAll('#plist .pr:not(.ph) .c-song .t')].filter(t => t.querySelector('.star')).map(t => {
        const st = t.querySelector('.star').getBoundingClientRect(), r = document.createRange(); r.selectNodeContents(t.querySelector('.nw').firstChild);
        const lines = [...r.getClientRects()], l = lines[lines.length - 1], b = t.querySelector('b').getBoundingClientRect();
        return { gap: Math.round(st.left - l.right), same: st.top < l.bottom && st.bottom > l.top, wrapped: b.height > 30 }; }));
      check('Tablet (600 px): the star right after the title’s last word, wrapped or not', stars.length > 3 && stars.some(x => x.wrapped) && stars.every(x => x.gap >= 0 && x.gap <= 10 && x.same), JSON.stringify(stars.slice(0, 6)));
      const t12 = await s.page.evaluate(() => document.querySelector('#plist .pr:not(.ph) .c-time').innerText.split('\n').filter(x => /\d:\d\d/.test(x))[0]);
      check('Tablet (600 px): the time stays 12-hour', /^\d{1,2}:\d\d [AP]M$/.test(t12), t12);
      check('History: the line under the title is "SomaFM station play history"', await s.page.locator('header.top .sub').textContent() === 'SomaFM station play history');
    }
    if (theme === 'evergreen') check('Xmas Green (saved as evergreen), remembered', look.bg === 'rgb(16, 21, 17)', look.bg);
    if (width === 600 && !theme && scheme === 'light') {
      await tabTo(s.page, 'History');
      const top = await s.page.evaluate(() => { const q = document.querySelector('.quick'), kids = [...q.children].filter(k => !k.classList.contains('find')); return { ph: document.querySelector('#find').placeholder, lines: new Set(kids.map(k => Math.round(k.getBoundingClientRect().top))).size, last: kids[kids.length - 1].innerText.trim(), w: q.clientWidth, ws: kids.map(k => Math.round(k.getBoundingClientRect().width)).join('+') }; });
      const line = await s.page.evaluate(() => { const g = document.querySelector('.bar-line .grow'), c = [...g.querySelectorAll('.nw')].pop(); return c.getClientRects().length; });
      check('600 px: "checked … ago" moves to the next line whole, never split', line === 1, String(line));
      check('600 px: the first row of filters fits on one line, ending in "All ▾"', top.lines === 1 && top.last.replace(/\s+/g, ' ') === 'All ▾' && top.ph === 'Search: song, artist, or album', JSON.stringify(top));
    }
    check(`No script errors (${width} px)`, s.errors.length === 0, s.errors.join(' | '));
    await s.ctx.close();
  }

  // Shuffle: the built-in Client ID, Google's sign-in in its own window, and the key reaching this page
  s = await open(browser, { path: '/shuffle' });
  const q = await s.page.evaluate(() => document.body.textContent);
  check('Shuffle: sign-in, the quota for all devices, and the original order', /Sign in with Google/.test(q) && /Left today \(all your devices\)/.test(q) && /about 10,000 of 10,000/.test(q), q.slice(0, 200));
  const popup = s.page.waitForEvent('popup', { timeout: 10000 }).catch(() => null);
  await s.page.click('[data-act="shSignIn"]');
  const win = await popup;
  if (win) await win.waitForEvent('close', { timeout: 10000 }).catch(() => {});
  await s.page.waitForTimeout(1500);
  const after = await s.page.evaluate(() => ({ token: (JSON.parse(localStorage.getItem('xl:signin:token') || 'null') || {}).token, text: document.querySelector('#app').textContent }));
  check('Shuffle: signing in in Google\'s window carries on here: the key arrives, and it asks YouTube (refused by the stand-in)', !!win && win.isClosed() && after.token === 'site-token' && /YouTube refused: stand-in refuses/.test(after.text), JSON.stringify({ win: !!win, token: after.token, text: after.text.slice(0, 300) }));
  check('Shuffle: the YouTube requests it made are counted in the synced quota', Object.keys(api.doc.shuffle.units).length >= 0);
  check('No script errors (Shuffle)', s.errors.length === 0, s.errors.join(' | '));
  await s.ctx.close();

  // Shuffle's lasting sign-in (Nov 4): once, kept on the server, so another device (or the next day) needn't sign in
  api.keeps = true;
  s = await open(browser, { path: '/shuffle' });
  const kq = await s.page.evaluate(() => document.querySelector('#app').textContent);
  const kpop = s.page.waitForEvent('popup', { timeout: 10000 }).catch(() => null);
  await s.page.click('[data-act="shSignIn"]');
  const kwin = await kpop;
  if (kwin) await kwin.waitForEvent('close', { timeout: 10000 }).catch(() => {});
  await s.page.waitForTimeout(1500);
  const kafter = await s.page.evaluate(() => ({ token: (JSON.parse(localStorage.getItem('xl:signin:token') || 'null') || {}).token, text: document.querySelector('#app').textContent }));
  const aq = api.authQuery || {};
  check('Shuffle (kept sign-in): asks Google for a code with offline access; the server keeps it, and the key reaches this page', /stays signed in on all your devices/.test(kq) && aq.response_type === 'code' && aq.access_type === 'offline' && aq.prompt === 'consent'
    && !!kwin && kwin.isClosed() && api.yt === 'kept' && kafter.token === 'kept-token' && /YouTube refused: stand-in refuses/.test(kafter.text), JSON.stringify({ aq, kafter: kafter.token, text: kafter.text.slice(0, 200) }));
  check('No script errors (kept sign-in)', s.errors.length === 0, s.errors.join(' | '));
  await s.ctx.close();
  // Another device: nothing on it, yet no sign-in: a fresh key from the server
  s = await open(browser, { path: '/shuffle' });
  await s.page.waitForTimeout(800);
  const other = await s.page.evaluate(() => ({ text: document.querySelector('#app').textContent, token: (JSON.parse(localStorage.getItem('xl:signin:token') || 'null') || {}).token, signIn: !!document.querySelector('[data-act="shSignIn"]') }));
  check('Shuffle (kept sign-in): another device goes straight to YouTube with a fresh key, no sign-in', other.token === 'fresh-token' && !other.signIn && /YouTube refused/.test(other.text) && api.ytTokens >= 1, JSON.stringify(other).slice(0, 300));
  await s.page.click('[data-act="shSignOut"]');
  await s.page.waitForTimeout(500);
  const out = await s.page.evaluate(() => ({ signIn: !!document.querySelector('[data-act="shSignIn"]'), token: localStorage.getItem('xl:signin:token') }));
  check('Shuffle (kept sign-in): Sign out forgets it on the server, for every device', api.yt === null && out.signIn && (out.token === null || out.token === 'null'), JSON.stringify(out));
  await s.ctx.close();
  s = await open(browser, { path: '/shuffle' });
  await s.page.waitForTimeout(800);
  check('Shuffle (kept sign-in): after signing out, a new device asks to sign in', await s.page.evaluate(() => !!document.querySelector('[data-act="shSignIn"]')));
  check('No script errors (kept sign-in, other device)', s.errors.length === 0, s.errors.join(' | '));
  await s.ctx.close();
  api.keeps = false;

  // More: backup and restore, CSV
  api = freshApi();
  s = await open(browser, { path: '/more' });
  const dl = s.page.waitForEvent('download', { timeout: 5000 }).catch(() => null);
  await s.page.click('[data-act="backupDown"]');
  const file = await dl;
  let backup = null;
  if (file) backup = JSON.parse(fs.readFileSync(await file.path(), 'utf8'));
  check('More: Download a backup, in the same format today\'s site reads', backup && X.Backup.validate(backup).data.history.christmas.length === 700 && Object.keys(X.Backup.validate(backup).data.archive).length === items.length + 1, backup ? Object.keys(backup).join() : 'no file');
  const inc = JSON.parse(JSON.stringify(backup));
  inc.data.history.christmas.unshift([Math.floor(Date.now() / 1000) - 100, 'Backup Artist', 'Backup Song', '']);
  inc.data.notes = { 'backup artist|backup song': { t: 'from a backup', at: Date.now() } };
  await s.page.click('[data-act="restorePaste"]');
  await s.page.fill('#restore-text', JSON.stringify(inc));
  await s.page.click('[data-act="restoreRead"]');
  const pv = await s.page.evaluate(() => (document.querySelector('.restore ul') || {}).textContent || '');
  check('More: a pasted backup is read and shown before anything changes', /701 plays/.test(pv) && /1 of them aren't here yet/.test(pv) && /1 notes/.test(pv) && api.posted === 0, pv);
  await s.page.click('[data-act="restoreMerge"]');
  await s.page.waitForTimeout(800);
  check('More: Merge sends the plays and merges the rest', api.posted === 701 && api.doc.notes['backup artist|backup song'].t === 'from a backup' && /Merged/.test(await s.page.locator('.msg.ok').last().textContent()), String(api.posted));
  const csv = s.page.waitForEvent('download', { timeout: 5000 }).catch(() => null);
  await s.page.click('[data-act="csvDown"]');
  const cf = await csv;
  const text = cf ? fs.readFileSync(await cf.path(), 'utf8') : '';
  check('More: Plays as CSV', /^﻿?Date,Time,Artist,Title,Album,Playlist status,After gap/.test(text) && text.split('\n').length > 700, text.slice(0, 80));
  const themes = await s.page.evaluate(() => [...document.querySelectorAll('.theme')].map(b => b.textContent.trim()).join());
  await s.page.click('[data-act="theme"][data-v="candy"]');
  check('More: the theme swatches line up, whatever the names take', await s.page.evaluate(() => new Set([...document.querySelectorAll('.theme i')].map(i => Math.round(i.getBoundingClientRect().top))).size === 1));
  check('More: three dark themes, Midnight, Xmas Red and Xmas Green; choosing one keeps it on this device', themes === 'Midnight,Xmas Red,Xmas Green' && await s.page.evaluate(() => document.documentElement.dataset.theme === 'candy' && localStorage.getItem('xl:theme') === '"candy"'), themes);
  check('No script errors (More)', s.errors.length === 0, s.errors.join(' | '));
  await s.ctx.close();

  // A change that can't be saved is kept and tried again, and says so
  api = freshApi();
  s = await open(browser, { path: '/history' });
  api.signedIn = false;
  await s.page.locator('#plist .pr:not(.ph)').first().click();
  await s.page.click('.pr.open [data-act="note"]');
  await s.page.fill('#note-text', 'kept');
  await s.page.click('[data-act="noteSave"]');
  await s.page.waitForTimeout(500);
  const warn = await s.page.evaluate(() => (document.querySelector('.warn.err') || {}).textContent || '');
  check('A change that can\'t be saved (sign-in ran out) says so, and stays on the page', /couldn't be saved yet \(the sign-in ran out: reload the page\)/.test(warn) && /kept/.test(await s.page.locator('.pr.open .note').textContent()), warn);
  api.signedIn = true;
  await s.page.waitForTimeout(3600);
  const firstKey = Object.keys(api.doc.notes)[0];
  check('…and goes once it can', firstKey && api.doc.notes[firstKey].t === 'kept' && !(await s.page.$('.warn.err')), JSON.stringify(api.doc.notes));
  await s.ctx.close();

  // The playlist can't be read: songs aren't labeled, and it says why
  const saved = items.splice(0, items.length);
  s = await open(browser, { path: '/history' });
  await s.ctx.route(SITE + 'api/playlist**', r => r.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'YouTube said: quota' }) }));
  await s.page.reload({ waitUntil: 'load' }); await s.page.waitForFunction(() => /Couldn't read/.test(document.querySelector('.bar-line .grow').textContent), null, { timeout: 40000 }).catch(() => {});
  const pe = await s.page.evaluate(() => ({ line: document.querySelector('.bar-line .grow').textContent, chips: document.querySelectorAll('.quick .chip').length, rows: document.querySelectorAll('#plist .pr:not(.ph)').length }));
  check('Playlist unreadable: refuse and report (no labels, no filters), plays still listed', /Couldn't read “Xmas Mixed”: YouTube said: quota/.test(pe.line) && pe.chips === 0 && pe.rows === 50, JSON.stringify(pe));
  items.push(...saved);
  await s.ctx.close();

  await browser.close();
  console.log(fails ? `${fails} failed` : 'all passed');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
