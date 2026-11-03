// Shared by the mockups: the sample data (data.js, from Dan's own plays) and small helpers
window.XLH = (() => {
  const LABEL = { have: 'In playlist', other: 'Other version', none: 'Not in playlist', gone: 'Gone from playlist', disliked: 'Disliked' };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const time = at => new Date(at * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const day = at => new Date(at * 1000).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const short = at => new Date(at * 1000).toLocaleDateString([], { month: 'numeric', day: 'numeric' });
  const ago = at => { const m = Math.max(0, Math.round((Date.now() / 1000 - at) / 60)); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : Math.round(m / 60) + ' h ago'; };
  const initials = a => String(a || '?').replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  const hue = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
  const fmt = n => Number(n).toLocaleString('en-US');
  // The checker's categories: key, full name, short name
  const CATS = [['band', 'Band/Swing', 'Swing'], ['classics', 'Classics', 'Classics'], ['dance', 'Dance', 'Dance'], ['jazz', 'Jazz/Piano', 'Jazz'], ['mellow', 'Mellow', 'Mellow'], ['soul', 'Soul/Funk', 'Funk']];
  const CAT = {}; for (const [k, n] of CATS) CAT[k] = n;
  const store = { get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} } };
  return { LABEL, esc, time, day, short, ago, initials, hue, fmt, CATS, CAT, store };
})();
