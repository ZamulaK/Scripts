// Christmas Lounge: runs the userscript (soma-xmas-checker.user.js, copied here when the site is deployed) as a web
// page. It stands in for Tampermonkey's functions: saved values live in this browser's IndexedDB, read into memory
// first because the script reads them without waiting. The site's /api answers only after the Cloudflare Access sign-in.
(async () => {
  const boot = document.getElementById('boot');
  const fail = msg => { boot.className = 'err'; boot.textContent = msg; };

  // Saved values: all read before the script starts; each change written back in the background
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('xmaslounge', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }).catch(() => null);
  const values = new Map();
  if (db) await new Promise(res => {
    const t = db.transaction('kv').objectStore('kv').openCursor();
    t.onsuccess = () => { const c = t.result; if (c) { values.set(c.key, c.value); c.continue(); } else res(); };
    t.onerror = () => res();
  });
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});   // so the browser doesn't clear it
  const copy = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));   // like Tampermonkey: a fresh copy each time
  const store = (k, v) => {
    if (!db) return;
    try { const os = db.transaction('kv', 'readwrite').objectStore('kv'); if (v === undefined) os.delete(k); else os.put(v, k); } catch (e) { /* kept in memory */ }
  };
  window.GM_getValue = (k, d) => values.has(k) ? copy(values.get(k)) : d;
  window.GM_setValue = (k, v) => { const c = copy(v); if (c === undefined) values.delete(k); else values.set(k, c); store(k, c); };
  window.GM_listValues = () => Array.from(values.keys());
  window.GM_setClipboard = text => { navigator.clipboard.writeText(text).catch(() => {}); };
  window.GM_xmlhttpRequest = () => { throw new Error('not on the site'); };

  // What the page needs built in, then the script itself
  let conf;
  try {
    const r = await fetch('/api/config', { cache: 'no-store' });
    if (r.status === 401) return fail('Sign-in needed. Reload the page to sign in with Google.');
    if (!r.ok) return fail(`The site answered ${r.status}. Try reloading.`);
    conf = await r.json();
  } catch (e) { return fail("The site couldn't be reached. If the sign-in ran out, reload the page."); }
  window.XMAS_SITE = { api: '/api', clientId: conf.clientId || '', station: 'Christmas Lounge' };
  let src;
  try {
    const r = await fetch('/soma-xmas-checker.user.js', { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    src = await r.text();
  } catch (e) { return fail("The page's script couldn't be loaded. Try reloading."); }
  window.GM_info = { script: { version: (src.match(/@version\s+(\S+)/) || [])[1] || '' } };
  boot.remove();
  const s = document.createElement('script');
  s.textContent = src + '\n//# sourceURL=soma-xmas-checker.user.js';
  document.body.appendChild(s);
})();
