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

async function openPage(browser, { width, height = 1000, scheme = 'light', store = {} }) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, timezoneId: 'America/New_York', acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(URL, { waitUntil: 'load' });
  await page.evaluate(s => { window.__store = s; }, Object.assign({ playlist: { schema: 3, at: Date.now(), items, hidden: 0 }, 'history:christmas': seedHistory(), live: false }, store));
  await page.addScriptTag({ content: STUBS + script });
  await page.waitForTimeout(1500);
  return { ctx, page, errors };
}
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
