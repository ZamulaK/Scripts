// Reads a YouTube playlist with the YouTube Data API (for the Christmas Lounge site), in the userscript's
// Reader.read shape: { items: [{ id, title, ch, secs }], hidden, complete, read, expected }. The userscript reads
// YouTube's web pages instead, which only a browser extension can; the API needs a key (the site's YT_KEY secret).
// Videos that are deleted, private, or blocked in the US are counted in hidden, as YouTube's page hides them.
const API = 'https://www.googleapis.com/youtube/v3/';

// "PT1H2M3S" -> 3723
export function isoSeconds(d) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(d || ''));
  return m ? ((+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0)) : 0;
}
const blockedInUS = r => !!r && ((Array.isArray(r.blocked) && r.blocked.indexOf('US') >= 0) || (Array.isArray(r.allowed) && r.allowed.indexOf('US') < 0));

export async function readPlaylist(playlistId, key, fetchFn = fetch) {
  if (!key) throw Object.assign(new Error('the YouTube key is not set up on the site'), { status: 503 });
  const get = async (path, params) => {
    const r = await fetchFn(API + path + '?' + new URLSearchParams(Object.assign({ key }, params)));
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error('YouTube said: ' + ((d.error && d.error.message) || r.status)), { status: 502 });
    return d;
  };
  const entries = [];
  let total = 0, token = '';
  for (let guard = 0; guard < 100; guard++) {
    const d = await get('playlistItems', Object.assign({ part: 'snippet,contentDetails,status', maxResults: '50', playlistId }, token ? { pageToken: token } : {}));
    total = (d.pageInfo && d.pageInfo.totalResults) || total;
    for (const it of d.items || []) entries.push(it);
    token = d.nextPageToken || '';
    if (!token) break;
  }
  // Lengths and region blocks, 50 videos at a time; a video missing here was deleted
  const info = new Map();
  for (let i = 0; i < entries.length; i += 50) {
    const ids = entries.slice(i, i + 50).map(e => e.contentDetails && e.contentDetails.videoId).filter(Boolean);
    if (!ids.length) continue;
    const d = await get('videos', { part: 'contentDetails,status', id: ids.join(','), maxResults: '50' });
    for (const v of d.items || []) info.set(v.id, v);
  }
  const items = [];
  let hidden = 0;
  for (const e of entries) {
    const id = e.contentDetails && e.contentDetails.videoId, sn = e.snippet || {}, v = info.get(id);
    const privacy = (e.status && e.status.privacyStatus) || '';
    if (!id || !v || privacy === 'private' || privacy === 'privacyStatusUnspecified' || /^(Deleted|Private) video$/.test(sn.title || '') || blockedInUS(v.contentDetails && v.contentDetails.regionRestriction)) { hidden++; continue; }
    items.push({ id, title: String(sn.title || ''), ch: String(sn.videoOwnerChannelTitle || ''), secs: isoSeconds(v.contentDetails && v.contentDetails.duration) });
  }
  if (!items.length) throw Object.assign(new Error('no playable songs found (is the playlist public or unlisted?)'), { status: 502 });
  return { items, hidden, complete: entries.length >= total, read: entries.length, expected: Math.max(0, total - hidden) };
}
