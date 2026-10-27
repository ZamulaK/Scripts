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

async function openPage(browser, { width, height = 1000, scheme = 'light', store = {}, hash = '', api = null }) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, timezoneId: 'America/New_York', acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  if (api) await page.route('https://www.googleapis.com/**', api.handle);
  await page.goto(URL + hash, { waitUntil: 'load' });
  await page.evaluate(s => { window.__store = s; }, Object.assign({ playlist: { schema: 3, at: Date.now(), items, hidden: 0 }, 'history:christmas': seedHistory(), live: false }, store));
  await page.addScriptTag({ content: STUBS + script });
  await page.waitForTimeout(1500);
  return { ctx, page, errors };
}
// Fake YouTube Data API for the Shuffle panel: a playlist owned by the signed-in channel
function fakeApi(n) {
  const api = { order: [], puts: 0 };
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
      const b = ['#refresh', '#live', '#awake'].map(R), st = R('#stats'), h1 = R('h1');
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

  // Stats panel uses most of a desktop screen
  {
    const { ctx, page } = await openPage(browser, { width: 1600, scheme: 'dark' });
    await inShadow(page, r => r.querySelector('#stats').click());
    await page.waitForTimeout(500);
    const box = await inShadow(page, r => { const b = r.querySelector('#statsbox').getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(innerWidth - b.right), w: Math.round(b.width) }; });
    check('1600px: Stats panel is wide (over 1100 px) and centered', box.w > 1100 && Math.abs(box.l - box.r) <= 2, JSON.stringify(box));
    const cut = await inShadow(page, r => { r.querySelector('.ctbtn').click(); return [...r.querySelectorAll('.plog li')].filter(x => x.scrollWidth > x.clientWidth + 1).length; });
    check('1600px: Stats play log entries are not cut off', cut === 0, String(cut));
    await ctx.close();
  }

  // Shuffle panel: first-time setup, then sign-in
  {
    const { ctx, page, errors } = await openPage(browser, { width: 360, scheme: 'light' });
    await inShadow(page, r => r.querySelector('#shuffle').click());
    await settle(page);
    check('Shuffle first asks for the Client ID', /Client ID/.test(await shufText(page)));
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
    const { ctx, page, errors } = await openPage(browser, { width: 600, scheme: 'dark', store: signedIn(), api });
    await inShadow(page, r => r.querySelector('#shuffle').click());
    const ready = await waitShuf(page, /New order/);
    const early = await page.evaluate(() => window.__store['shuffle:original:PLRpb0eQM5sYC0-Fhol0BnOwYygZy_UTyt']);
    check('Opening Shuffle saves the original order before anything is moved', early && api.puts === 0 && early.songs.length === 30 && early.songs[0].id === 'pi0' && /Saved just now/.test(await shufText(page)));
    const t = await shufText(page);
    const moves = Number((t.match(/takes (\d+) move/) || [])[1]);
    check('Shuffle reads the playlist and shows the new order and its cost', ready && /30 songs/.test(t) && moves > 15 && moves < 30 && /about [\d,]+ quota units/.test(t), t.slice(0, 200));
    check('600px: Shuffle panel has no sideways scrolling', await inShadow(page, r => { const d = r.querySelector('#shufbox'); return d.scrollWidth <= d.clientWidth + 1; }));
    await shufClick(page, 'Shuffle the playlist');
    check('Shuffle asks for a second tap before changing anything', /Tap again/.test(await shufText(page)) && api.puts === 0);
    await shufClick(page, 'Tap again to start');
    const done = await waitShuf(page, /Done\./);
    check('Shuffle moves the songs, checks the order, and reports done', done && api.puts === moves && api.order.join() !== api.start.join(), `puts ${api.puts}, moves ${moves}`);
    check('Shuffle remembers the earlier order and clears the job', await page.evaluate(() => !window.__store['shuffle:job:PLRpb0eQM5sYC0-Fhol0BnOwYygZy_UTyt'] && window.__store['shuffle:last:PLRpb0eQM5sYC0-Fhol0BnOwYygZy_UTyt'].before.length === 30));
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
  await page.locator('#xm-host #per').selectOption('25');
  await settle(page); await page.waitForTimeout(200);
  const pos = await inShadow(page, r => r.querySelector('#pos').textContent);
  check('Per page 25 shows 25 cards', /^1–25 of/.test(pos), pos);

  // Card play history
  const log = await inShadow(page, r => { const b = r.querySelector('.histbtn'); if (!b) return null; b.click(); return true; });
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
    return { open: d.open, overflow: d.scrollWidth > d.clientWidth + 1, sections: r.querySelectorAll('.ssec').length, shareSum: shares.reduce((a, b) => a + b, 0), shareCount: shares.length,
      headline: [...r.querySelectorAll('.sline')].map(x => x.textContent).find(x => /comes back about every/.test(x)) || '' };
  });
  check('Stats opens without overflow', stats.open && !stats.overflow && stats.sections >= 6, JSON.stringify(stats));
  check('Stats shares add up to about 100%', stats.shareCount === 4 && Math.abs(stats.shareSum - 100) <= 2, String(stats.shareSum));
  check('Stats shows the replay headline', /\d/.test(stats.headline), stats.headline);
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
    check('Importing your own backup previews "0 of them aren\'t on this device"', /; 0 of them aren't on this device yet/.test(pv), pv);
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
    return { was, title: li.querySelector('.title').textContent };
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
      const li = [...r.querySelectorAll('ol > li')].find(x => x.querySelector('.title') && x.querySelector('.title').textContent === title);
      return li ? { pill: li.querySelector('.pill').textContent, open: (li.querySelector('a.open') || {}).href } : null;
    }, fix.title);
    check('Choosing another video relinks the song', after && /linked/.test(after.pill) && after.open !== fix.was, JSON.stringify(after));
  }

  const notTitle = await inShadow(page, r => {
    const li = [...r.querySelectorAll('li.have')].find(x => [...x.querySelectorAll('button')].some(b => b.textContent === 'Wrong video?'));
    if (!li) return null;
    [...li.querySelectorAll('button')].find(b => b.textContent === 'Wrong video?').click();
    return li.querySelector('.title').textContent;
  });
  await settle(page); await page.waitForTimeout(200);
  await inShadow(page, r => [...r.querySelectorAll('.picker .pbtns button')].find(b => /Not in playlist/.test(b.textContent)).click());
  await settle(page); await page.waitForTimeout(200);
  const notPill = await inShadow(page, (r, title) => {
    const li = [...r.querySelectorAll('ol > li')].find(x => x.querySelector('.title') && x.querySelector('.title').textContent === title);
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
  await browser.close();

  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} page checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
