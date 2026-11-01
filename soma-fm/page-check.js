// Real-page regression check for soma-xmas-checker.user.js
//
// Loads SomaFM's actual song-history page (with its prototype.js) in headless Chromium, injects the
// userscript with stand-ins for Tampermonkey's GM_* functions, and checks the things that have broken
// before: layout at several widths and both themes, the header arrangement, the Stats and Backup
// panels, Per page, card play history, and script errors.
//
// Needs internet access to somafm.com. YouTube is never contacted: the saved-playlist cache is seeded
// from playlist.fixture.json, and GM_xmlhttpRequest is a no-op.
//
//   npm install        (once, for Playwright)
//   npm run test:page
//
// Exit code is non-zero if any check fails.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const script = fs.readFileSync(path.join(__dirname, 'soma-xmas-checker.user.js'), 'utf8');
const items = JSON.parse(fs.readFileSync(path.join(__dirname, 'playlist.fixture.json'), 'utf8'))
  .map((x, i) => Object.assign({ secs: 150 + (i * 37) % 200 }, x));
const URL = 'https://somafm.com/christmas/songhistory.html';

// Three days of plays from a 60-song rotation, with two recording gaps, newest first
function seedHistory() {
  const pool = [];
  for (let i = 0; i < 40; i++) { const it = items[i]; const m = it.title.split(' - '); pool.push(m.length > 1 ? [m[0], m[1]] : [it.ch.replace(/ - Topic$/, ''), it.title]); }
  for (let i = 0; i < 20; i++) pool.push(['Rotation Artist ' + i, 'Rotation Song ' + i]);
  const hist = []; let t = Math.floor(Date.now() / 1000) - 600, seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 700; i++) {
    const [a, ti] = pool[Math.floor(rnd() * pool.length)];
    const gap = i === 250 || i === 500;
    hist.push(gap ? [t, a, ti, '', 1] : [t, a, ti, '']);
    t -= gap ? 7 * 3600 : 215;
  }
  return hist;
}

const STUBS = `
  const GM_getValue = (k, d) => (k in window.__store ? JSON.parse(JSON.stringify(window.__store[k])) : d);
  const GM_setValue = (k, v) => { window.__store[k] = JSON.parse(JSON.stringify(v)); };
  const GM_listValues = () => Object.keys(window.__store);
  const GM_setClipboard = t => { window.__clip = t; };
  const GM_xmlhttpRequest = () => {};
`;

const results = [];
const check = (label, ok, detail) => { results.push({ label, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? '  — ' + detail : ''}`); };

async function openPage(browser, { width, height = 1000, scheme = 'light', store = {}, hash = '', api = null, recorder = null, feed = null }) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, timezoneId: 'America/New_York', acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  if (api) await page.route('https://www.googleapis.com/**', api.handle);
  if (recorder) await page.route('https://rec.test.workers.dev/**', recorder);
  if (feed) await page.route('**/songs/christmas.json', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ songs: feed() }) }));   // in place of SomaFM's live list
  await page.goto(URL + hash, { waitUntil: 'load' });
  await page.evaluate(s => { window.__store = s; }, Object.assign({ playlist: { schema: 3, at: Date.now(), items, hidden: 0 }, 'history:christmas': seedHistory(), live: false }, store));
  await page.addScriptTag({ content: STUBS + script });
  await page.waitForTimeout(1500);
  return { ctx, page, errors };
}
// Fake YouTube Data API for the Shuffle panel: a playlist owned by the signed-in channel
function fakeApi(n) {
  const api = { order: [], puts: 0, tries: 0, flaky: {} };
  for (let i = 0; i < n; i++) api.order.push('pi' + i);
  api.start = api.order.slice();
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,PUT,OPTIONS' };
  const json = (route, body, status = 200) => route.fulfill({ status, headers: Object.assign({ 'content-type': 'application/json' }, cors), body: JSON.stringify(body) });
  api.handle = async route => {
    const req = route.request(), u = new globalThis.URL(req.url()), res = u.pathname.split('/').pop(), q = u.searchParams;
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (req.headers().authorization !== 'Bearer TESTKEY') return json(route, { error: { code: 401, message: 'Invalid Credentials', errors: [{ reason: 'authError' }] } }, 401);
    if (res === 'channels') return json(route, { items: [{ id: 'UCme', snippet: { title: 'Dan' } }] });
    if (res === 'playlists') return json(route, { items: [{ snippet: { channelId: 'UCme', title: 'Xmas Mixed' } }] });
    if (res === 'playlistItems' && req.method() === 'GET') {
      const start = Number(q.get('pageToken') || 0), size = Number(q.get('maxResults')), out = [];
      for (let i = start; i < Math.min(start + size, api.order.length); i++) out.push({ id: api.order[i], snippet: { position: i, title: 'Song ' + api.order[i], resourceId: { videoId: 'v' + api.order[i] } } });
      return json(route, start + size < api.order.length ? { items: out, nextPageToken: String(start + size) } : { items: out });
    }
    if (res === 'playlistItems' && req.method() === 'PUT') {
      const b = JSON.parse(req.postData());
      // flaky: PUT tries that fail, as a dropped connection or a busy YouTube
      const f = api.flaky[++api.tries];
      if (f === 'abort') return route.abort('connectionreset');
      if (f) return json(route, { error: { code: f, message: 'Backend Error', errors: [{ reason: 'backendError' }] } }, f);
      api.puts++;
      api.order.splice(api.order.indexOf(b.id), 1);
      api.order.splice(b.snippet.position, 0, b.id);
      return json(route, {});
    }
    return json(route, { error: { message: 'unexpected' } }, 400);
  };
  return api;
}
const signedIn = () => ({ 'signin:clientId': 'test.apps.googleusercontent.com', 'signin:token': { token: 'TESTKEY', at: Date.now(), exp: Date.now() + 3600000 } });
const shufText = page => inShadow(page, r => r.querySelector('#shufbody').textContent);
const shufClick = (page, label) => inShadow(page, (r, l) => { const b = [...r.querySelectorAll('#shufbody button')].find(x => x.textContent === l); if (b) b.click(); return !!b; }, label);
const waitShuf = (page, re) => page.waitForFunction(src => new RegExp(src).test(document.getElementById('xm-host').shadowRoot.querySelector('#shufbody').textContent), re.source, { timeout: 15000 }).then(() => true, () => false);

const inShadow = (page, fn, arg) => page.evaluate(([src, a]) => (new Function('r', 'a', src))(document.getElementById('xm-host').shadowRoot, a), [`return (${fn.toString()})(r, a);`, arg]);
const settle = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => setTimeout(r, 50))));

(async () => {
  const browser = await chromium.launch();

  // 1. Layout at each width (600 is the user's tablet in portrait)
  for (const [width, scheme, expected] of [[1024, 'light', 'under Stats'], [768, 'dark', 'under Stats'], [600, 'dark', 'under Stats'], [400, 'light', 'own row'], [360, 'dark', 'own row']]) {
    const { ctx, page, errors } = await openPage(browser, { width, scheme });
    const info = await inShadow(page, r => {
      const h = r.querySelector('header'), R = q => r.querySelector(q).getBoundingClientRect();
      const b = ['#refresh', '#live'].map(R), st = R('#stats'), h1 = R('h1');
      return { mode: h.classList.contains('stacked') ? 'own row' : 'under Stats', statsBesideTitle: st.top < h1.bottom,
        buttonsOneRow: new Set(b.map(x => Math.round(x.top))).size === 1, overflow: document.documentElement.scrollWidth > innerWidth,
        undefinedText: /undefined|NaN/.test(r.querySelector('ol').textContent), cards: r.querySelectorAll('ol > li:not(.gap):not(.empty)').length };
    });
    check(`${width}px ${scheme}: no sideways scrolling`, !info.overflow);
    check(`${width}px ${scheme}: Stats beside the title, buttons ${expected}, one row`, info.statsBesideTitle && info.mode === expected && info.buttonsOneRow, JSON.stringify(info));
    check(`${width}px ${scheme}: cards render with no "undefined"/"NaN"`, info.cards > 0 && !info.undefinedText);
    check(`${width}px ${scheme}: no script errors`, errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // Only one song played isn't in the playlist or disliked (under 1% of plays): "not in your playlist" gives its spot to how long until a song comes back
  {
    const { markKey } = require('./soma-xmas-checker.user.js');
    const dislikes = {};
    for (const p of seedHistory()) dislikes[markKey(p[1], p[2])] = Date.now();
    const { ctx, page, errors } = await openPage(browser, { width: 600, scheme: 'light', store: { dislikes }, feed: () => [{ date: String(Math.floor(Date.now() / 1000) - 60), artist: 'Lonely Artist', title: 'Lonely Song', album: '' }] });
    await inShadow(page, r => r.querySelector('#stats').click());
    await page.waitForTimeout(500);
    const row = await inShadow(page, r => {
      const g = r.querySelector('.tile.share').parentNode, back = g.querySelector('.tile.back');
      const headline = [...r.querySelectorAll('.sline')].map(x => x.textContent).find(x => /comes back about every/.test(x)) || '';
      const tops = [...g.children].map(x => Math.round(x.getBoundingClientRect().top));
      const m = /every (?:(\d+) h)? ?(?:(\d+) min)?/.exec(headline) || [];
      const v = back && back.querySelector('.v');
      const lone = [...r.querySelectorAll('#statsbox .sline')].map(x => x.textContent).find(x => /^ ?Not in playlist/.test(x.trim()) || /Not in playlist/.test(x)) || '';
      return { lone, hours: (Number(m[1]) || 0) + (Number(m[2]) || 0) / 60, valueOneLine: !!v && v.getBoundingClientRect().height < parseFloat(getComputedStyle(v).lineHeight) * 1.5, tiles: [...g.children].map(x => x.className).join(), back: back ? back.querySelector('.v').textContent : null, headline, oneRow: new Set(tops).size === 1 };
    });
    check('One song not in the playlist (under 1% of plays): no card for it; the "comes back" card takes the "not in your playlist" spot, in hours matching the rotation line, on one line, in one row at 600px',
      /Not in playlist 1 song/.test(row.lone) && !/none/.test(row.tiles) && /^\d+\.\d h$/.test(row.back) && Math.abs(parseFloat(row.back) - row.hours) < 0.06 && row.oneRow && row.valueOneLine, JSON.stringify(row));
    check('"Comes back" card: no script errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // Stats panel uses most of a desktop screen
  {
    const { ctx, page } = await openPage(browser, { width: 1600, scheme: 'dark' });
    await inShadow(page, r => r.querySelector('#stats').click());
    await page.waitForTimeout(500);
    const box = await inShadow(page, r => { const b = r.querySelector('#statsbox').getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(innerWidth - b.right), w: Math.round(b.width) }; });
    check('1600px: Stats panel is wide (over 1100 px) and centered', box.w > 1100 && Math.abs(box.l - box.r) <= 2, JSON.stringify(box));
    await inShadow(page, r => r.querySelector('.ctbtn').click());   // the log is built a frame later
    await page.waitForTimeout(300);
    const cut = await inShadow(page, r => [r.querySelectorAll('.plog li').length, [...r.querySelectorAll('.plog li')].filter(x => x.scrollWidth > x.clientWidth + 1).length]);
    check('1600px: Stats play log entries are not cut off', cut[0] > 0 && cut[1] === 0, String(cut));
    // In list order, each entry is below the one before or at the top of the next column to the right
    const order = await inShadow(page, r => {
      const b = [...r.querySelector('.plog').querySelectorAll('li')].map(x => x.getBoundingClientRect());
      let ok = true;
      for (let i = 1; i < b.length; i++) if (!(Math.abs(b[i].left - b[i - 1].left) < 2 ? b[i].top > b[i - 1].top : b[i].left > b[i - 1].left && b[i].top < b[i - 1].top)) ok = false;
      return { ok, n: b.length, cols: new Set(b.map(x => Math.round(x.left))).size };
    });
    check('1600px: the play log reads down each column, then the next', order.ok && order.cols > 1 && order.n > order.cols, JSON.stringify(order));
    await ctx.close();
  }

  // Shuffle panel: first-time setup, then sign-in
  {
    const { ctx, page, errors } = await openPage(browser, { width: 360, scheme: 'light' });
    await inShadow(page, r => r.querySelector('#shuffle').click());
    await settle(page);
    check('Shuffle first asks for the Client ID, with the Quota line already there', /Client ID/.test(await shufText(page)) && /Quota: about 10,000 units left/.test(await shufText(page)));
    await inShadow(page, r => { r.querySelector('#shclient').value = 'not an id'; });
    await shufClick(page, 'Save'); await settle(page);
    check('Shuffle refuses something that isn\'t a Client ID', /doesn't look like a Client ID/.test(await shufText(page)));
    await inShadow(page, r => { r.querySelector('#shclient').value = 'abc-123.apps.googleusercontent.com'; });
    await shufClick(page, 'Save'); await settle(page);
    const t = await shufText(page);
    check('After saving the Client ID, Shuffle offers Google sign-in', /Sign in with Google/.test(t) && await page.evaluate(() => window.__store['signin:clientId'] === 'abc-123.apps.googleusercontent.com'), t);
    check('360px: Shuffle panel has no sideways scrolling', await inShadow(page, r => { const d = r.querySelector('#shufbox'); return d.scrollWidth <= d.clientWidth + 1; }));
    check('Shuffle setup: no script errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // Shuffle, put back, and the sign-in return, against a fake YouTube API (Google is never contacted)
  {
    const api = fakeApi(30);
    const { ctx, page, errors } = await openPage(browser, { width: 600, scheme: 'dark', store: Object.assign(signedIn(), { favorites: { vpi7: { on: true, at: 1 }, vpi21: { on: true, at: 1 } } }), api });
    await inShadow(page, r => r.querySelector('#shuffle').click());
    const ready = await waitShuf(page, /New order/);
    const early = await page.evaluate(() => window.__store['shuffle:original:PLRpb0eQM5sYC0-Fhol0BnOwYygZy_UTyt']);
    check('Opening Shuffle saves the original order before anything is moved', early && api.puts === 0 && early.songs.length === 30 && early.songs[0].id === 'pi0' && /Saved just now/.test(await shufText(page)));
    const t = await shufText(page);
    const moves = Number((t.match(/takes (\d+) move/) || [])[1]);
    check('Shuffle reads the playlist and shows the new order and its cost', ready && /30 songs/.test(t) && moves > 15 && moves < 30 && /about [\d,]+ quota units/.test(t), t.slice(0, 200));
    check('Shuffle says what it spreads out', /kept apart/.test(t), t);
    check('600px: Shuffle panel has no sideways scrolling', await inShadow(page, r => { const d = r.querySelector('#shufbox'); return d.scrollWidth <= d.clientWidth + 1; }));
    await shufClick(page, 'Shuffle the playlist');
    check('Shuffle asks for a second tap before changing anything', /Tap again/.test(await shufText(page)) && api.puts === 0);
    api.flaky = { 4: 'abort', 9: 503 };
    await shufClick(page, 'Tap again to start');
    await page.waitForTimeout(400);
    const retryMsg = await shufText(page);
    const done = await waitShuf(page, /Done\./);
    check('Shuffle moves the songs, checks the order, and reports done', done && api.puts === moves && api.order.join() !== api.start.join(), `puts ${api.puts}, moves ${moves}`);
    check('A dropped connection and a busy YouTube are tried again (3.19)', api.tries === moves + 2 && /didn't answer.*Trying again in 2 s/.test(retryMsg), `tries ${api.tries} ${retryMsg.slice(0, 160)}`);
    check('A favorite is one of the first three songs, and Shuffle says so', /^(pi7|pi21)$/.test(api.order.slice(0, 3).filter(x => x === 'pi7' || x === 'pi21')[0] || '') && /A favorite is one of the first three songs/.test(t), api.order.slice(0, 3).join());
    check('Shuffle remembers the earlier order and clears the job', await page.evaluate(() => !window.__store['shuffle:job:PLRpb0eQM5sYC0-Fhol0BnOwYygZy_UTyt'] && window.__store['shuffle:last:PLRpb0eQM5sYC0-Fhol0BnOwYygZy_UTyt'].before.length === 30));
    const qt = await shufText(page), run = await page.evaluate(() => window.__store['shuffle:lastRun']);
    check('Shuffle has a folded Quota line: units left, the reset time and what the shuffle used', await inShadow(page, r => { const d = r.querySelector('#shufbody details.sdet'); return d && !d.open && /ⓘ Quota: about [0-9,]+ units left today/.test(d.querySelector('summary').textContent); }) && /About [0-9,]+ of 10,000 units left today/.test(qt) && /resets in .*midnight Pacific/.test(qt) &&
      run && run.complete && run.moves === moves && run.units >= moves * 50 && new RegExp('The last shuffle .* used about ' + run.units.toLocaleString() + ' units').test(qt), qt.slice(-400));
    const orig = await page.evaluate(() => window.__store['shuffle:original:PLRpb0eQM5sYC0-Fhol0BnOwYygZy_UTyt']);
    check('The original order is saved before the first shuffle', orig && orig.songs.map(x => x.id).join() === api.start.join() && orig.songs[0].title === 'Song pi0' && orig.songs[0].videoId === 'vpi0');
    await shufClick(page, 'Shuffle again');
    await waitShuf(page, /Show the earlier order/);
    // A second shuffle doesn't overwrite the original
    await shufClick(page, 'Shuffle the playlist'); await shufClick(page, 'Tap again to start');
    await waitShuf(page, /Done\./);
    const orig2 = await page.evaluate(() => window.__store['shuffle:original:PLRpb0eQM5sYC0-Fhol0BnOwYygZy_UTyt']);
    check('A second shuffle keeps the original order as it was', orig2.at === orig.at && orig2.songs.map(x => x.id).join() === api.start.join());
    await shufClick(page, 'Shuffle again');
    await waitShuf(page, /Show the original order/);
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }).catch(() => null), shufClick(page, 'Download it')]);
    const csv = dl ? fs.readFileSync(await dl.path(), 'utf8') : '';
    check('The original order downloads as a CSV of titles and video links', /^\ufeff?Position,Title,Video\r\n1,"Song pi0",https:\/\/www\.youtube\.com\/watch\?v=vpi0\r\n/.test(csv), csv.slice(0, 120));
    await shufClick(page, 'Show the original order');
    await shufClick(page, 'Put back the original order'); await shufClick(page, 'Tap again to start');
    await waitShuf(page, /original order is back/);
    check('Putting back the original order restores it', api.order.join() === api.start.join());
    // and back to the shuffled order, then put back "the earlier order" (the step before)
    await shufClick(page, 'Shuffle again');
    await waitShuf(page, /New order/);
    await shufClick(page, 'Shuffle the playlist'); await shufClick(page, 'Tap again to start');
    await waitShuf(page, /Done\./);
    await shufClick(page, 'Shuffle again');
    await waitShuf(page, /Show the earlier order/);
    await shufClick(page, 'Show the earlier order');
    await shufClick(page, 'Put back this order'); await shufClick(page, 'Tap again to start');
    await waitShuf(page, /Done\./);
    check('Putting back the earlier order restores it', api.order.join() === api.start.join());
    // The original order travels in backups
    await inShadow(page, r => r.querySelector('#shclose').click());
    await inShadow(page, r => { r.querySelector('#backup').click(); r.querySelector('#bkcopy').click(); });
    await settle(page); await page.waitForTimeout(200);
    const backupHasIt = await page.evaluate(() => { const b = JSON.parse(window.__clip || '{}'); return !!(b.data && b.data.original && b.data.original.songs.length === 30); });
    check('Backups include the original order', backupHasIt);
    check('Shuffle: no script errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }
  {
    // Signed in in the same tab (sign-in window blocked): the key is saved, the address cleaned, and Shuffle reopens
    const api = fakeApi(30);
    const { ctx, page, errors } = await openPage(browser, { width: 600, api, hash: '#state=s123&access_token=TESTKEY&token_type=Bearer&expires_in=3599',
      store: { 'signin:clientId': 'test.apps.googleusercontent.com', 'signin:pending': { state: 's123', popup: false, at: Date.now() } } });
    const info = await page.evaluate(() => ({ token: (window.__store['signin:token'] || {}).token, hash: location.hash, pending: window.__store['signin:pending'] }));
    check('Sign-in return saves the key and clears it from the address', info.token === 'TESTKEY' && info.hash === '' && !info.pending, JSON.stringify(info));
    check('Sign-in return in the same tab reopens Shuffle', await waitShuf(page, /New order/));
    check('Sign-in return: no script errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }
  {
    // A sign-in return that this script didn't start is ignored
    const { ctx, page } = await openPage(browser, { width: 600, hash: '#state=other&access_token=EVIL', store: { 'signin:pending': { state: 's123', popup: true, at: Date.now() } } });
    const info = await page.evaluate(() => ({ token: window.__store['signin:token'], host: !!document.getElementById('xm-host') }));
    check('A sign-in return with the wrong state is ignored', !info.token && info.host, JSON.stringify(info));
    await ctx.close();
  }

  // 2. Interactions at the tablet width
  const { ctx, page, errors } = await openPage(browser, { width: 600, scheme: 'dark' });

  // Per page (broke in 3.9.0: event target cleared inside a delayed action)
  // 3.18.4: a themed menu like the category one, with 250 in place of 200
  await inShadow(page, r => { r.querySelector('#per').scrollIntoView({ block: 'end' }); r.querySelector('#per').click(); });
  await page.waitForTimeout(150);
  const perMenu = await inShadow(page, r => { const m = r.querySelector('.catmenu'), b = r.querySelector('#per'); if (!m) return null; const mr = m.getBoundingClientRect();
    return { opts: [...m.querySelectorAll('.catopt')].map(o => o.textContent).join(), sel: (m.querySelector('[aria-selected="true"]') || {}).textContent, inView: mr.top >= 0 && mr.bottom <= innerHeight && mr.right <= innerWidth, label: b.textContent }; });
  check('Per page opens a themed menu: 25, 50, 100, 250, the current one ticked', perMenu && perMenu.opts === '25,✓50,100,250' && perMenu.sel === '✓50' && perMenu.inView && perMenu.label === '50▾', JSON.stringify(perMenu));
  await inShadow(page, r => [...r.querySelectorAll('.catmenu .catopt')].find(o => o.textContent === '25').click());
  await settle(page); await page.waitForTimeout(200);
  const pos = await inShadow(page, r => r.querySelector('#pos').textContent + ' ' + r.querySelector('#per').textContent);
  const perFont = await inShadow(page, r => [getComputedStyle(r.querySelector('#per')).fontSize, getComputedStyle(r.querySelector('#prev')).fontSize]);
  check('Per page button text is the same size as the pager buttons', Math.abs(parseFloat(perFont[0]) - parseFloat(perFont[1])) < 0.2, perFont.join(' vs '));
  check('Per page 25 shows 25 cards, saved', /^1–25 of .* 25▾$/.test(pos) && await page.evaluate(() => window.__store.pageSize === 25), pos);

  // Song lengths (3.13): the playlist video's for "In playlist" songs, measured (~) for the rest
  const lens = await inShadow(page, r => {
    const have = [...r.querySelectorAll('ol > li.have .artist .len')].map(x => x.textContent);
    const other = [...r.querySelectorAll('ol > li:not(.have) .artist .len')].map(x => x.textContent);
    return { have: have.slice(0, 3), other: other.slice(0, 3), haveN: have.length, otherN: other.length,
      stats: 0, wide: document.documentElement.scrollWidth > window.innerWidth };
  });
  check('Cards show song lengths: playlist length for "In playlist", measured (~) for others',
    lens.haveN > 0 && lens.otherN > 0 && lens.have.every(t => /^ · \d+:\d\d$/.test(t)) && lens.other.every(t => /^ · ~\d+:\d\d$/.test(t)) && !lens.wide, JSON.stringify(lens));

  // Favorites (3.14): a star on "In playlist" cards, saved by video id
  const star = await inShadow(page, r => { const b = r.querySelector('ol > li.have .title button.fav'); if (!b) return null; const was = b.getAttribute('aria-pressed'); b.click(); return was; });
  await settle(page); await page.waitForTimeout(200);
  const fav = await inShadow(page, r => ({ on: r.querySelectorAll('ol > li.have .title button.fav[aria-pressed="true"]').length, text: (r.querySelector('button.fav[aria-pressed="true"]') || {}).textContent,
    others: r.querySelectorAll('ol > li:not(.have) button.fav').length }));
  const saved = await page.evaluate(() => { const f = window.__store.favorites || {}; return Object.keys(f).filter(k => f[k].on).length; });
  check('Tapping ☆ on an "In playlist" card makes it a favorite (⭐), saved', star === 'false' && fav.on >= 1 && fav.text === '⭐' && saved === 1, JSON.stringify(fav) + ' saved ' + saved);
  check('Only songs in the playlist have a star', fav.others === 0, String(fav.others));

  // Notes (3.18): 📝 on every card (a song's cards are found by title and artist: two songs can share a title) opens an editor at the bottom of the card; the note shows on each of the song's cards
  const noteFor = await inShadow(page, r => { const li = r.querySelector('ol > li.none, ol > li.disliked, ol > li.other'); const b = li && li.querySelector('.title button.notebtn');
    if (!b) return null; const name = li.querySelector('.title').firstChild.textContent + ' | ' + li.querySelector('.artist').textContent; b.click(); return { name, pencil: b.textContent === '✏️', all: r.querySelectorAll('ol > li:not(.gap):not(.empty)').length, btns: r.querySelectorAll('ol > li .title button.notebtn').length }; });
  await settle(page); await page.waitForTimeout(200);
  const ed = await inShadow(page, r => ({ eds: r.querySelectorAll('.noteed').length, focused: r.activeElement && r.activeElement.id === 'xm-note',
    inCard: !!(r.querySelector('#xm-note') && r.querySelector('#xm-note').closest('li')) }));
  check('Every card has a note button (✏️ until there is a note); it opens one editor in the card, ready to type', noteFor && noteFor.btns === noteFor.all && noteFor.pencil && ed.eds === 1 && ed.focused && ed.inCard, JSON.stringify([noteFor, ed]));
  // 3.18.3: the box stays in sight when the on-screen keyboard opens (here: the viewport gets shorter)
  await inShadow(page, r => [...r.querySelectorAll('.noteed button')].find(b => b.textContent === 'Cancel').click());
  await settle(page); await page.waitForTimeout(200);
  const vh = page.viewportSize();
  await inShadow(page, r => { const b = [...r.querySelectorAll('ol > li .title button.notebtn')][3]; window.scrollBy(0, b.getBoundingClientRect().bottom - innerHeight + 10); b.click(); });
  await page.waitForTimeout(150);
  await page.setViewportSize({ width: vh.width, height: Math.round(vh.height * 0.55) });
  await page.waitForTimeout(600);
  const kb = await inShadow(page, r => { const x = r.querySelector('.noteed').getBoundingClientRect(); return { top: Math.round(x.top), bottom: Math.round(x.bottom), h: innerHeight }; });
  check('With the keyboard open, the note box is scrolled into sight', kb.top >= 0 && kb.bottom <= kb.h, JSON.stringify(kb));
  await page.setViewportSize(vh); await page.waitForTimeout(300);
  await inShadow(page, r => [...r.querySelectorAll('.noteed button')].find(b => b.textContent === 'Cancel').click());
  await settle(page); await page.waitForTimeout(200);
  await inShadow(page, r => { const li = r.querySelector('ol > li.none, ol > li.disliked, ol > li.other'); li.querySelector('.title button.notebtn').click(); });
  await settle(page); await page.waitForTimeout(200);
  await page.locator('#xm-note').fill("Can't find the SomaFM version on YouTube");
  await inShadow(page, r => [...r.querySelectorAll('.noteed button')].find(b => b.textContent === 'Save').click());
  await settle(page); await page.waitForTimeout(200);
  const nt = await page.evaluate(name => { const r = document.getElementById('xm-host').shadowRoot, n = window.__store.notes || {};
    const cards = [...r.querySelectorAll('ol > li')].filter(li => li.querySelector('.title') && li.querySelector('.title').firstChild.textContent + ' | ' + li.querySelector('.artist').textContent === name);
    return { saved: Object.keys(n).map(k => n[k].t).join(), cards: cards.length, shown: cards.filter(li => li.lastElementChild.className === 'unote' && li.lastElementChild.textContent === "Can't find the SomaFM version on YouTube").length,
      pressed: cards.filter(li => li.querySelector('button.notebtn').getAttribute('aria-pressed') === 'true' && li.querySelector('button.notebtn').textContent === '📝').length, open: r.querySelectorAll('.noteed').length,
      otherPressed: r.querySelectorAll('button.notebtn[aria-pressed="true"]').length, wide: document.documentElement.scrollWidth > window.innerWidth }; }, noteFor && noteFor.name);
  check('Saving a note keeps it, and shows it at the bottom of each of the song\'s cards', nt.saved === "Can't find the SomaFM version on YouTube" && nt.cards >= 1 && nt.shown === nt.cards && nt.pressed === nt.cards && nt.otherPressed === nt.cards && nt.open === 0 && !nt.wide, JSON.stringify(nt));
  await inShadow(page, r => r.querySelector('button.notebtn[aria-pressed="true"]').click());
  await settle(page); await page.waitForTimeout(200);
  const pre = await inShadow(page, r => r.querySelector('#xm-note').value);
  await inShadow(page, r => [...r.querySelectorAll('.noteed button')].find(b => b.textContent === 'Delete').click());
  await settle(page); await page.waitForTimeout(200);
  const gone = await page.evaluate(() => { const r = document.getElementById('xm-host').shadowRoot, n = window.__store.notes || {};
    return { kept: Object.keys(n).map(k => JSON.stringify(n[k].t)).join(), shown: r.querySelectorAll('.unote').length, pressed: r.querySelectorAll('button.notebtn[aria-pressed="true"]').length }; });
  check('Editing starts from the note; Delete removes it (kept as empty, for backup merges)', pre === "Can't find the SomaFM version on YouTube" && gone.kept === '""' && gone.shown === 0 && gone.pressed === 0, pre + ' ' + JSON.stringify(gone));

  // Categories (3.15): a menu button beside the buttons of "In playlist" cards, saved by video id. 3.18.2: a menu in the page's colors, not a system drop-down
  await inShadow(page, r => r.querySelector('ol > li.have .state button.cat').click());
  await page.waitForTimeout(150);
  const menu = await inShadow(page, r => { const m = r.querySelector('.catmenu'), b = r.querySelector('ol > li.have .state button.cat'); if (!m) return null;
    const mr = m.getBoundingClientRect(), br = b.getBoundingClientRect(), bg = getComputedStyle(m).backgroundColor, card = getComputedStyle(r.querySelector('ol > li.have')).backgroundColor;
    return { opts: [...m.querySelectorAll('.catopt')].map(o => o.textContent).join(), below: mr.top >= br.bottom, inView: mr.left >= 0 && mr.right <= innerWidth && mr.bottom <= innerHeight,
      themed: bg !== 'rgba(0, 0, 0, 0)' && bg !== 'rgb(255, 255, 255)' || matchMedia('(prefers-color-scheme: light)').matches, expanded: b.getAttribute('aria-expanded'), focus: r.activeElement && r.activeElement.className, n: r.querySelectorAll('.catmenu').length, card }; });
  check('The category button opens a themed menu under it, focused, with the six categories', menu && menu.opts === 'Band/Swing,Classics,Dance,Jazz/Piano,Mellow,Soul/Funk' && menu.below && menu.inView && menu.themed && menu.expanded === 'true' && /catopt/.test(menu.focus) && menu.n === 1, JSON.stringify(menu));
  await page.keyboard.press('Escape');
  const esc = await inShadow(page, r => ({ n: r.querySelectorAll('.catmenu').length, focus: r.activeElement && r.activeElement.className, expanded: r.querySelector('ol > li.have .state button.cat').getAttribute('aria-expanded') }));
  check('Escape closes the menu and returns to its button', esc.n === 0 && esc.focus === 'menubtn cat' && esc.expanded === 'false', JSON.stringify(esc));
  await inShadow(page, r => r.querySelector('ol > li.have .state button.cat').click());
  await page.mouse.click(5, 5);
  check('Tapping elsewhere closes the menu', await inShadow(page, r => r.querySelectorAll('.catmenu').length === 0));
  await inShadow(page, r => r.querySelector('ol > li.have .state button.cat').click());
  await inShadow(page, r => [...r.querySelectorAll('.catmenu .catopt')].find(o => o.dataset.value === 'dance').click());
  await settle(page); await page.waitForTimeout(200);
  const catInfo = await page.evaluate(() => { const r = document.getElementById('xm-host').shadowRoot; const f = window.__store.categories || {}, b = r.querySelector('ol > li.have .state button.cat');
    return { saved: Object.keys(f).filter(k => f[k].c === 'dance').length, shown: r.querySelectorAll('ol > li.have button.cat.set').length, label: b.textContent, open: r.querySelectorAll('.catmenu').length,
      others: r.querySelectorAll('ol > li:not(.have) button.cat').length, wide: document.documentElement.scrollWidth > window.innerWidth }; });
  check('Choosing a category saves it and shows it on the button', catInfo.saved === 1 && catInfo.shown >= 1 && catInfo.label === 'Dance▾' && catInfo.open === 0 && catInfo.others === 0 && !catInfo.wide, JSON.stringify(catInfo));
  await inShadow(page, r => r.querySelector('ol > li.have .state button.cat.set').click());
  const clear = await inShadow(page, r => { const m = r.querySelector('.catmenu'); const s = m.querySelector('[aria-selected="true"]'); const out = { sel: s && s.dataset.value, last: m.lastElementChild.textContent }; r.querySelector('ol > li.have .state button.cat.set').click(); return out; });
  check('A set category is ticked, and the menu offers "No category"', clear.sel === 'dance' && clear.last === 'No category', JSON.stringify(clear));
  // Category chips (3.17): a second chip row; the count follows a drop-down change without a redraw
  const chips = await inShadow(page, r => { const c = r.querySelector('.catf'), f = r.querySelector('.filters');
    return { labels: [...c.querySelectorAll('button:not(.favf)')].map(b => b.innerText.replace(/[^A-Za-z/]*[0-9,]+$/, '')).join(), wide: innerWidth >= 900, dance: Number(c.querySelectorAll('button:not(.favf)')[2].querySelector('.n').textContent),
      below: c.getBoundingClientRect().top >= f.getBoundingClientRect().bottom }; });
  check('Category chips sit below the status chips, and count the drop-down change', chips.labels === 'Swing,Classics,Dance,Jazz,Mellow,' + (chips.wide ? 'Soul/Funk' : 'Funk') + ',None' && chips.dance >= 1 && chips.below, JSON.stringify(chips));
  const vp = page.viewportSize();
  for (const w of [1000, 360]) { await page.setViewportSize({ width: w, height: vp.height }); await page.waitForTimeout(300); const t = await inShadow(page, r => [...r.querySelectorAll('.catf button:not(.favf)')].map(b => b.innerText.replace(/[^A-Za-z/]*[0-9,]+$/, '')).join()); check('The Soul/Funk chip reads "Funk" below desktop width (' + w + 'px)', t.indexOf(w >= 900 ? ',Soul/Funk,' : ',Funk,') >= 0, t); }
  await page.setViewportSize(vp); await page.waitForTimeout(300);
  await inShadow(page, r => r.querySelectorAll('.catf button:not(.favf)')[2].click());
  await settle(page); await page.waitForTimeout(200);
  const onlyDance = await inShadow(page, r => { const cards = [...r.querySelectorAll('#cards > li:not(.gap):not(.empty)')];
    return { n: cards.length, ok: cards.every(li => li.classList.contains('have') && li.querySelector('button.cat').dataset.value === 'dance'), pressed: r.querySelectorAll('.catf button:not(.favf)')[2].getAttribute('aria-pressed') }; });
  check('Tapping a category chip shows only that category', onlyDance.n === chips.dance && onlyDance.ok && onlyDance.pressed === 'true' && await page.evaluate(() => window.__store.catFilters.join() === 'dance'), JSON.stringify(onlyDance));
  await inShadow(page, r => r.querySelectorAll('.catf button:not(.favf)')[6].click());
  await settle(page); await page.waitForTimeout(200);
  const both = await inShadow(page, r => { const cards = [...r.querySelectorAll('#cards > li:not(.gap):not(.empty)')];
    return { ok: cards.length > 0 && cards.every(li => li.classList.contains('have') && /^(dance|)$/.test(li.querySelector('button.cat').dataset.value)), uncat: cards.filter(li => !li.querySelector('button.cat').dataset.value).length }; });
  check('"None" adds the songs without a category', both.ok && both.uncat > 0, JSON.stringify(both));
  await inShadow(page, r => { r.querySelectorAll('.catf button:not(.favf)')[2].click(); });
  await settle(page);
  await inShadow(page, r => { r.querySelectorAll('.catf button:not(.favf)')[6].click(); });
  await settle(page); await page.waitForTimeout(200);

  // ⭐ chip (3.20): first on the category row; only favorites; its count follows a star tap without a redraw
  const fav0 = await inShadow(page, r => { const b = r.querySelector('.catf button'); return { first: b.classList.contains('favf'), n: Number(b.querySelector('.n').textContent), pressed: b.getAttribute('aria-pressed') }; });
  const starred = await inShadow(page, r => { for (const b of r.querySelectorAll('#cards > li.have button.fav')) if (b.getAttribute('aria-pressed') === 'false') { b.click(); return b.dataset.vid; } });
  await settle(page); await page.waitForTimeout(200);
  const fav1 = await inShadow(page, r => Number(r.querySelector('.catf .favf .n').textContent));
  check('The ⭐ chip leads the category row and counts a new favorite', fav0.first && fav0.pressed === 'false' && fav1 >= fav0.n + 1, JSON.stringify([fav0, fav1]));
  await inShadow(page, r => r.querySelector('.catf .favf').click());
  await settle(page); await page.waitForTimeout(200);
  const favOnly = await inShadow(page, r => { const cards = [...r.querySelectorAll('#cards > li:not(.gap):not(.empty)')];
    return { per: Number(r.querySelector('#per').dataset.value), n: cards.length, ok: cards.length > 0 && cards.every(li => li.classList.contains('have') && li.querySelector('button.fav').getAttribute('aria-pressed') === 'true'), pressed: r.querySelector('.catf .favf').getAttribute('aria-pressed') }; });
  check('Tapping ⭐ shows only favorites', favOnly.ok && favOnly.n === Math.min(fav1, favOnly.per) && favOnly.pressed === 'true' && await page.evaluate(() => window.__store.favOnly === true), JSON.stringify([favOnly, fav1]));
  await inShadow(page, r => r.querySelector('.catf .favf').click());
  await settle(page); await page.waitForTimeout(200);
  const favOff = await inShadow(page, r => ({ n: r.querySelectorAll('#cards > li:not(.gap):not(.empty)').length, others: [...r.querySelectorAll('#cards > li:not(.gap):not(.empty)')].filter(li => !li.querySelector('button.fav[aria-pressed="true"]')).length, pressed: r.querySelector('.catf .favf').getAttribute('aria-pressed') }));
  check('Tapping ⭐ again shows every song', favOff.others > 0 && favOff.pressed === 'false' && await page.evaluate(() => window.__store.favOnly === false), JSON.stringify([favOff, favOnly.n]));
  await inShadow(page, (r, v) => r.querySelector('#cards button.fav[data-vid="' + v + '"]').click(), starred);   // as it was, for the checks below
  await settle(page);

  // Latest play only (3.15): one card per song
  const dupCount = () => inShadow(page, r => { const seen = new Set(); let d = 0; for (const li of r.querySelectorAll('#cards > li:not(.gap):not(.empty)')) { const k = li.querySelector('.title').firstChild.textContent + '|' + li.querySelector('.artist').firstChild.textContent; if (seen.has(k)) d++; seen.add(k); } return d; });
  const before1 = await dupCount();
  await inShadow(page, r => r.querySelector('.filters .one').click());
  await settle(page); await page.waitForTimeout(300);
  const one = await inShadow(page, r => ({ pressed: r.querySelector('.filters .one').getAttribute('aria-pressed'), gaps: r.querySelectorAll('#cards > li.gap').length }));
  const after1 = await dupCount();
  check('"Latest" shows each song once', before1 > 0 && after1 === 0 && one.pressed === 'true' && one.gaps === 0 && await page.evaluate(() => window.__store.latestOnly === true), `dups ${before1} → ${after1} ${JSON.stringify(one)}`);
  await inShadow(page, r => r.querySelector('.filters .one').click());
  await settle(page); await page.waitForTimeout(300);
  check('Cards are laid out only when on screen (content-visibility)', await inShadow(page, r => getComputedStyle(r.querySelector('#cards > li')).contentVisibility === 'auto'));

  // Card play history
  const log =await inShadow(page, r => { const b = r.querySelector('.histbtn'); if (!b) return null; b.click(); return true; });
  await settle(page); await page.waitForTimeout(200);
  const logRows = await inShadow(page, r => r.querySelectorAll('.cardlog li').length);
  check('a repeated song opens its play history', log && logRows >= 2, `rows ${logRows}`);
  const logText = await inShadow(page, r => ({ cut: [...r.querySelectorAll('.cardlog li')].filter(x => x.scrollWidth > x.clientWidth + 1).length,
    legend: (r.querySelector('.cardlog .plegend') || {}).textContent || '', old: /later|after a recording/.test(r.querySelector('.cardlog').textContent) }));
  check('play history entries are not cut off, and have a legend', logText.cut === 0 && /since the previous play/.test(logText.legend) && !logText.old, JSON.stringify(logText));

  // Stats panel
  await inShadow(page, r => r.querySelector('#stats').click());
  await page.waitForTimeout(500);
  const stats = await inShadow(page, r => {
    const d = r.querySelector('#statsbox');
    const shares = [...r.querySelectorAll('.tile.share .v')].map(x => parseInt(x.textContent));
    // "Songs by status": songs and plays per group, to work out which cards should show (2+ songs or 1%+ of plays)
    const by = {};
    for (const l of r.querySelectorAll('#statsbox .sline')) {
      const c = l.querySelector('.chip'), m = /(\d+) songs? \(\d+%\), (\d+) plays?/.exec(l.textContent);
      if (c && m) by[c.className.replace('chip ', '')] = { songs: +m[1], plays: +m[2] };
    }
    const total = Object.keys(by).reduce((a, k) => a + by[k].plays, 0), g = k => by[k] || { songs: 0, plays: 0 };
    const worth = (s, p) => s >= 2 || p / total * 100 >= 1;
    const otherWorth = worth(g('other').songs, g('other').plays), noneWorth = worth(g('none').songs + g('gone').songs, g('none').plays + g('gone').plays);
    return { open: d.open, overflow: d.scrollWidth > d.clientWidth + 1, sections: r.querySelectorAll('.ssec').length, shareSum: shares.reduce((a, b) => a + b, 0), shareCount: shares.length, otherTile: !!r.querySelector('.tile.share.other'), otherWorth, noneTile: !!r.querySelector('.tile.share.none'), noneWorth, by, backTile: !!r.querySelector('.tile.back'),
      headline: [...r.querySelectorAll('.sline')].map(x => x.textContent).find(x => /comes back about every/.test(x)) || '' };
  });
  check('Stats opens without overflow', stats.open && !stats.overflow && stats.sections >= 6, JSON.stringify(stats));
  check('Stats shares add up to about 100%', stats.shareCount === 2 + (stats.otherWorth ? 1 : 0) + (stats.noneWorth ? 1 : 0) && Math.abs(stats.shareSum - 100) <= 3, String(stats.shareSum));
  check('The "not in your playlist" share shows only with 2+ songs or 1%+ of plays', stats.noneTile === stats.noneWorth, JSON.stringify(stats));
  check('The "comes back" card shows exactly when "not in your playlist" is hidden', stats.noneTile === !stats.backTile, JSON.stringify(stats));
  check('The "another version" share shows only with 2+ songs or 1%+ of plays', stats.otherTile === stats.otherWorth, JSON.stringify(stats));
  check('Stats shows the replay headline', /\d/.test(stats.headline), stats.headline);
  const statLens = await inShadow(page, r => r.querySelectorAll('#statsbox .slist .nm small .len').length);
  check('Stats song lists show song lengths', statLens > 5, String(statLens));
  const sStars = await inShadow(page, r => r.querySelectorAll('#statsbox button.fav').length);
  await inShadow(page, r => r.querySelector('#statsbox button.fav[aria-pressed="false"]').click());
  await settle(page); await page.waitForTimeout(200);
  const sOn = await inShadow(page, r => r.querySelectorAll('#statsbox button.fav[aria-pressed="true"]').length);
  await inShadow(page, r => r.querySelector('#statsbox button.fav[aria-pressed="true"]').click());   // and back, so one favorite stays
  await settle(page); await page.waitForTimeout(200);
  const sAfter = await page.evaluate(() => { const f = window.__store.favorites || {}; return Object.keys(f).filter(k => f[k].on).length; });
  const sCats = await inShadow(page, r => ({ line: [...r.querySelectorAll('#statsbox .sline')].map(x => x.textContent).find(x => /^Categories:/.test(x)) || '',
    none: [...r.querySelectorAll('#statsbox .sdet summary')].map(x => x.textContent).find(x => /No category yet/.test(x)) || '', sels: r.querySelectorAll('#statsbox .sdet button.cat').length }));
  check('Stats counts categories and lists songs without one', /Dance 1/.test(sCats.line) && /No category yet: [0-9]+/.test(sCats.none) && sCats.sels > 10, JSON.stringify(sCats));
  check('Stats has stars for playlist songs, and tapping one updates it in place', sStars > 3 && sOn >= 1 && sAfter === 1, `${sStars} stars, ${sOn} on, ${sAfter} saved`);
  await inShadow(page, r => [...r.querySelectorAll('.seg button')].find(b => b.textContent === 'Most recent').click());
  await settle(page); await page.waitForTimeout(200);
  check('Stats "Most recent" sort switches the list', await inShadow(page, r => /Most recently replayed/.test(r.querySelector('.sechead h3').textContent)));
  await inShadow(page, r => r.querySelector('#statsclose').click());
  check('Stats closes', !(await inShadow(page, r => r.querySelector('#statsbox').open)));

  // Backup: export, then import the same data back (merge adds nothing)
  await inShadow(page, r => r.querySelector('#backup').click());
  await page.waitForTimeout(200);
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }).catch(() => null), inShadow(page, r => r.querySelector('#bkdown').click())]);
  check('Backup downloads a file', !!dl, 'no download event');
  if (dl) {
    await page.locator('#xm-host #bkfile').setInputFiles(await dl.path());
    await page.waitForTimeout(500);
    const pv = await inShadow(page, r => [...r.querySelectorAll('.bpreview li')].map(x => x.textContent).join(' / '));
    check('Importing your own backup previews "0 of them aren\'t on this device"', /; 0 of them aren't on this device yet/.test(pv) && /, 1 favorites, 1 categories,/.test(pv), pv);
  }
  await inShadow(page, r => { r.querySelector('#bkpaste').value = '{"hello":1}'; r.querySelector('#bkread').click(); });
  await settle(page); await page.waitForTimeout(200);
  check('A file that isn\'t a backup is refused', /Nothing was changed/.test(await inShadow(page, r => r.querySelector('#bkinmsg').textContent)));
  await inShadow(page, r => r.querySelector('#bkclose').click());

  // A wrong automatic match can be linked to another video (3.12.4)
  const fix = await inShadow(page, r => {
    const li = [...r.querySelectorAll('li.have')].find(x => [...x.querySelectorAll('button')].some(b => b.textContent === 'Wrong video?'));
    if (!li) return null;
    const was = li.querySelector('a.open').href;
    [...li.querySelectorAll('button')].find(b => b.textContent === 'Wrong video?').click();
    return { was, title: li.querySelector('.title').firstChild.textContent };
  });
  await settle(page); await page.waitForTimeout(200);
  const offered = await inShadow(page, (r, was) => {
    const p = r.querySelector('.picker');
    if (!p) return null;
    const labels = [...p.querySelectorAll('.pbtns button')].map(b => b.textContent);
    return { n: p.querySelectorAll('.choice').length, labels };
  });
  check('"Wrong video?" opens the picker with "Not in playlist" instead of "Mark without linking"',
    fix && offered && offered.labels.join() === '✗ Not in playlist,Cancel', JSON.stringify({ fix, offered }));
  check('An automatic match has no "Not this one" button', await inShadow(page, r => ![...r.querySelectorAll('li.have button')].some(b => /Not this one/.test(b.textContent))));
  if (offered && !offered.n) {   // no close matches besides the current one: search the playlist
    await inShadow(page, r => { const i = r.querySelector('#xm-pick'); i.value = 'christmas'; i.dispatchEvent(new Event('input')); });
    await settle(page);
  }
  const pick = await inShadow(page, (r, was) => {
    const c = [...r.querySelectorAll('.picker .choice')];
    return c.length;
  });
  check('The picker offers other videos', pick > 0, String(pick));
  if (pick) {
    await inShadow(page, r => r.querySelector('.picker .choice').click());
    await page.waitForTimeout(1200); await settle(page);
    const after = await inShadow(page, (r, title) => {
      const li = [...r.querySelectorAll('ol > li')].find(x => x.querySelector('.title') && x.querySelector('.title').firstChild.textContent === title);
      return li ? { pill: li.querySelector('.pill').textContent, open: (li.querySelector('a.open') || {}).href } : null;
    }, fix.title);
    check('Choosing another video relinks the song', after && /linked/.test(after.pill) && after.open !== fix.was, JSON.stringify(after));
  }

  const notTitle = await inShadow(page, r => {
    const li = [...r.querySelectorAll('li.have')].find(x => [...x.querySelectorAll('button')].some(b => b.textContent === 'Wrong video?'));
    if (!li) return null;
    [...li.querySelectorAll('button')].find(b => b.textContent === 'Wrong video?').click();
    return li.querySelector('.title').firstChild.textContent;
  });
  await settle(page); await page.waitForTimeout(200);
  await inShadow(page, r => [...r.querySelectorAll('.picker .pbtns button')].find(b => /Not in playlist/.test(b.textContent)).click());
  await settle(page); await page.waitForTimeout(200);
  const notPill = await inShadow(page, (r, title) => {
    const li = [...r.querySelectorAll('ol > li')].find(x => x.querySelector('.title') && x.querySelector('.title').firstChild.textContent === title);
    return li ? li.className + ' / ' + li.querySelector('.pill').textContent : '';
  }, notTitle);
  check('"Not in playlist" in the picker marks the song not in the playlist', notTitle && /^none/.test(notPill) && /Not in playlist · marked/.test(notPill), notPill);

  // A mark changes only that song, and quickly
  const t0 = Date.now();
  await inShadow(page, r => { const b = [...r.querySelectorAll('li.none button')].find(x => /Dislike/.test(x.textContent)); if (b) b.click(); });
  await page.waitForFunction(() => !document.getElementById('xm-host').shadowRoot.host.classList.contains('working'), null, { timeout: 10000 }).catch(() => {});
  check('Dislike responds quickly (under 1.5 s)', Date.now() - t0 < 1500, `${Date.now() - t0} ms`);

  check('no script errors during interactions', errors.length === 0, errors.join(' | '));
  await ctx.close();

  // 3. Plays saved with a future date (SomaFM's feed, Oct 27, 2026) are cleared on load (3.12.6)
  {
    const h = seedHistory();
    const future = [h[0][0] + 86400, 'Ventures', 'Frosty The Snowman', '', 1];
    const fp = await openPage(browser, { width: 600, store: { 'history:christmas': [future].concat(h) } });
    const after = await fp.page.evaluate(() => window.__store['history:christmas']);
    const ahead = after.filter(p => p[0] > Date.now() / 1000 + 900).length;
    check('A play dated a day ahead is removed from the saved history', ahead === 0 && after.length >= h.length, JSON.stringify({ ahead, n: after.length, was: h.length + 1 }));
    check('Future plays: no script errors', fp.errors.length === 0, fp.errors.join(' | '));
    await fp.ctx.close();
  }

  // 4b. At 600 px (Dan's tablet) each chip row fits on one line, with a favorite count and every category in use (3.20.1)
  {
    const cats = {}, favs = {}, keys = ['band', 'classics', 'dance', 'jazz', 'mellow', 'soul'];
    for (let i = 0; i < items.length; i++) { cats[items[i].id] = { c: keys[i % 6], at: 1 }; if (i % 3 === 0) favs[items[i].id] = { on: true, at: 1 }; }
    const p = await openPage(browser, { width: 600, store: { categories: cats, favorites: favs, catFilters: ['uncat'] } });
    await settle(p.page);
    const lines = () => inShadow(p.page, r => [...r.querySelectorAll('header .filters')].map(f => { const b = [...f.querySelectorAll('button')].filter(x => x.offsetParent);
      const g = parseFloat(getComputedStyle(f).columnGap); return Math.round(b.reduce((t, x) => t + x.getBoundingClientRect().width + g, -g)) + '/' + f.clientWidth + 'px, ' + b.length + ' chips on ' + new Set(b.map(x => x.offsetTop)).size + ' line(s): ' + b.map(x => x.innerText.replace(/\s+/g, ' ')).join(' | '); }));
    const rows = await lines();
    check('600px: each chip row fits on one line', rows.length === 2 && rows.every(t => / on 1 line/.test(t)), rows.join(' // '));
    // Counts grow with the play history: with 999 in every chip, the rows get slightly smaller text instead of wrapping
    await inShadow(p.page, r => { for (const n of r.querySelectorAll('header .filters .n')) n.textContent = '999'; });
    await p.page.setViewportSize({ width: 601, height: 900 }); await p.page.waitForTimeout(200); await p.page.setViewportSize({ width: 600, height: 900 }); await p.page.waitForTimeout(300);
    const big = await lines();
    check('600px: with three-digit counts everywhere, each chip row still fits on one line', big.every(t => / on 1 line/.test(t)), big.join(' // '));
    await p.ctx.close();
  }

  // 4c. The cloud recorder (3.21) fills a stretch this device missed; a refused key is reported; setting it up from Backup / Restore
  {
    const hist = seedHistory(), g = hist[250], before = hist[251];   // seedHistory's first gap: 7 hours missed before hist[250]
    const filler = [[g[0], g[1], g[2], ''], [g[0] - 3600, 'Cloud Artist', 'Filled In One', 'Alb'], [g[0] - 7200, 'Cloud Artist', 'Filled In Two', 'Alb'], [before[0], before[1], before[2], '']];
    const cors = { 'access-control-allow-origin': 'https://somafm.com', 'access-control-allow-headers': 'Authorization, Content-Type', 'access-control-allow-methods': 'GET, POST, PUT, OPTIONS' };
    const asked = [], posted = [];
    // A stand-in recorder: plays, plays sent by the device, and the synced document (3.22) with its version check
    const doc = { version: 0, state: null, puts: [] };
    const recorder = key => async route => {
      const req = route.request(), u = new globalThis.URL(req.url());
      const reply = (body, status = 200) => route.fulfill({ status, headers: Object.assign({ 'content-type': 'application/json' }, cors), body: JSON.stringify(body) });
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      asked.push(req.method() + ' ' + u.pathname + u.search);
      if (req.headers().authorization !== 'Bearer ' + key) return reply({ error: 'wrong or missing key' }, 401);
      const now = Math.floor(Date.now() / 1000);
      if (u.pathname === '/state' && req.method() === 'GET') return reply({ version: doc.version, state: doc.state });
      if (u.pathname === '/state' && req.method() === 'PUT') {
        const b = JSON.parse(req.postData());
        if (b.base !== doc.version) return reply({ error: 'changed since', version: doc.version, state: doc.state }, 409);
        doc.version++; doc.state = b.state; doc.puts.push(b.state);
        return reply({ version: doc.version });
      }
      if (u.pathname === '/plays' && req.method() === 'POST') { const b = JSON.parse(req.postData()); posted.push(...b.plays); return reply({ received: b.plays.length, changed: 0 }); }
      return reply({ channel: 'christmas', now, recording: true, lastRun: { at: now - 120, ok: true, added: 3, note: '', lastOk: now - 120 }, plays: filler, breaks: [g[0] - 60] });
    };
    const KEY = 'testkey-0123456789abcdef';
    let p = await openPage(browser, { width: 600, store: { 'history:christmas': hist, cloud: { url: 'https://rec.test.workers.dev', key: KEY } }, recorder: recorder(KEY) });
    await settle(p.page);
    let st = await p.page.evaluate(gAt => { const h = window.__store['history:christmas'];
      return { n: h.filter(x => /^Filled In/.test(x[2])).length, gapCleared: !h.find(x => x[0] === gAt)[4], status: window.__store['cloud:status:christmas'], through: window.__store['cloud:through:christmas'] }; }, g[0]);
    check('The cloud recorder fills the plays this device missed, and that stretch is no longer marked as missed',
      st.n === 2 && st.gapCleared && st.status && st.status.ok && st.status.added === 2 && st.through > 0 && asked.indexOf('GET /plays?channel=christmas&since=0') >= 0, JSON.stringify(st) + ' ' + asked.join());
    check('First sync sends this device\'s whole play history, 500 at a time, and saves the synced document',
      posted.length === hist.length + Math.max(0, posted.length - hist.length) && posted.length >= hist.length && asked.filter(a => a.startsWith('POST /plays')).length === Math.ceil(posted.length / 500)
      && doc.version === 1 && doc.state && typeof doc.state.marks === 'object' && doc.state.removed && await p.page.evaluate(() => window.__store['cloud:pushed:christmas'] > 0), `posted ${posted.length} of ${hist.length}, version ${doc.version}`);
    // A change here is sent a few seconds later
    const starred = await inShadow(p.page, r => { for (const b of r.querySelectorAll('#cards > li.have button.fav')) if (b.getAttribute('aria-pressed') === 'false') { b.click(); return b.dataset.vid; } });
    await p.page.waitForTimeout(3800);
    check('A favorite set here reaches the synced document a few seconds later', doc.version === 2 && doc.state.favorites[starred] && doc.state.favorites[starred].on === true, JSON.stringify({ v: doc.version, starred }));
    await inShadow(p.page, r => r.querySelector('#backup').click());
    await p.page.waitForTimeout(200);
    const bt = await inShadow(p.page, r => r.querySelector('#cloudbody').textContent);
    check('Backup / Restore shows the cloud recorder working', /rec\.test\.workers\.dev/.test(bt) && /2 plays filled in/.test(bt) && /last read SomaFM's song list/.test(bt) && /Turn off on this device/.test(bt), bt);
    check('Backup / Restore hides Undo until something has been imported', await inShadow(p.page, r => r.querySelector('#bkundo').offsetParent === null));
    check('Cloud recorder: no script errors', p.errors.length === 0, p.errors.join(' | '));
    await p.ctx.close();

    // Another device: gets the favorite, a note and a category from the document; a mark cleared elsewhere is cleared here
    const key0 = Object.keys(doc.state.favorites)[0];
    doc.state = Object.assign({}, doc.state, { notes: { 'test|song': { t: 'From the other device', at: Date.now() } }, categories: { [key0]: { c: 'jazz', at: Date.now() } },
      removed: { marks: { 'gone|mark': Date.now() }, dislikes: {} } });
    doc.version++;
    p = await openPage(browser, { width: 600, store: { 'history:christmas': hist, cloud: { url: 'https://rec.test.workers.dev', key: KEY }, 'cloud:pushed:christmas': hist[0][0],
      marks: { 'gone|mark': { v: 'have', at: Date.now() - 86400000 }, 'kept|mark': { v: 'not', at: Date.now() } } }, recorder: recorder(KEY) });
    await settle(p.page);
    const other = await p.page.evaluate(k => ({ fav: (window.__store.favorites || {})[k], note: (window.__store.notes || {})['test|song'], cat: (window.__store.categories || {})[k], marks: Object.keys(window.__store.marks || {}).join() }), key0);
    check('Another device gets favorites, notes and categories from the synced document, and a mark cleared elsewhere is cleared there',
      other.fav && other.fav.on && other.note && other.note.t === 'From the other device' && other.cat && other.cat.c === 'jazz' && other.marks === 'kept|mark', JSON.stringify(other));
    check('That device sends its own mark back up, and keeps the removal', doc.state.marks['kept|mark'] && !doc.state.marks['gone|mark'] && doc.state.removed.marks['gone|mark'] > 0, JSON.stringify(doc.state.marks));
    check('Cloud sync: no script errors', p.errors.length === 0, p.errors.join(' | '));
    await p.ctx.close();

    // A refused key: the header says so
    p = await openPage(browser, { width: 600, store: { 'history:christmas': hist, cloud: { url: 'https://rec.test.workers.dev', key: 'wrong-0123456789abcdef' } }, recorder: recorder(KEY) });
    await settle(p.page);
    const warn = await inShadow(p.page, r => { const a = r.querySelector('#anote'); return a.hidden ? '' : a.textContent; });
    check('A key the recorder refuses is reported in the header', /cloud recorder refused the key/.test(warn), warn);
    await p.ctx.close();

    // Setting it up: a wrong code is refused, a refused key isn't saved, the right code is saved and fills in at once
    asked.length = 0;
    p = await openPage(browser, { width: 360, store: { 'history:christmas': hist }, recorder: recorder(KEY) });
    await settle(p.page);
    await inShadow(p.page, r => r.querySelector('#backup').click());
    await p.page.waitForTimeout(200);
    const save = async code => { await p.page.locator('#cloudcode').fill(code); await inShadow(p.page, r => [...r.querySelectorAll('#cloudbody button')].find(b => b.textContent === 'Save').click()); await p.page.waitForTimeout(400); return inShadow(p.page, r => r.querySelector('#cloudbody').textContent); };
    const t1 = await save('not a code');
    const t2 = await save('https://rec.test.workers.dev#wrong-0123456789abcdef');
    const saved2 = await p.page.evaluate(() => window.__store.cloud || null);
    const t3 = await save('https://rec.test.workers.dev/#' + KEY);
    const after = await p.page.evaluate(() => ({ cloud: window.__store.cloud, n: window.__store['history:christmas'].filter(x => /^Filled In/.test(x[2])).length }));
    check('Setting up the recorder: a wrong code and a refused key are not saved; the right code is saved and fills in at once',
      /doesn't look like a setup code/.test(t1) && /Not saved: the recorder refused the key/.test(t2) && !saved2 && after.cloud && after.cloud.url === 'https://rec.test.workers.dev' && after.n === 2 && /2 plays filled in/.test(t3), JSON.stringify([t1, t2, t3, after]));
    check('360px: Backup / Restore with the recorder has no sideways scrolling', await inShadow(p.page, r => { const d = r.querySelector('#backupbox'); return d.scrollWidth <= d.clientWidth + 1; }));
    await inShadow(p.page, r => [...r.querySelectorAll('#cloudbody button')].find(b => b.textContent === 'Turn off on this device').click());
    await inShadow(p.page, r => [...r.querySelectorAll('#cloudbody button')].find(b => b.textContent === 'Tap again to turn off').click());
    await p.page.waitForTimeout(200);
    const off = await p.page.evaluate(() => ({ cloud: window.__store.cloud, n: window.__store['history:christmas'].filter(x => /^Filled In/.test(x[2])).length }));
    check('Turning it off takes two taps and keeps the plays filled in', !off.cloud && off.n === 2, JSON.stringify(off));
    await p.ctx.close();
  }

  // 4a. A saved Per page of 200 becomes 250 (3.18.4)
  {
    const p = await openPage(browser, { width: 600, store: { pageSize: 200 } });
    await settle(p.page);
    const t = await inShadow(p.page, r => r.querySelector('#per').textContent + ' ' + r.querySelector('#pos').textContent);
    check('A saved Per page of 200 shows as 250', /^250▾ 1–250 of/.test(t), t);
    await p.ctx.close();
  }

  // 4. The "None" chip is hidden when every playlist song has a category, unless it's on (3.17.3)
  {
    const all = {};
    for (const it of items) all[it.id] = { c: 'mellow', at: 1 };
    const noneChip = async store => {
      const p = await openPage(browser, { width: 600, store });
      await settle(p.page);
      const r = await inShadow(p.page, r => { const b = [...r.querySelectorAll('.catf button:not(.favf)')].pop(); return { text: b.textContent, shown: b.offsetParent !== null, pressed: b.getAttribute('aria-pressed') }; });
      await p.ctx.close();
      return r;
    };
    const off = await noneChip({ categories: all }), on = await noneChip({ categories: all, catFilters: ['uncat'] });
    check('"None" is hidden when every song has a category, and stays while it\'s on', /^None/.test(off.text) && !off.shown && on.shown && on.pressed === 'true', JSON.stringify({ off, on }));
  }

  // 5. Once every "other version" is marked, Stats leaves out the "another version" share (3.18)
  {
    const p = await openPage(browser, { width: 600 });
    await settle(p.page);
    let had = 0;
    for (let i = 0; i < 40; i++) {
      const left = await inShadow(p.page, r => { const b = r.querySelector('ol > li.other button.marknot'); if (b) b.click(); return !!b; });
      if (!left) {
        // Not on this page of cards: show only "Other version" cards
        const more = await inShadow(p.page, r => { const f = [...r.querySelectorAll('.filters button')].find(b => /^Other version/.test(b.textContent)); const n = f ? Number(f.querySelector('.n').textContent) : 0; if (n && f.getAttribute('aria-pressed') !== 'true') { f.click(); return true; } return false; });
        if (!more) break;
      } else had++;
      await settle(p.page); await p.page.waitForTimeout(150);
    }
    await inShadow(p.page, r => r.querySelector('#stats').click());
    await p.page.waitForTimeout(500);
    const s = await inShadow(p.page, r => ({ tiles: r.querySelectorAll('.tile.share').length, other: !!r.querySelector('.tile.share.other') }));
    check('With no other versions left, Stats leaves out the "another version" share', had > 0 && s.tiles === 3 && !s.other, JSON.stringify(Object.assign({ marked: had }, s)));
    check('Marking other versions: no script errors', p.errors.length === 0, p.errors.join(' | '));
    await p.ctx.close();
  }

  // 6. The Christmas Lounge site (site/public): the same script as a web page, against a stand-in for its /api
  {
    const SITE_URL = 'https://xmaslounge.test/';
    const file = f => fs.readFileSync(path.join(__dirname, f), 'utf8');
    const hist = seedHistory();
    const api = { calls: [], auth: 0, posted: 0, doc: { version: 0, state: null }, signedIn: true };
    const openSite = async () => {
      const ctx = await browser.newContext({ viewport: { width: 600, height: 1000 }, timezoneId: 'America/New_York' });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      // Google's sign-in, standing in: straight back to the site with an access key, as the real one does after you choose an account
      await ctx.route('https://accounts.google.com/**', route => {
        const q = new globalThis.URL(route.request().url()).searchParams;
        const back = q.get('redirect_uri') + '#' + new URLSearchParams({ state: q.get('state'), access_token: 'site-token', expires_in: '3600', token_type: 'Bearer' });
        route.fulfill({ status: 200, contentType: 'text/html', body: '<script>location.replace(' + JSON.stringify(back) + ')</script>' });
      });
      await ctx.route('https://www.googleapis.com/**', route => route.abort());   // the shuffle that follows stops at YouTube, keeping the key
      await ctx.route(SITE_URL + '**', route => {
        const req = route.request(), u = new globalThis.URL(req.url()), p = u.pathname;
        const send = (body, type = 'application/json', status = 200) => route.fulfill({ status, contentType: type, body: typeof body === 'string' ? body : JSON.stringify(body) });
        if (p === '/') return send(file('site/public/index.html'), 'text/html');
        if (p === '/site.js') return send(file('site/public/site.js'), 'text/javascript');
        if (p === '/soma-xmas-checker.user.js') return send(file('soma-xmas-checker.user.js'), 'text/javascript');
        api.calls.push(req.method() + ' ' + p);
        if (req.headers().authorization) api.auth++;
        if (!api.signedIn) return send({ error: 'sign in' }, 'application/json', 401);
        const now = Math.floor(Date.now() / 1000);
        if (p === '/api/config') return send({ clientId: 'built-in.apps.googleusercontent.com' });
        if (p === '/api/feed') return send({ songs: [{ date: String(now - 30), artist: 'Site Artist', title: 'Played Through The Site', album: '' }].concat(hist.slice(0, 15).map(x => ({ date: String(x[0]), artist: x[1], title: x[2], album: '' }))) });
        if (p === '/api/playlist') return send({ items, hidden: 0, complete: true, read: items.length, expected: items.length });
        if (p === '/api/plays' && req.method() === 'POST') { api.posted += JSON.parse(req.postData()).plays.length; return send({ received: 1, changed: 0 }); }
        if (p === '/api/plays') return send({ channel: 'christmas', now, recording: true, lastRun: { at: now - 60, ok: true, added: 1, note: '', lastOk: now - 60 }, plays: hist, breaks: [] });
        if (p === '/api/state' && req.method() === 'GET') return send({ version: api.doc.version, state: api.doc.state });
        if (p === '/api/state' && req.method() === 'PUT') { const b = JSON.parse(req.postData()); api.doc = { version: api.doc.version + 1, state: b.state }; return send({ version: api.doc.version }); }
        return send({ error: 'not found' }, 'application/json', 404);
      });
      await page.goto(SITE_URL, { waitUntil: 'load' });
      await page.waitForFunction(() => { const h = document.getElementById('xm-host'); return h && h.shadowRoot && h.shadowRoot.querySelectorAll('#cards > li').length > 0; }, null, { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1500);
      return { ctx, page, errors };
    };
    let s = await openSite();
    const first = await inShadow(s.page, r => ({ h1: r.querySelector('h1').textContent, cards: r.querySelectorAll('#cards > li').length, have: r.querySelectorAll('#cards > li.have').length,
      first: (r.querySelector('#cards > li .title, #cards > li') || {}).textContent || '' }));
    check('Site: the checker runs as a web page, named Christmas Lounge, with the playlist and plays from its /api',
      first.h1 === 'Christmas Lounge' && first.cards > 0 && first.have > 0 && /Played Through The Site/.test(first.first)
      && api.calls.indexOf('GET /api/playlist') >= 0 && api.calls.indexOf('GET /api/feed') >= 0, JSON.stringify(first) + ' ' + api.calls.join());
    check('Site: syncs with no recorder key (Access signs it in): sends its plays, saves the synced document, no Authorization header',
      api.auth === 0 && api.posted > 0 && api.doc.version >= 1 && api.calls.indexOf('GET /api/plays') >= 0, JSON.stringify({ auth: api.auth, posted: api.posted, v: api.doc.version }));
    await inShadow(s.page, r => r.querySelector('#backup').click());
    await s.page.waitForTimeout(400);
    const cloud = await inShadow(s.page, r => ({ code: !!r.querySelector('#cloudcode'), text: r.querySelector('#cloudbody').textContent, buttons: [...r.querySelectorAll('#cloudbody button')].map(b => b.textContent).join() }));
    check('Site: Backup / Restore has no setup code to paste and no Turn off, just the sync status and Sync now',
      !cloud.code && /Built into this site/.test(cloud.text) && cloud.buttons === 'Sync now', JSON.stringify(cloud));
    await inShadow(s.page, r => { const d = r.querySelector('#backupbox'); if (d.close) d.close(); else d.removeAttribute('open'); });
    await inShadow(s.page, r => r.querySelector('#shuffle').click());
    await s.page.waitForTimeout(400);
    const shuf = await inShadow(s.page, r => ({ setup: !!r.querySelector('#shclient'), buttons: [...r.querySelectorAll('#shufbody button')].map(b => b.textContent).join() }));
    check('Site: Shuffle has the Client ID built in: straight to Sign in with Google, nothing to paste or change',
      !shuf.setup && /Sign in with Google/.test(shuf.buttons) && !/Change Client ID/.test(shuf.buttons), JSON.stringify(shuf));
    // Nov 1: the key came back to the Google window's own copy of the saved values, so this page waited forever
    const popup = s.page.waitForEvent('popup', { timeout: 10000 }).catch(() => null);
    await inShadow(s.page, r => { for (const b of r.querySelectorAll('#shufbody button')) if (/Sign in with Google/.test(b.textContent)) b.click(); });
    const win = await popup;
    if (win) await win.waitForEvent('close', { timeout: 10000 }).catch(() => {});
    await s.page.waitForTimeout(1500);
    const after = await s.page.evaluate(() => ({ token: (GM_getValue('signin:token', null) || {}).token || '', waiting: /Finish signing in/.test(document.getElementById('xm-host').shadowRoot.querySelector('#shufbody').textContent) }));
    check('Site: signing in to Google in its own window carries on in the page that asked (the key reaches it)',
      !!win && win.isClosed() && after.token === 'site-token' && !after.waiting, JSON.stringify({ popup: !!win, closed: win && win.isClosed(), after }));
    const saved = await s.page.evaluate(() => new Promise(res => { const r = indexedDB.open('xmaslounge'); r.onsuccess = () => { const q = r.result.transaction('kv').objectStore('kv').get('history:christmas'); q.onsuccess = () => res((q.result || []).length); q.onerror = () => res(-1); }; r.onerror = () => res(-1); }));
    check('Site: what the page saves is kept in this browser (IndexedDB)', saved >= hist.length, String(saved));
    check('Site: no script errors', s.errors.length === 0, s.errors.join(' | '));
    await s.ctx.close();
    api.signedIn = false;
    s = await openSite();
    const boot = await s.page.evaluate(() => (document.getElementById('boot') || {}).textContent || '');
    check('Site: when the sign-in has run out, the page says to reload to sign in', /Sign-in needed/.test(boot) && !(await s.page.$('#xm-host')), boot);
    await s.ctx.close();
  }
  await browser.close();

  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} page checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
