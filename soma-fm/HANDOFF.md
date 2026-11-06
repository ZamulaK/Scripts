# SomaFM → Xmas Mixed checker: handoff

Handoff from a claude.ai conversation (Oct 24–26, 2026) to Claude Code. Current version: **3.26.0**. **Next session: start with §8d (its later paragraphs cover Nov 5). The live site is https://xmaslounge.zamulagh.fyi (Dan's own domain since Nov 5; xmaslounge.pages.dev redirects there) and the test address https://next.xmaslounge.zamulagh.fyi; the old site is kept at /old/. Since Nov 5 the site also plays the station (Listen), casts to a Chromecast, has a Material 3 look, and is an installed Android app (PWABuilder package fyi.zamulagh.xmaslounge).**

The project lives in the `soma-fm/` folder of Dan's public GitHub repo `ZamulaK/Scripts` (local clone:
`C:\Utility\Scripts\UserScripts`), next to his other userscripts. Claude may commit and push changes to it.
Read this file before changing anything. `CLAUDE.md` holds the short list of rules; this file explains them.

---

## 1. What this is

A Tampermonkey userscript for Dan's tablet (and soon his laptop). It takes over SomaFM's
[Christmas Lounge song history page](https://somafm.com/christmas/songhistory.html) and shows each song
SomaFM plays against Dan's public YouTube playlist **"Xmas Mixed"** (`PLRpb0eQM5sYC0-Fhol0BnOwYygZy_UTyt`):

- **In playlist** (green pill), **Other version** (amber: same song, different artist or mix), **Not in playlist** (red), **Gone from playlist**, **Disliked**.
- Buttons: **Open** (the matching playlist video), **Search YouTube**, **✓ I have it** (links to a chosen playlist video), **✗ Not this one**, **👎 Dislike**, Undo / Unlink.
- It **records every play** while open (SomaFM's feed covers about the last hour), with dates, gap markers, paging, CSV export, and **Backup / Restore** between devices.
- A **📊 Stats** panel: playlist length, songs heard so far, share of plays you have / don't / dislike, rotation estimates, top-10 lists with per-song play logs.

The point: Dan listens to SomaFM, adds songs he likes to his playlist, and wants to (1) know instantly whether a
song is already there, (2) find the ones he doesn't have, and (3) understand SomaFM's rotation.

## 2. Where Dan runs it

- **Since Nov 2026: the Christmas Lounge site only** (§8c), on all his devices. The Tampermonkey script is **frozen**: Dan no longer uses it. The site still runs this same file, so changes here still ship to the site; Tampermonkey copies would update too, but none are in use.
- **Tablet:** Quetta browser (Chromium-based) with Tampermonkey. Portrait width is about **600 CSS px**, and that's the main layout target.
- **Laptop (next):** a desktop browser with Tampermonkey, kept running with PowerToys Awake for continuous recording.
  The site needs to be excluded from tab sleeping (Edge "Never put these sites to sleep" / Chrome "Always keep these sites active").
- Tampermonkey storage is **per browser**. Moving data between devices uses Backup / Restore (merge).
- **Updates arrive automatically** (since 3.11.1): `@updateURL` / `@downloadURL` point at the raw file on GitHub's `main`
  branch, and Tampermonkey installs any higher `@version` it finds there. So **every push to `main` ships to Dan's devices**;
  push only after the regression gates pass. Every change bumps `@version` (and `package.json`, which a source check enforces).
  Import from file (Dashboard → Utilities) still works for testing a build before pushing it.

## 3. Files

| File | What it is |
|---|---|
| `soma-xmas-checker.user.js` | The whole userscript. One file, by design, so it can be imported into Tampermonkey as-is. |
| `soma-xmas-checker.test.js` | Unit tests for the pure modules (`npm test`). Runs everything twice: normally, and with built-ins sabotaged the way SomaFM's prototype.js breaks them. Also a source check (see §7.4). |
| `xmas-mixed-original-order.csv` | The playlist's original order (129 songs: position, title, channel, video link), read Oct 26, 2026 from Dan's machine before the first shuffle. A permanent copy outside Tampermonkey; Dan was fine with it being public. |
| `playlist.fixture.json` | Snapshot of 61 songs from the playlist (Oct 24) that the matching tests run against. |
| `page-check.js` | Real-page regression check (`npm run test:page`): loads SomaFM's live page in headless Chromium with stand-ins for Tampermonkey, checks layout at 1024/768/600/400/360 px, light and dark, plus Stats, Backup, Per page, card play history, and response time. Needs internet to somafm.com, and never contacts YouTube. |
| `package.json` | `npm test`, `npm run test:page`. Playwright is a dev dependency. |
| `worker/` | The cloud recorder (3.21): a Cloudflare Worker that reads SomaFM's song list every 10 minutes into a D1 database, reusing `History` from the userscript. Its own `package.json` (wrangler), tests (`npm test` there) and README with the setup steps. |

First-time setup on a new machine: `npm install`, then `npx playwright install chromium`.

## 4. How it works

```
SomaFM page loads ──► main() hides SomaFM's layout, adds a viewport tag, mounts the UI in a shadow root
   │
   ├─ every 60 s (Live updates on): fetch /songs/christmas.json ──► History.fromFeed ──► History.merge into saved history
   │                                                                (gap marker if the feed no longer reaches back)
   ├─ on open, then every 2 min (Live on): cloud recorder — send new plays, /plays ──► History.union (fills missed stretches),
   │                                         /state ──► Sync.merge both ways (also 3 s after any change here)
   ├─ every 15 min (or Refresh): Reader.read(YouTube) ──► playlist items ──► Archive.update (remember titles, notice gone songs)
   │
   └─ render(): for each play shown, statusOf(row) =
          Matcher.check(artist, title, items)        automatic match
          → Matcher.applyMark(…, mark, disliked, items)  hand marks / links / dislikes
          → Archive.applyGone(…)                      was it in the playlist before?
        cached per song key (statusCache); cleared only for what changed
```

### Modules (all in the one file)

| Module | Pure? | Responsibility |
|---|---|---|
| `Matcher` | yes | Song matching, search text, mark keys, hand-mark logic, suggestions and search for linking, unavailable-video test, array helpers that are safe under prototype.js (`anyOf`, `allOf`, `mapOf`, `keep`). |
| `History` | yes | Play history: feed → plays, merging with gap detection, date/time formats, CSV, coverage (playlist songs heard), playlist length stats. |
| `Archive` | yes | Remembering playlist titles, detecting songs gone from the playlist (with a safety stop), dismissing, flagging plays of gone songs. |
| `Backup` | yes | Backup file format, validation, merge rules (history, marks, dislikes, favorites, categories, archive), import preview. |
| `Stats` | yes | Everything in the Stats panel: counts, shares, rotation estimates, top lists, per-song play logs. |
| `Shuffle` | yes (I/O injected) | Shuffling the real playlist: Fisher-Yates order, the move plan, reading the playlist and making the moves through the YouTube Data API, owner check. `call(method, resource, params, body)` is injected so it can be tested with a fake API. See §8a. |
| `Cloud` | yes | The cloud recorder's setup code (`address#key`) and checking what it sends (`cleanPlays`, `cleanBreaks`) before it's merged. |
| `Sync` | yes | The synced document (3.22): `clean` (checked like a backup), `merge` (backup rules key by key, plus removals for marks and dislikes), `same` (key-order-free compare). 3.26 adds the `shuffle` part: each device's quota count for its day (summed for today), the order before the last change, and the last run; newer entry wins. The unfinished-shuffle job stays per device. |
| `Reader` | yes (I/O injected) | Reading the YouTube playlist: page parsing, the >100-song side-panel fallback, complete/incomplete reads. `read(get, post)` takes fetch functions so it can be tested with a fake YouTube. |
| `main()` | no | Everything on the page: UI, storage, timers, dialogs, event handlers. Runs only under Tampermonkey (the file exports the modules instead when loaded by Node). |

### Saved data (Tampermonkey `GM_getValue` / `GM_setValue`)

| Key | Contents |
|---|---|
| `history:<channel>` | Plays, newest first: `[unixSeconds, artist, title, album, afterGap?]`. `afterGap = 1` on the first play recorded after a stretch that was missed. Capped at `HISTORY_MAX` (10,000). |
| `breaks:<channel>` | Start times (unix seconds, newest first) of station IDs / breaks seen in the feed. Never shown; they end the song before them when measuring song lengths. Capped at 2,000. Not in backups (a missed break only nudges a median). |
| `playlist` | Cached playlist read: `{ schema, at, items: [{id, title, ch, secs}], hidden }`. Re-read when older than 15 min or when `schema !== CACHE_SCHEMA` (currently 3). |
| `archive:<playlistId>` | Every playlist song ever seen: `{ [videoId]: { id, title, ch, first, last, gone?, dismissed? } }` (ms). |
| `marks` | Hand marks by song key: `{ v: 'have' \| 'not', at, id? }`. `id` = linked playlist video. Old 1.x marks are a bare timestamp meaning "have". |
| `dislikes` | Song key → timestamp. Kept separate from marks so Undo restores exactly. |
| `favorites` | Playlist **video id** → `{ on, at }` (3.14). Keyed by video, not song key, so Shuffle can use it and every SomaFM song linked to the video shares the star. Removing keeps `on: false` so a backup merge (newer `at` wins) doesn't bring it back. In backups. |
| `categories` | Playlist video id → `{ c, at }` (3.15), `c` one of the keys in `CATEGORIES` (band, classics, dance, jazz, mellow, soul; names can change, keys can't), `''` once cleared. Same merge rule as favorites. In backups. |
| `latestOnly` | "Latest" toggle: one card per song, at its most recent play (per device). |
| `notes` | Song key (same as marks and dislikes) → `{ t, at }` (3.18), a free-text note on any song, e.g. why a disliked song can't be added (no SomaFM version on YouTube). Dan preferred a note over more playlist statuses. Deleting keeps `t: ''`; same merge rule as favorites. In backups. |
| `catFilters` | Category chips that are on (`band` … `soul`, `uncat` for "None"); none on means no category filter (per device). |
| `backup:beforeImport` | `{ at, data }` saved before every import, for "Undo last import". |
| `cloud` | The cloud recorder's `{ url, key }` (3.21), from the setup code pasted in Backup / Restore. Per device, not in backups, kept out of the repo. |
| `cloud:through:<channel>`, `cloud:status:<channel>` | The recorder's "now" at the last check (the next asks from an hour before it), and how the last check went (`{ at, ok, added, filled, total, run, note }`), shown in Backup / Restore and as a header warning when something's wrong. |
| `removed` | When this device cleared a mark or dislike: `{ marks: { key: ms }, dislikes: { key: ms } }` (3.22). Synced, so a cleared one isn't brought back from another device; one set again later wins. Not in backups. |
| `cloud:pushed:<channel>`, `cloud:sync` | The newest play time sent to the recorder (0 sends the whole history: at setup and after a backup import), and how the last document sync went. |
| `signin:clientId` | Dan's Google OAuth Client ID (pasted into the Shuffle panel once per device; kept out of the public repo). |
| `signin:pending`, `signin:token`, `signin:reopen` | Sign-in in progress (random `state`, popup or same tab); the one-hour access key `{ token, at, exp }`; "reopen Shuffle after a same-tab sign-in". |
| `shuffle:job:<playlistId>` | A shuffle or put-back in progress: `{ target, before, kind: 'shuffle' \| 'undo', at }`. Saved before the first move; cleared once the read-back confirms the order. |
| `shuffle:original:<playlistId>` | `{ at, playlistId, songs: [{ id, videoId, title }] }`: the playlist's order before it was first changed. Saved once, never overwritten; **included in backups** (merge keeps the earliest saved; Replace keeps this device's if the backup has none). |
| `shuffle:last:<playlistId>` | `{ before, at }`: the order before the last shuffle, for "Show the earlier order". |
| `shuffle:units` | `{ day, units }`: this script's own estimate of quota used today (Pacific date). |
| `shuffle:lastRun` | `{ kind, at, units, moves, complete }`: quota used by the last shuffle or put-back, shown under the Quota line. |
| `filters`, `favOnly`, `live`, `pageSize`, `topSort` | Per-device settings. Not included in backups (nor are the `signin:`, `cloud` keys or the other `shuffle:` keys). |

**Song key** = `Matcher.markKey(artist, title)` = normalized artist + `|` + normalized title (case, accents, punctuation ignored). Marks, dislikes, stats and caches all use it.

### Outside sources

| Source | Used for | Notes |
|---|---|---|
| `https://somafm.com/songs/christmas.json` | Live play feed (same origin, plain `fetch`) | About 20 songs, about an hour. `date` is unix seconds. Titles and artists are **cut at 63 characters**. Station IDs are filtered out. |
| SomaFM's own history table | Fallback list if the feed fails | Times only, no dates; never saved to history. |
| `https://www.youtube.com/playlist?list=…` | First 100 playlist songs | Fetched via `GM_xmlhttpRequest` with **`anonymous: true`** (signed-out view) and a **desktop User-Agent** (tablets otherwise get redirected to m.youtube.com). Parses `ytInitialData`; the mobile escaped-string format is handled too. |
| `youtubei/v1/browse` (continuation) | Songs past 100 | **Returns empty for scripted requests** (as of Oct 2026). Still tried first in case it comes back. |
| `https://www.youtube.com/watch?v=<last>&list=…&index=<n>` | Songs past 100 | The watch page's playlist side panel lists the songs around position n. The script steps forward until the playlist's stated total is reached. |
| `https://accounts.google.com/o/oauth2/v2/auth` | Google sign-in for Shuffle | Implicit flow (`response_type=token`), scope `youtube`, returns to `SIGNIN_RETURN` (must match the OAuth client's redirect URI exactly). |
| `https://www.googleapis.com/youtube/v3/…` | Shuffle: `channels`, `playlists`, `playlistItems` list and update | Plain `fetch` with `Authorization: Bearer`. List = 1 unit, update = 50 units; 10,000 units a day (checked Oct 26, 2026). |
| `https://www.youtube.com/watch_videos?video_ids=a,b,c` | Not used (an alternative to Shuffle that was considered) | Builds a temporary queue **in the exact order given**, **max 50 videos**. Verified Oct 26 from a US connection. |

## 5. Hard-won gotchas (each one broke something once)

1. **SomaFM loads prototype.js 1.7.2**, which replaces `Array.from` (broken: `Array.from({length:3})` gives nulls) and `Array.prototype.map/some/every/find`. **Never use those in the script**; use `Matcher.anyOf / allOf / mapOf / keep` or plain loops. `filter`, `sort`, `slice`, `concat`, `forEach`, spread and `for…of` are fine. The unit tests sabotage these built-ins and run everything again to enforce this. Test code that runs during the sabotaged pass must avoid them too.
2. **The UI lives in a shadow root** (`#xm-host`), so SomaFM's CSS can't reach it. Query with `root.querySelector`, not `document`. Styles go in the template's `<style>`.
3. **Delayed actions lose `event.target`.** `runBusy()` waits one frame so "Working…" can paint. After that, an event's `target` inside the shadow root is cleared. **Read elements directly** (`$('#per').value`), never `e.target`, inside `runBusy` actions. This broke Per page from 3.9.0 to 3.10.0. A source check in the unit tests now fails the build if it happens again.
4. **SomaFM's page has no viewport tag.** Without the one `main()` adds, phones and tablets lay the page out 980 px wide and shrink it.
5. **YouTube from non-US servers hides region-blocked songs** (from Anthropic's cloud, 41 of 78 were hidden). Anything checking real playlist contents must run from a US connection, such as Dan's machines.
6. **The 63-character cutoff** in SomaFM titles and artists can leave an unclosed bracket (`[Rudolph the Red-Nosed Re`) or a word fragment. The matcher treats an open bracket as closed and lets a final fragment match the start of a word (a one-letter fragment only after two or more matched words).
7. **Tampermonkey's sandbox:** `@connect` must list `www.youtube.com`, `m.youtube.com` and `youtube.com`, or requests fail as "network error".
8. **Background redraws are paused while a dialog or the song picker is open** (`quietRender()` + `renderPending`), then caught up on close. Rendering under an open dialog made closing it lag.
9. **Performance (see also 14):** matching every recorded song against the playlist takes about 0.3 s on a desktop and over 2 s on a tablet. `statusCache` is keyed by song key: marks and dislikes **delete only that key**. Clear the whole cache only when the playlist or the gone list changes. **Compare contents, not objects** (`samePlaylist`, `goneSig`): every `GM_getValue` returns a new object, so until 3.15.1 the once-a-minute check cleared the cache and re-matched everything each minute (seconds-long freezes on a tablet). A background redraw also waits while a category menu is open (3.18.2; before that, a focused drop-down), since redrawing would close it.
10. **An incomplete playlist read must never mark songs as gone.** `Reader.read` reports `complete` only when it reaches the stated total (minus "N unavailable videos are hidden"). `Archive.update` also refuses if more than max(5, 25%) of songs vanish at once. Short or failed reads are retried twice (after 5 s and 15 s, `Reader.readRetry`); if still short, the fuller previous read is kept and the next check tries again. `loadPlaylist` runs one read at a time.
12. **Right after a reorder, YouTube's pages disagree.** On Oct 26, just after the first shuffle, the playlist page (first 100) showed the new order and the watch-page side panel (the rest) the old one. The count still came to 129, so the read looked complete, but 7 songs were repeats and 7 others were missing: they were marked gone, and 3 songs fell back to amber matches. Since 3.12.3, a read with more repeated songs than the last good read is not trusted (`Reader.consistent`): the previous read is kept, and it tries again in 15 minutes.
13. **SomaFM's feed can date plays in the future.** Around 2:58 AM on Oct 27, the christmas feed briefly listed the plays from 2:04–2:58 AM again, dated a day ahead (Oct 28). Both devices saved them, and since `History.merge` only adds plays newer than the newest saved one, nothing real was recorded after that. Since 3.12.6, `History.dropFuture` clears saved plays more than 15 minutes in the future when the page loads (also after a backup import). Since 3.12.7, `History.fromFeed` expects every feed play within [now − 6 h, now + 15 min] and moves one outside it by whole days into that window (`History.fixDate`); if no whole-day move fits, the time itself is wrong and the play is dropped. "Now" is SomaFM's server clock (the feed response's `Date` header), falling back to the device clock.
15. **SomaFM's feed can be an hour off around a daylight saving change.** When it ended on Nov 1, 2026, the christmas feed dated every play an hour late from about 07:00 to 08:00 UTC (2–3 AM Eastern), and an hour early from about 09:00 to 10:00 UTC. The recorder's stored times (`added` earlier than `at`) give it away. Everyone saved the 06:00 hour a second time, an hour later, and never saw the real plays of the two hours behind those wrong dates. That's about 2 hours lost, even though SomaFM kept playing. A play SomaFM listed an hour early (Deer Socks, 09:58:57 UTC) was saved at 08:58:57. Since 3.23.0, `History.feedShift` looks at the newest row, which is the song playing now. An hour ahead of now can't be real, so every date moves back an hour. An hour behind moves forward an hour, but only when plays were being recorded then and that song isn't one of them; an old copy of the list would repeat plays already recorded. Both the device and the recorder use it (the recorder passes its newest 60 plays). `History.repair` fixes what was already saved, on load, after a cloud pull and after an import. It drops a run of 3 or more plays that each repeat a song exactly an hour earlier, and flags the play after the run as after a gap. Then it moves the plays listed in `MOVED` (just Deer Socks). The live database was fixed by hand on Nov 1.
14. **Redrawing cards is layout-bound, not JS-bound.** Measured Oct 27 (3.15): with 50 cards a redraw spent ~0.8 s in layout at 2× CPU slowdown and only ~20 ms in script; 200 cards took several seconds. `#cards > li{content-visibility:auto}` lays out only cards on screen (about 9× faster). Stars and categories update their buttons in place (`sameVideo`) instead of calling `render()`. Measure with a CDP trace (`Layout`, `UpdateLayoutTree`), not wall-clock clicks: SomaFM's ads make those noisy.
11. **YouTube page formats change.** Parsing walks `ytInitialData` for `playlistVideoRenderer` / `playlistPanelVideoRenderer` / `continuationItemRenderer` wherever they are, rather than fixed paths. If a read breaks, the header says so (refuse and report) and songs aren't labeled.

## 6. Matching rules, and why

`Matcher.check(artist, title, items)` returns `have`, `other` (reason `sameArtistOtherMix` or `otherArtist`), or `none`, plus the playlist `item`.

- Titles are compared as **word sequences** after normalizing (case, accents, `&` → and, punctuation). "the a an and of" are ignored. One-letter typos are tolerated in words of 5+ letters (Ruldolph, Marshmellow).
- Leading "It's / Oh / O" are optional ("It's A Marshmallow World" ~ "Marshmallow World").
- **Artist must match for green.** All words of one credited artist must appear in the video title or channel (`- Topic` stripped). Ensemble words (trio, orchestra, band, his, …) are optional ("Vince Guaraldi Trio" ~ "Vince Guaraldi"). A name made only of those words is dropped.
- **Mixes:** if SomaFM names a mix (`[… Remix]` / `(… Mix)`, in title or artist), at least half its distinctive words must appear for green. Otherwise the result is amber, "Different mix".
- **Near-miss titles count only for the same artist:** one missing or extra word inside a longer title (SomaFM dropped "Very"), or a plural "s" ("Jingle Beats" ~ "Jingle Beat"). Introduced in 2.4.4 without the artist rule, it falsely matched "Christmas Time Is Here" to Kaskade's "Christmas Is Here". Fixed in 2.4.5.
- At equal rank, an **exact title beats a near-miss**, and an exact green match ends the search.

**Why conservative:** Dan prefers refuse-and-report over guess-and-apply. A wrong green hides a song he wants. A wrong red only costs a tap on "✓ I have it". Every reported miss became a test case. Fix the matcher with a test, rather than loosening it broadly.

**Hand marks:** "I have it" opens a picker (closest match first, then suggestions ranked by shared words, ignoring filler words like "you"; plus a search box). Choosing a video **links** the mark, which then counts toward "heard". Undo is two-level: **Unlink** keeps the mark, then **Undo** clears it. "Not this one" hides Open and the match line. Dislike applies only to songs that end up not in the playlist, and a later real match wins.

## 7. Stats, and what the data has shown

- **Share of plays / of songs** in four groups that add to 100%: in playlist, other version, not in playlist (includes gone), disliked.
- **Heard so far:** playlist songs matched automatically or by linked mark (unlinked marks don't say which video, so they don't count).
- **Replay headline = recorded time × different songs ÷ plays.** Gaps can't skew it: neither the time nor the plays inside a gap are counted. A simulation (3 songs at 10/30/90 min, 8 h unrecorded) gave a true 21 min and this estimate 21 min. It's in the tests.
- **Measured replays (since 3.23.0):** one average and median of the time between a song's plays (`Stats.intervals`). A gap-free replay always counts. One across a recording gap counts only when it's in line with that song's gap-free replays: the song has at least 2, and it's at most 25% longer than the longest (`GAP_FIT`). So for a song that comes back every ~8 h, a 22 h replay across a gap is left out, but for one that varies from 4 to 28 h it counts. Dan asked for this once the recorder made gaps rare; before that, the panel showed gap-free and across-gap averages separately, with which way each leaned.
- **Why the measured average runs above the gap-free one (checked Nov 1 on 2,423 plays):** gap-free replays averaged 11.5 h (1,339), the across-gap ones that count 13.9 h (570), the ones left out 29.5 h (268); all counted, 12.2 h; headline 14.7 h. Across-gap replays are longer because a longer replay is more likely to have a gap inside it, not because plays were missed, so the gap-free average alone runs short. Six gaps by then (Oct 26, 27, 28, a 10-minute one on Oct 29, and two on Nov 1) put 838 of the 2,177 replays across a gap. With the recorder running, that share drops as new replays come in.
- Per-song play logs (tap a count in Stats, or "▸ N plays" on a card) show every replay, read down each column (CSS `columns`). * marks a gap in between, and a replay left out of the averages is struck through.

**Dan's data (CSV, Oct 25–26):** 286 plays, 188 songs, 17.3 h recorded in two stretches (7.7 h evening, 9.6 h morning, 6.9 h gap).
94 songs heard once, 90 twice, 4 three times, so **no heavy rotation**. Headline 11.3 h. A per-song-median alternative
(12.9 h) was tested and **rejected**. In-stretch repeats (8.1, 8.1, 8.5, 9.0, 2.6 h) are capped by the 9.6 h stretch length, and the
count of in-stretch repeats fits a faster group of about 9–9.5 h with many slower songs. Counter-example: Eddie Dunstedter "I Saw
Mommy…" played 9:47 PM, then not until 2:48 PM. Dan's view: SomaFM probably plays a fixed list in random order, and it will even out.
**Decision: keep the headline as is; revisit with a long unbroken recording.**

## 8. UI notes

- **Header:** title left, 📊 Stats always top right. Refresh / Live sit under Stats when they fit beside the title. `fitHeader()` **measures** (full labels → short labels "Refresh / Live: On / Awake: On" → own row) and re-runs on resize and label changes. Dan explicitly asked for this arrangement at 600 px portrait.
- **Chips** toggle multi-select, All resets, and all-on = All. "Not in playlist" includes gone songs. The ⭐ chip (3.20, first on the category row) shows only favorites, together with any category chips; its count, like theirs, is cards and follows a star tap without a redraw. **Each chip row fits on one line at 600 px** (Dan asked, 3.20.1): below desktop width the chips are tighter and two status chips use short names ("Not in list", "In list"; the aria-label keeps the full one), and `fitChips()` measures each row and shrinks its text up to 15% if it would wrap, since the counts grow with the play history.
- **Cards:** shading = slate on not-in-playlist, lighter slate on other version, plain on matches, dashed on disliked. Every row of buttons must fit on **one line at tablet portrait width** (Dan's requirement).
- **"Working…"** pill shows after 150 ms for slow actions (`runBusy`). Dialogs are `<dialog>` with `showModal`, and tap outside closes.
- **Colors** are tokens in `:host` with a dark set under `prefers-color-scheme: dark`. Check contrast (white-on-button ≥ 4.5:1) when adding buttons.
- Before shipping UI changes, check 600 px (tablet portrait) and 360 px, light and dark, ideally with screenshots.

## 8a. Shuffle (3.12)

Dan wanted the playlist itself in a fair random order, because YouTube's own shuffle seems to favor some songs.
"🔀 Shuffle playlist" (footer) reorders the real playlist through the YouTube Data API.

- **Setup (done Oct 26):** an OAuth client of type Web application in Dan's Google Cloud project, JavaScript origin
  `https://somafm.com`, redirect URI `https://somafm.com/christmas/songhistory.html`, publishing status Testing with Dan as
  test user. The Client ID is pasted into the panel on each device. No client secret is used.
- **Sign-in:** a popup goes to Google; Google returns to the song history page with the key in the `#fragment`. `catchSignIn()`
  (runs before `main()`) checks `state` against `signin:pending`, saves the key, strips it from the address, and closes the
  popup. The waiting page polls `signin:token`. If popups are blocked, the sign-in happens in the same tab and Shuffle reopens.
- **Why so many units:** there's no bulk reorder, so each song is a `playlistItems.update` with a new position (50 units).
  `Shuffle.plan` keeps the longest group of songs already in the right relative order (longest increasing subsequence)
  and moves each other song straight after its new predecessor. That's about 95 moves for 116 songs, not 116 (about 4,750 units).
- **Safety:** checks that the signed-in channel owns the playlist; songs are only moved, never added or removed; two taps to
  start; a dropped connection or a busy YouTube (5xx, 409, 429, rate limits) is tried again after 2, 5, 15 and 30 s (3.19, `Shuffle.retrying`; never a used-up quota, sign-in or refusal; a move names its position, so resending one whose reply was lost is harmless); the read-back looks twice more (5 s, 15 s) before saying the order differs; the job is saved first, so a run cut short by quota, expiry, Stop or closing the page is finished next time; the playlist
  is read back and compared before it says Done; the order before the last change can be put back.
- **Spreading (3.14, Dan asked for it: "avoid 5 heads in a row"; distance = song positions, not time):** `Shuffle.arrange`
  starts from Fisher-Yates and then swaps songs (simulated annealing, 300 × n tries, about 0.2 s for 136 songs on a desktop) to lower
  `groupCost`. Favorites and each song's versions (`Matcher.sameTitle` on any title of either, joined through chains, medleys split at "/")
  are spaced evenly, counting around the end; same artist, album or uploading channel only get a "not closer than half the even spacing,
  max 12" penalty. Categories (3.15) aren't spaced: only runs longer than `maxRun` (3, or up to 5 for a category that's a big share: `ceil(share × 12)`) cost. Artist/title/album come from SomaFM's plays of that video (`somaInfo`), else the video title and channel: a side of
  "A - B" that matches an artist or channel name anywhere in the playlist (`nameWords`) is the artist, otherwise both sides count as titles.
  Swaps that don't change the cost are kept, so the rest of the order stays random. The rules are meant to be rough, not exact.
  A favorite is one of the first three songs (3.18, Dan asked for it): every rule counts around the end, so `arrange` just turns the
  finished order round to put a random favorite at position 0, 1 or 2, which leaves all spacing exactly as it was.
- **Original order (3.12.1, Dan asked for it):** saved when Shuffle first reads the playlist on a device (3.12.2; 3.12.1 waited for the first change), never overwritten, carried in backups,
  and downloadable as a CSV (position, title, video link). Putting it back keeps songs added since at the end and skips removed ones.
  A device with none saved says so, and suggests bringing in the other device's backup before shuffling there; otherwise that
  device would save its already-shuffled order as the "original".
- **Not yet seen on the real API:** a deleted or private video in the playlist may refuse to move. If that happens, the panel
  reports YouTube's message and the job can be finished or set aside.
- Playing it: shuffle off, playlist sort setting on **Manual** (otherwise YouTube shows another order).

## 8b. Cloud recorder (3.21)

Dan wanted history recorded unattended (the feed only covers about the last hour, so a sleeping tablet leaves gaps) and
all his data kept centrally (part 2, 3.22). He has a personal Cloudflare account; everything fits the free plan.

- **Recorder** (`worker/`, see its README): Cron Trigger every 10 minutes reads `/songs/christmas.json` and stores new
  plays and breaks in D1 using `History.fromFeed` / `History.merge` from this file, so dates and gap flags follow the same rules.
  It never touches YouTube (Cloudflare may run it outside the US, gotcha 5).
- **Userscript:** `pullCloud()` asks `/plays?since=` on open, every 10 minutes while Live is on, and on coming back to the
  tab; `History.union` adds every play either side has. "After a gap" survives only where both missed the stretch.
  Requests are plain `fetch` with CORS (the Worker allows https://somafm.com), so no `@connect` was needed.
- **Part 2, sync (3.22):** each device sends the plays it recorded (`POST /plays`; `since` now means stored-or-changed, so
  old plays sent late reach the other devices) and merges one document (`/state`) holding marks, dislikes, favorites,
  categories, notes, the remembered playlist songs and the original order. Merge = the backup rules key by key (newer `at`
  wins, removals kept as `on: false` / `c: ''` / `t: ''`), plus `removed` times for marks and dislikes, which are deleted when
  cleared. Saves carry the version read; a 409 means merge with the newer one and try again (up to 4 times). The merge runs
  on the device's data as it is after the network wait, so a tap made meanwhile isn't lost. Device clocks decide "newer".
  With sync on, Replace / Undo of a backup can't remove what the document still has (the panel says so).
- **Key:** a Worker secret (`wrangler secret put KEY`); devices store the setup code `https://…workers.dev#key`. A refused key
  or an unreachable recorder isn't saved at setup, and later shows as a header warning (refuse and report).

## 8c. Christmas Lounge site (3.25)

SomaFM stops this channel in late Feb or early Mar, and the history page may go with it. Dan also wanted changes without
updating Tampermonkey on each device, and every key built into the site rather than pasted per device.

- **Same file, "site mode":** `site/public/site.js` stands in for Tampermonkey (`GM_getValue`/`GM_setValue` on IndexedDB, all read
  into memory first because the script reads them synchronously; each change is also sent to the site's other tabs over a
  `BroadcastChannel`, since Tampermonkey shares values live and the Google sign-in window hands its key back that way), fetches `/api/config`, sets `window.XMAS_SITE = { api, clientId,
  station }`, then runs `soma-xmas-checker.user.js` (copied in by `site/deploy.js`). With `SITE` set the script reads SomaFM's list
  from `/api/feed`, the playlist from `/api/playlist`, treats the site as its recorder with no key (no setup code, no Turn off),
  and uses the built-in Client ID for Shuffle (no setup step). Under Tampermonkey `SITE` is null and nothing changes.
- **`/api`** (`worker/src/site.js`, a Pages Function in `site/functions/api/[[path]].js`): checks the Cloudflare Access token
  (`worker/src/access.js`, RS256 against the team's certs, audience and issuer) on every request and refuses without it, so preview
  addresses get nothing. `/feed` reads SomaFM now and records those plays (`record`). `/playlist` uses the YouTube Data API
  (`worker/src/youtube.js`, `YT_KEY` secret): every page, lengths, and deleted, private or US-blocked videos counted as hidden. The API gives the uploader channel, which for auto-generated music videos can differ from the artist the playlist page shows ("Billy Paul - Topic" vs Billy Paul Williams, so two songs fell to amber on Nov 1); `creditedArtists` takes the artist from their description ("Title · Artist") instead.
  `/plays` and `/state` are the recorder's handlers on the same D1 database.
- **Sign-in:** Cloudflare Access with Google as the login method, allowing only Dan's account.
- **Secrets** (not in the repo): `YT_KEY`, `GOOGLE_CLIENT_ID`, `ACCESS_TEAM`, `ACCESS_AUD`.
- The recorder Worker keeps the 10-minute look and the key-protected endpoints the userscript uses. Pages can't run on a schedule.

## 8d. The new site, built from the Pocket v2 design (Nov 2026)

**Build (Nov 2, first pass, all of the below):** `site/app/` (index.html, app.css, app.js; no build step). The page loads the
userscript file as `/lib/soma-xmas-checker.user.js` with `window.module` set, so it hands over its modules instead of running
(`window.XM`). Nothing of Dan's data is stored in the browser: plays come from `/api/plays` (all of them, no 10,000 cap), the
document from `/api/state`, and each change goes to the new `POST /api/change { patch }` (`worker/src/site.js`), which merges
the partial document into the stored one with `Sync.merge` under the version check, so today's site keeps reading the same
document. The page shows a change at once (merged locally), sends one request at a time (later changes wait and merge), retries
with a warning, and asks before closing with an unsaved change. `/api/playlist?within=900` serves the server's last read when
it's under 15 minutes old (reads cost quota units Shuffle shares). Archive updates (gone songs) are sent as an `archive` patch
from complete reads only. Per device (localStorage `xl:*`): theme, Live, per page, last History filters, top sort, Shuffle's
sign-in key, unfinished job and device id. Addresses: `/`, `/history?status=&cat=&fav=1&latest=1&q=&page=`, `/stats`,
`/shuffle`, `/more` (Pages serves index.html for every path, as there's no 404.html). Plays tables switch to columns by a
container query (list ≥ 860 px), so the half-width lists on Now and Stats stay as rows. Restore offers Merge only (one copy:
Replace/Undo would need to remove from D1; Dan agreed Nov 2). Live updates also refresh Now (Dan's choice, Nov 2). Tests: `npm run test:next` (`next-check.js`, 85 checks against a stand-in /api; `SHOTS=<dir>`
saves screenshots), worker tests cover `/change` and the playlist cache. Deploy: `node site/deploy-next.js` (branch `next`).
Set up (done Nov 2): the preview environment's four secrets (Dan set them with `node site/copy-secrets.js <file>`: one file of
NAME=value lines; it checks all four look right before setting any, and never prints them; Cloudflare can't give secrets back, so
they can't be copied from production), and the OAuth client has next.xmaslounge.pages.dev as origin and `/` redirect URI.
`site/app/_headers` sends `Cache-Control: no-cache` so a deployment shows on the next load. Access lets Dan in without a prompt
there because his session covers `*.xmaslounge.pages.dev` (checked: a request without it is sent to the Access login).
(`design.xmaslounge.pages.dev` still serves the mockups; Dan once looked there by mistake.)

**Dan's tweaks after the first build (Nov 2 evening), all live on next:**
- Themes: dark only. Midnight (the default, whatever the device's setting; Frost removed: on his dark-mode devices it looked
  the same as Midnight), Candy cane (made dark), Evergreen (new, green). Old saved 'midnight'/'' both mean Midnight.
- History filters: the first row is All, In playlist, Not in playlist, ★ Favorites, Latest, All filters ▾. Below 900 px it
  uses short names so it fits on one line at 600 px (In list, Not in list, ★, Latest, All ▾; the same shorts today's site
  uses). "Latest play only" is in the panel's Status group (the Show group is gone).
- Rows: round Open icon (songs you have) and Search icon (songs you don't; "other version" gets both) on the row itself; a
  larger ☆/★ beside songs in the playlist that favorites without opening the row. Song name, artist and album wrap between
  words (not cut off). Artist/length 14 px, date 12.5 px, album 13.5 px. Phones (< 600 px): the status as its dot alone.
- Open row: one row of options (status tag, its choices, category, Add a note; no Open/Search/Favorite there now). A note shows
  with a ✎ edit icon to its left.
- Playlist line: "· checked N min ago" moves to the next line whole (`.nw` spans).
- Stats: Songs by status right under the three playlist cards; the heard bar etc. under "Heard so far".
- Now card: the status as the lists' colored dot and name, on a dark badge.
- Now shows 7 plays under "Just played" (fixed, from the mockup; Dan asked what decides it, may want it changed).

**Dan's tweaks of Nov 4 (after two days' use), live on next:**
- Text in three levels: `--muted` (secondary) made brighter in each theme; the old color is now `--faint` (third level:
  notes in the lists, the date under a time, footnotes such as `.snote`, `.legend`, `.foot`).
- More → Song lists (per device, `xl:listAlbum`, `xl:listNotes`): Album Always / Wide screens (default), Notes First line
  (default) / All / Off. The note shows under the song in `--faint`; with notes Off the ✎ beside the name stays. Dan asked
  to "always show the artist"; the artist already always shows, so this was taken to mean the album (hidden under 860 px).
  Confirm with him.
- Now card: Favorite is a ☆/★ beside the song's name (no Favorite pill); on phones the buttons stay on one line
  (Open/Search, Note, N plays); the whole note shows at the bottom of the card.
- Rows: a round chevron at the end (in `.m-side` on narrow, `.c-act` in the table) that fills and turns over while open; the
  open row also gets an accent bar on its left. The whole row is the tap target, as before.
- Filters: Latest is always the second chip (first row and All filters). The first row leaves out Not in playlist while
  it counts 0 (unless on). In All filters, chips counting 0 go to the end of their group, dashed and dim with the 0 in red
  (this also brings back "No category" at the end when every song has one).
- Stats: the three playlist cards stay on one row on phones; two new cards above Songs by status, for songs played and
  for plays: % in your playlist with the words beside it (under it on phones, one line, "in playlist") and the count
  ("36 of 60"), then the % disliked, large, right below. Other versions and plain not-in-playlist are left to Songs by status.
- Later the same day: the Now card opens and closes like a row (tap anywhere on it; "N plays" + the chevron at the end of
  its buttons; Open/Search keep data-stop), and the date under a row's time went back to the secondary (--muted) color.

**Switched (Nov 4, late):** `node site/deploy-next.js main`; checked in Chrome: the new site at xmaslounge.pages.dev, the old at /old/ (its own IndexedDB copy, the same document and /api; its Shuffle sign-in returns to / and so won't complete there). Stats cards' counts in --ink. Then: Now's repeat card centered top to bottom (.box.mid); the Stats cards lay out disliked like in playlist (%, "of songs disliked" / "of plays disliked" not bold, "N of M" below).

**Shuffle stays signed in (Nov 4, late):** Google's implicit sign-in key lasts an hour and can't be lengthened, so with `GOOGLE_CLIENT_SECRET` set (a fifth Pages secret, in `copy-secrets.js`; Dan added a new secret to the existing OAuth client) the page uses the code flow (`access_type=offline`, `prompt=consent`) and `worker/src/ytauth.js` exchanges the code, keeps the refresh token AES-GCM-encrypted (key from the client secret) in `docs` row `youtube:auth`, and hands out one-hour keys: `POST /api/youtube/connect|token|disconnect`. Sign out revokes at Google, for every device. `/api/config` says `keepsSignIn`; without the secret the page keeps the old hourly sign-in. Dan published the consent screen to In production (Testing ends refresh tokens after 7 days; personal use under 100 users needs no verification). Privacy policy for the consent screen: `site/app/privacy/index.html` (/privacy/, behind Access like the rest).

**Video picture, star, album line (Nov 5, live):** when the Now card's song is in the playlist, a small picture from its video (`i.ytimg.com/vi/<id>/mqdefault.jpg`) sits in the top right corner with the name wrapping around it (128 px; `.hthumb.ta`, floated), or on phones beside the artist line, above the play count (88 px; `.hthumb.tb`). Both are written and the CSS shows one. Dan picked this mix from mock-ups and taps through to YouTube; it removes itself if the picture fails to load. next-check.js stands in for i.ytimg.com. The ⭐ stays on the line with the name's last word (`.nw` span; h2 is no longer flex, so this holds on phones too). The album is on a line of its own under the artist (`.hwho` holds both); Dan tried the phone picture starting at the album line and preferred it beside the artist, centered on the artist and album lines when there is an album (`.hmain.two`).

**History search (Nov 5, live; the shortened hint too):** hint "Search: song, artist, or album". With the filters folded, `#find` is inside `.quick`: its own line on wider screens; on a phone `flex:1 1 220px`, so it joins the All ▾ line only when the whole hint fits Then (option 1, Dan's pick) `flex:1 1 64px` on a phone, so it always joins that line, and `fitHint()` (after each render and on resize) shortens the hint to "Search…" when the box is too narrow for it. On Dan's Pixel 8 Pro (412 px) All ▾ has a line to itself, so the whole hint shows.

**Themes (Nov 4, late, live):** Candy cane and Evergreen renamed **Xmas Red** and **Xmas Green** (saved keys still 'candy' / 'evergreen'), redone in a Material style: near-neutral surfaces with a faint hue, a pale accent with only a tint of the color, and the Now card as the one strong place (#b3192f red / #16764a green; red to green for Xmas Red, green to red for Xmas Green) with a short blend (44–56%) so the brownish in-between barely shows. Dan tried brighter (#c8102e / #0b7d42) and found it too bright. Later the same night: list rows put the time (not bold, --ink, 1 px padding, line as tall as the title's) level with the title, 24-hour hh:mm under 600 px, the NOW tag under the date, the icon beside the status with the count below; History's subtitle "SomaFM station play history"; Stats hides the first-time share at 0 and "Most played that you don't have" when empty, bolds only the replay figures ("Between replays" on phones), and Longest/Shortest titles wrap at " - " or before "(".

**Third round (Nov 4, evening), live on next:** Dan confirmed "artist" meant album. Songs by status lists only Other version,
Not in playlist and Gone (In playlist and Disliked are in the cards) and is left out when none of those has a song. Now: the
subtitle is just "SomaFM Christmas Lounge"; the cards read "3.6 h until a song repeats" and "700 plays recorded / 60 distinct
songs" (words beside each count; "plays" / "songs" under 600 px). A ↻ beside the title reads the latest now (same as More →
Read again now). Coming back to a tab (hidden 15 s or more, a back/forward-cache restore, or back online) now reads with force,
and once more 4 s later if that failed; a read stuck over 20 s (frozen in a sleeping tab) no longer holds the next one back,
and /api reads give up after 30 s (changes and playlist reads 2 min). Dan saw a returning tab a few minutes behind until he
reloaded; the likely cause was a request frozen mid-flight keeping `ticking` set. Check with him that it's gone.

**Phone fit (Nov 6, on next):** below 600 px the filter chips are tighter (padding 6 px, 12 px text, 4 px apart), so All, Latest, In list, Not in list and ★ share one line on Dan's Pixel even with four-digit counts, All ▾ and the search on the next; All filters shows Swing / Jazz / Funk; Stats says "avg song", "Latest replays" (for Most recently replayed) and puts Time recorded on two lines (total, then songs an hour). Dan asked why "until a song comes back" never moves: it is recorded time × different songs ÷ plays, i.e. one pass through the rotation at the average song length, so it only changes when SomaFM plays new songs; the measured average/median between replays is the figure that moves. Dan chose that: the Now tile ("until a song repeats") and the Stats tile ("until a song comes back") now show the measured average between replays (Stats.avgRepeatSecs); rateRepeatSecs stays in Stats.compute but the site no longer shows it. All of this round is live (Nov 6).

**How changes ship (Dan, Nov 6):** minor tweaks go straight to live (`node site/deploy-next.js main`); only major changes, or ones with decisions to make or a lot of back and forth, go to next first.

**Column names on the tablet (Nov 6, live):** lists 420–859 px wide (History, Just played and Stats' lists on the tablet; the half-width lists on wider screens, e.g. Dan's TV at about 1000 px) keep the phone row (Open/Search and the status dot, then the play count and chevron, at the right end), add a Category column with the short names (Swing, Jazz, Funk, None; — for songs not in the playlist), and show names over Time, Song and Category. Dan's rule: Status, Plays and Actions get their own columns only in the full table (860 px and wider), where the status fits in words. Lists under 420 px (phones) stay as rows without names. In this middle layout the Open/Search column is one button wide (an other version's two stack). Open and Search on every row sit on a subtle accent tint (Dan, Nov 6). The column-name row (PHEAD) is now on every list.

**Now card category (Nov 6, live):** on the tablet and wider the song's category (full name, or a dimmer "No category" for a playlist song without one; nothing for songs not in the playlist) sits above "N plays" at the right of the card's buttons (.hct/.hcat); phones leave it out.

**Status (before the build):** designed and approved. Dan: "this design is good enough to start building the full site". This is his
only personal tech project at the moment, so it gets full attention. Expect a few tweaks along the way.

**The design to build:** `site/design/pocket.html` (open `site/design/index.html`; a, b, c are the designs not chosen). Live
copy at https://design.xmaslounge.pages.dev/pocket.html (behind Access). The mockups need `site/design/data.js`, Dan's real
plays, which is **not in git** (personal notes and listening data): run `node site/design/mkdata.js` after saving two read-only
D1 queries as `state.json` and `plays.json` beside it, then delete those two files:
```
cd worker
npx wrangler d1 execute soma --remote --json --command "SELECT body FROM docs WHERE name='state'" > ../site/design/state.json
npx wrangler d1 execute soma --remote --json --command "SELECT at, artist, title, album, gap FROM plays WHERE channel='christmas' ORDER BY at DESC" > ../site/design/plays.json
```
Redeploy the mockups with `npx wrangler pages deploy ../site/design --project-name xmaslounge --branch design --commit-dirty=true` (from worker/).

**What Pocket v2 is (what Dan approved):**
- Five tabs in a bottom bar: **Now** (now-playing card with Open, Favorite, Note, plays; two number tiles; "Just played"),
  **History**, **Stats**, **Shuffle**, **More** (themes, sync, backup and restore, CSV export).
- **History:** playlist line with Refresh playlist and a Live updates switch; the "gone from playlist" notice when there are any;
  **filters: only four chips at first (All, In playlist, Not in playlist, ★ Favorites) plus any other filter that's on, and an
  "All filters ▾" button (shows "N on") opening a panel grouped as Status / Favorites and categories / Show (Latest play only),
  with Clear all and Done.** Dan asked for this instead of scrolling chip rows: minimal at first, everything one tap away.
  Then a search box (new), the plays, Newer/Older paging with 25/50/100/250 per page, and the recording line.
- **Plays: Time is its own column** (Dan asked). From 900 px wide it's a table: Time | Song (title, artist, album) | Status |
  Category | Plays | Actions (Open, ▾). On a phone: Time on the left, song in the middle, status and play count on the right.
  Gap rows ("Not recording here") stay between plays. Clicking a row opens: the video you have, the same per-status choices
  as today's cards (Open, Wrong video?, I have it, Not this one, Dislike, Undo, Link song, Unlink, Search YouTube),
  Favorite, the category picker, the note (view, add, edit), and every play of the song.
- **Stats:** Your playlist (songs, total length, average song, heard bar, not heard yet, favorites), categories (with "No
  category yet"), songs by status, SomaFM rotation (comes back in ~14.7 h, different songs), most played (sort: most
  plays / latest, rows open like History), recording (since, plays, gaps).
- **Shuffle:** plan a new order, earlier order, original order (and download it), sign-in, quota today across devices,
  last shuffle and what it used, link to Google's count.
- **Themes:** Frost (light, default), Midnight (dark, also the automatic dark), Candy cane. Remembered per device.

**Dan's tweaks to include from the start (Nov 2):**
1. **Total playlist time as h:mm, e.g. "9:32"** (9 hours 32 minutes), from the real lengths, instead of the mockup's "~9 h".
2. **Songs by status as a share of all plays too, not only of songs:** e.g. In playlist X% of songs and Y% of plays, Disliked
   likewise. (Today's Stats share tiles already show `playPct` and `songPct` from `Stats.compute`; the mockup showed songs only.)

**Plan agreed so far:**
- **Build at a test address while the current site keeps running**: a Pages branch (e.g. `next` →
  next.xmaslounge.pages.dev), already covered by the `*.xmaslounge.pages.dev` Access rule. Preview deployments use the
  *preview* environment: set its secrets too (`npx wrangler pages secret put YT_KEY --project-name xmaslounge --env preview`,
  same for GOOGLE_CLIENT_ID, ACCESS_TEAM, ACCESS_AUD; Dan enters them himself) and check the D1 binding applies to preview.
  Switch production over only when it does everything today's site does.
- **D1 as the one copy of the data**: no per-browser copies to merge (the source of the device-to-device bugs). The browser
  asks `/api` for what it shows and sends each change (mark, dislike, favorite, category, note, dismiss) as it happens.
  Keep the existing tables and `/state` document readable by today's site until the switch, so both can run side by side;
  don't change their format in a way the current site can't read.
- **Carry over the pure, tested modules** (Matcher, Stats, History, Shuffle, Archive, Sync's rules) rather than rewriting
  them; the outer page is new. No more prototype.js workarounds needed in new code (that was SomaFM's page), but the old
  file must keep them while it still runs.
- **Real pages with addresses** (#history, #stats … or paths), the back button works, filters can live in the address.
- **The Tampermonkey script is frozen** (Dan doesn't use it). Leave it working; the current site runs the same file.
- Tests: keep the regression gates; add page checks for the new site against a stand-in `/api`, like §9's site checks.

**Decided with Dan (Nov 2):** Now refreshes with Live updates; the new site has no play cap (it shows every play D1 keeps;
HISTORY_MAX stays only in the frozen userscript and today's site); restore is Merge only. Ask any new questions as plain text, not pick-lists.

## 9. Testing and regression gates

- `npm test`: about 375 checks across both runs (matching cases from every reported miss, marks, unavailable videos, history merge and gaps, linking, gone songs, reader with a fake YouTube, stats, backup/merge, shuffle plans and runs against a fake API, source check). **Every bug fix adds a test that fails before the fix.**
- `npm run test:page`: 130 real-page checks (the last 10 load the site's own files against a stand-in `/api`), including the Shuffle panel against a fake Google API (`page.route`), so Google is never contacted. It failed on the 3.10.0 build (Per page) and passes on 3.11.0.
- `worker/`: `npm test` there (recorder against real SQLite via `node:sqlite`; the site's `/api` with a made-up Access key and stand-ins for SomaFM and YouTube). The page check fakes the recorder with `page.route`.
- For a new UI feature, add a check to `page-check.js` in the same style.
- Dan's real exported CSV is a good fixture for stats work (he can export again; it isn't in the repo).

## 10. Open items / next steps

0. **New site (Pocket v2): live since Nov 4, at xmaslounge.zamulagh.fyi since Nov 5 (§8d).** Gates for each change: `npm run test:next` (add a check per tweak) and the worker's `npm test`; then `node site/deploy-next.js` (next, to try) and `node site/deploy-next.js main` (live). Both build the old site into /old (from `site/public`, paths moved under /old/); `node site/deploy.js` would put the old site back as the live one. Retire `site/public` + `site/deploy.js` only with Dan (they are what /old is built from).
1. ~~Shuffle: first real run~~ done (Dan shuffles from the site; quota and last shuffle are synced since 3.26.0).
2. ~~Laptop setup~~ no longer needed: the site records and syncs on every device.
4. **Open from Nov 5:** (a) switch the pages.dev redirect (site/functions/_middleware.js) from 302 to 301 once Dan is settled on the new domain; (b) the workers.dev player page (player/, Worker lounge-player) is only a fallback for the pages.dev addresses now: keep, or retire with Dan; (c) Cast shows the song from when casting started (updating it would mean reloading the stream); (d) the Android app's signing key stays with Dan, and a new key needs a new assetlinks.json; (e) ~~whether a tab he comes back to is up to date~~: Nov 6, Dan saw the site open about 10 minutes behind and catch up a minute later (on his TV). Cause: at start the page read the stored plays (only as new as the recorder's 10-minute look), then SomaFM's list (which records the newest plays on the server) but didn't read the plays again until the first live update. Fixed: the list is asked for alongside the first reads and the plays are read again right after it (next-check: "Opening the site"). Coming back to a tab already read the list before the plays. TV Bro (his TV browser) doesn't install PWAs, but hides its address bar, so the site looks like an app there anyway.
3. **Analyses once a few days are recorded** (from an exported CSV): (a) shuffled fixed list vs independent random picks, from the spread of replay intervals; (b) songs played more often than chance would explain.

## 11. Working with Dan

- Concise replies; he signals when he's done. He values understanding **why** a design decision was made.
- **Conservative:** refuse and report rather than guess and apply. Ask before anything hard to undo.
- **Regression gates with every shipped feature** (§9).
- **Ask questions as plain typed text.** Pick-list / selector answers from tool UIs don't reach him; he always types answers.
- He tests on the tablet right away and reports precisely (screenshots, exact titles). Take reports literally, and verify against his data when it's available.
- He shapes the look by trying it: expect mock-ups first for anything visual (side-by-side screenshots made with Playwright from the site's own files against a stand-in /api), then small rounds on next. Production deploys need his explicit go-ahead in that same message ("move it to live"), each time.
- Never hide or spoof the Referer (or similar) to get past a provider's block; he agreed. SomaFM blocks a list of free hosts, so the site plays from his own domain.
- He corrected an earlier example I used: "Faithful Ye Come" (Tetsumi Nagaka) is a **different song** from "O Come All Ye Faithful". Don't assume songs are the same from similar titles.

## 12. Version history (short)

| Version | Change |
|---|---|
| 1.0 | Labels on SomaFM's table. 1.0.1 network fix (desktop UA, `@connect`). 1.0.2 prototype.js workaround. 1.1 bright buttons, "Mark as in playlist". |
| 2.0 | Full redesign: own UI in a shadow root, live feed, filter chips. 2.1 Open beside title. 2.2 shading, "Not this one". 2.3 multi-select chips. |
| 2.4.x | Unavailable videos excluded; signed-out reads; 63-char cutoff; near-miss words (artist-gated in 2.4.5); ensemble words; plurals. |
| 2.5–2.9 | Play history with dates, paging, gaps, CSV. Dislike. Progress bar. Linking marks to a playlist video, with confirmation and two-level undo. |
| 3.0 | Playlist memory and "gone from playlist"; mixes from the artist field added to YouTube searches. |
| 3.1 | Playlists past 100 songs via the watch-page side panel; incomplete reads never mark songs gone. |
| 3.2–3.5 | Playlist length; Keep screen on; Stats panel; measured header layout with short labels. |
| 3.6–3.8 | Replay statistics, per-song play logs, recorded-time replay estimate. |
| 3.9 | Only the changed song is re-matched (2.3 s → 0.2 s on a slowed CPU); "Working…" indicator; no redraws under dialogs; Open buttons in Stats. |
| 3.10 | "▸ N plays" history on cards; "Most recent" sort in Stats. |
| 3.11 | Backup / Restore (merge, replace, undo); Per page fix; source check for delayed actions; `page-check.js`. 3.11.1 moved into the Scripts repo; Tampermonkey auto-update from GitHub. 3.11.2 play logs show the elapsed time with * for a gap (legend below), wider Stats panel on desktop. |
| 3.12 | Shuffle the real playlist through the YouTube Data API (Google sign-in, fewest moves, resume, read-back check, put back). 3.12.1 keeps the original order (in backups, downloadable). 3.12.2 saves it as soon as Shuffle opens; original order also committed as a CSV. 3.12.3 distrusts playlist reads with new repeats (false "gone" songs right after a shuffle). 3.12.4: an automatic match can be corrected ("Wrong video?" links another video). 3.12.5: "Not in playlist" moved into that picker. 3.12.6: plays dated in the future are ignored and cleared (gotcha 13). 3.12.7: misdated feed plays are moved by whole days to the right date instead of dropped. |
| 3.13 | Song lengths on cards and in Stats lists: the playlist video's length for "In playlist" songs, otherwise measured (~) from SomaFM's start times to the next song or break (`History.measuredLengths`: median of a song's plays, skipping plays before a gap and spans under 20 s or over 20 min). |
| 3.15.1 | Fixed freezes of a few seconds about once a minute: the saved matches were thrown away on every playlist check even when nothing changed. No background redraw while a drop-down is open. "Latest play only" renamed "Latest only" to fit the filter row on a tablet. |
| 3.15.2 | "Latest only" renamed "Latest", since the higher counts in the filter chips pushed it to the next line. |
| 3.16.0 | Shuffle panel: a folded "ⓘ Quota" line in every view with units left today, time until the midnight-Pacific reset, what the last shuffle used, and a link to Google's own count in the Cloud Console. YouTube gives apps no way to read the quota left, so the count is the script's own, per device. |
| 3.17.0 | Category chips in a second row below the status chips, plus "No category". They narrow the list to playlist songs in the chosen categories and combine with the status chips and Latest. Counts follow a drop-down change in place, without a redraw. |
| 3.17.1 | Shorter category chip labels: Swing, Jazz and None (the drop-downs keep the full names). |
| 3.17.2 | The Soul/Funk chip reads "Funk" below 900px (tablets and phones). |
| 3.17.3 | The "None" chip is hidden when every playlist song has a category, unless it is on (so it can still be turned off). It hides in place when the last song gets a category. |
| 3.18.0 | 📝 Notes on any song: a button beside the title opens an editor at the bottom of the card; the note shows at the bottom of each of the song's cards. In backups. Shuffle puts a favorite among the first three songs. Stats leaves out the "another version" share when no song has another version. |
| 3.18.1 | The note button is a colored ✏️ until a song has a note (then 📝), instead of a faded 📝 that looked disabled. |
| 3.18.2 | The category drop-down is a button with a menu in the page's colors (`openCatMenu`), not a system `<select>`, which can't be themed and opens as a plain full-screen list on the tablet. The menu is position: fixed, inside the open dialog when there is one; tapping elsewhere, scrolling or Escape closes it, and background redraws wait while it is open. |
| 3.18.3 | The note box is scrolled into sight when the on-screen keyboard opens (`keepInView`: fits the box to `visualViewport` on focus and as the keyboard resizes it), since the keyboard sometimes covered it. |
| 3.18.4 | Per page uses the same themed menu as categories (`openMenu`, shared). Its 200 option is now 250, enough for every different song on one page with Latest on; a saved 200 becomes 250. |
| 3.18.5 | Per page button text matches the pager buttons beside it (it had inherited the smaller "Per page" label size). |
| 3.19.0 | Shuffle tries a failed YouTube request again (dropped connection, 5xx, 409, 429, rate limits) after 2, 5, 15 and 30 s instead of stopping; the read-back looks twice more before reporting a different order. Dan had "Couldn't talk to YouTube" near the end of a shuffle (twice). |
| 3.19.1 | YouTube API requests use `cache: 'no-store'`. After Dan finished a shuffle that had stopped partway, the read-back said the order differed, but opening Shuffle again found it exactly as planned; it happened only when finishing, so most likely a stored or "not modified" answer from the read just before. |
| 3.20.0 | ⭐ filter chip: only favorites (Dan asked for it), first on the category row, combines with category chips, remembered per device (`favOnly`). A menu that fits neither below nor above its button scrolls the page so it fits below (the category menu was cut off on a short screen). |
| 3.20.1 | Each filter chip row fits on one line at 600 px: tighter chips below desktop width, "Not in list" / "In list" there, and `fitChips()` shrinks a row's text up to 15% rather than wrapping as counts grow. |
| 3.21.0 | Cloud recorder, part 1: a Cloudflare Worker (`worker/`) records plays every 10 minutes; the userscript fills in missed stretches from it (`History.union`, `Cloud`), set up in Backup / Restore. Also fixed: the Undo section showed before any import (`.ssec` grid beat `hidden`). |
| 3.22.0 | Cloud recorder, part 2: devices send their plays and sync marks, dislikes, favorites, categories, notes, remembered songs and original order through the recorder (`Sync`, `/state` with version check, `removed` for cleared marks and dislikes). Every 2 minutes and 3 s after a change. Live database migrated (`migrate-3.22.sql`). Spacing fixed in the Cloud recorder section. |
| 3.23.0 | Daylight saving fix: a feed dated an hour off is moved back (`History.feedShift`, device and recorder), and what the Nov 1 glitch saved is repaired (`History.repair`). Replays across a gap count in the averages when in line with the song's others; one measured average instead of two. Play logs read down each column. |
| 3.23.1 | The "not in your playlist" share tile is hidden while no song played is missing (Dan asked; it had been stuck at 0%), like "another version". |
| 3.24.0 | In its place, a card with how long until a song comes back: the rotation headline in decimal hours (14.7 h) so it fits on one line at 600 px. Dan finds it one of the most interesting numbers. Page check serves an empty feed (`noFeed`) so only the seeded plays count. |
| 3.24.1 | "Another version" and "not in your playlist" cards show only with at least 2 songs or 1% of plays (Dan: one song is better seen through its filter chip). Page check `feed` option serves a made-up live list. |
| 3.25.0 | Christmas Lounge site (§8c): the same file runs as a web page on Cloudflare in site mode, behind Cloudflare Access, with the YouTube key and Client ID built in. Playlist read with YouTube's API there. |
| 3.25.1 | Keep screen on (Awake) removed: the recorder records around the clock, so no device has to stay awake (Dan asked). |
| 3.25.2 | A "not" mark made before the exactly matching video joined the playlist no longer hides it (`applyMark` `firstSeen`, from the remembered songs). A safeguard found while chasing two Billy Paul Williams songs on the site (they turned out to be the next item). |
| 3.25.3 | 3.25.2 undone: it overrode a deliberate "not" mark and dislike. Lou Rawls's "[Away Team Reamix]" came back green on the plain version Dan added later, counting 152 songs in a 151-song playlist. A mark always stands again. "Reamix" (SomaFM's spelling) now counts as a remix, so that song is amber on its own. |
| 3.26.0 | Shuffle's quota count, last shuffle and earlier order are synced (`Sync` `shuffle` part), so every device shows the same (Dan saw a different count on each). YouTube can't report the quota left, so it is still the script's own count, now of all devices. Each browser has a `device:id`; opening Shuffle syncs at once and the Quota section redraws. |
| 3.15 | Categories (drop-down on "In playlist" cards; counts and a "No category yet" list in Stats; in backups); Shuffle limits runs of one category. "Latest play only" toggle. Much faster clicks: content-visibility on cards, stars and categories update in place (gotcha 14). |
| 3.14 | ⭐ Favorites (cards, Stats, "Not heard yet"; in backups). Shuffle spreads favorites and versions of a song evenly and keeps an artist's, album's or channel's songs apart (§8a). |
| 3.13.1 | Short or failed playlist reads are retried before showing anything; a still-short read keeps the fuller previous one. |

**Listen and installable app (Nov 5, live):** Dan wanted his phone's stream player and the site in one. A **Listen** button at the end of the bar of pages plays SomaFM's stream with a plain `Audio` element kept outside the page (so it plays on across pages): the 128k AAC from ice6/ice2/ice5 (the hosts in SomaFM's .pls lists), the 256k MP3 when the browser can't play AAC, the next server on an error, started again on `ended`. Stop lets the stream go (src removed), so Listen plays what's on now. The Media Session gets the song (and its video's picture when it's in the playlist, else SomaFM's logo) for the notification and lock screen; while listening, the minute reads go on with the page out of sight so that stays current. `manifest.webmanifest` + `icons/` (made by a Playwright script from an SVG snowflake on the Xmas red/green split) make it installable from Chrome; the manifest link has `crossorigin="use-credentials"` because Cloudflare Access guards every address. If installing fails on the phone, the likely fix is an Access bypass for /manifest.webmanifest and /icons/*. Next ideas Dan raised: a link to play the Xmas Mixed playlist on YouTube when the station isn't broadcasting; a TV view (his Chromecast's browser already passes the Access login).

**Listen where SomaFM refuses (Nov 5, live):** SomaFM's stream servers answer 403 when the Referer is a pages.dev (or github.io) page — a deliberate block. Every ordinary browser sends it and is refused (Windows Chrome, Android Chrome, TV Bro). Dan's phone and tablet played only because AdGuard's tracking protection strips the Referer (he found this Nov 5, when a second user's Android phone was refused). We do not hide or spoof the Referer. Instead, when every server fails, Listen remembers it for the device (`xl:listenVia` = "somafm"), the Now page's box offers **Open SomaFM's player**, and from then on the button reads **Listen ↗** and opens `somafm.com/player24/station/christmas (their newer player, Dan's pick; with Chrome's Sound set to Allow for somafm.com it starts by itself)` (SomaFM's pages refuse iframes; a tab named somafm-player on every device, Dan's choice; its player already tries to start on load, but browsers hold back sound in a tab opened this way). More → Listen → Here / In SomaFM's player switches it back. A custom domain would likely let the stream play everywhere, or SomaFM could be asked.

**Listen through a player page on workers.dev (Nov 5, live):** SomaFM's 403 list covers the common free hosts (pages.dev, netlify.app, github.io, web.app, onrender.com, sites.google.com) but not ordinary domains, workers.dev or vercel.app (tested with real Chrome, only the Referer changed). Dan chose to use workers.dev for now (it may join the list one day; then the fallback to SomaFM's player takes over again, and a custom domain or asking SomaFM are the lasting fixes). `player/` is a separate Worker, **lounge-player** (`https://lounge-player.soma-recorder.workers.dev/`, deploy with `node ../worker/node_modules/wrangler/bin/wrangler.js deploy` from player/): one page, `player.html`, that plays the stream and takes orders by postMessage (hello, play, stop, meta) only from *.xmaslounge.pages.dev (and lounge.test for the checks); its CSP lets only the site frame it and only reach *.somafm.com. The site loads it at start in an invisible 1 px frame with `allow="autoplay"` (a tap in the site lets the frame play), sends play/stop and the song for the Media Session, and shows its states. If the frame never says it's ready, the site plays the stream itself as before. The saved fallback choice moved to `xl:listenVia2`, so devices that had fallen back to SomaFM's player try again. Real Chrome on Windows played through it (200 from ice6, Referer the workers.dev page).

**Own domain (Nov 5):** Visits to xmaslounge.pages.dev and next.xmaslounge.pages.dev now move to the same page on the own domain (live Nov 5; `site/functions/_middleware.js`, a temporary 302; not /api, not POST etc., not a deployment's own address; checked in next-check.js). Switch it to 301 once settled. Dan bought **zamulagh.fyi** (Cloudflare Registrar, 5 years; SPF `-all`, DMARC reject and a null MX since it sends no mail; verified in Google Search Console). The live site is also at **https://xmaslounge.zamulagh.fyi** (Pages custom domain) and next at **https://next.xmaslounge.zamulagh.fyi** (a custom domain whose CNAME points at next.xmaslounge.pages.dev; Pages issues each its own certificate, so the DNS page's "not covered by a certificate" warning for the two-level name doesn't matter). Access: the same application has `xmaslounge.zamulagh.fyi` and `*.xmaslounge.zamulagh.fyi` beside the pages.dev names (same AUD, no secret change), plus a separate **Bypass / Everyone** application for `xmaslounge.zamulagh.fyi/privacy` so Google's branding check can read the policy (branding is published; the app itself stays unverified, so the "unsafe" screen stays). Google OAuth client: both new origins and `/` redirect URIs, authorized domain zamulagh.fyi, home page and privacy links on the new domain. SomaFM plays to ordinary domains, so on the own domain Listen plays the stream itself (`OWN_DOMAIN` in app.js: no player frame); the pages.dev addresses keep using the workers.dev player page. The pages.dev addresses all keep working.

**Listen on the Now card, volume, YouTube mark (Nov 5, live):** **Listen** is first in the Now Playing card's row of buttons (`#hlbtn`; "Listen live" on wider screens, Stop while playing), then **YouTube** (YT on a phone; YouTube's red mark with a white ▶ on a plain pill, Listen has the solid highlight; in the song rows the same small red mark on the plain round button like 🔍; Dan found a full red circle too loud), Note, and the plays (as "14×" on a phone, to fit). While playing, a row under the buttons (`#hlisten`, `data-stop` so taps there don't open the card) has a volume slider (`#vol`, the player's own volume, quieter than the device never louder, kept as `xl:volume`; renders are held while dragging). The volume reaches the workers.dev player page with a `volume` message (player redeployed). Opening on YouTube now uses a YouTube-style mark (`ico('yt')`, a rounded screen with ▶) in the rows and a **YouTube** pill on the card, so it no longer looks like Listen's plain ▶.

**Cast (Nov 5, live; Dan tested it on his Chromecast):** Google's Cast sender library (`cast_sender.js?loadCastFramework=1`, loaded at start, Chrome only) finds Chromecasts; a round cast button (`#castbtn`) shows at the right of the Now card's top line only when one is around. Tapping it opens Chrome's device picker; once connected the Default Media Receiver plays `ice6 …-256-mp3` itself as a LIVE `audio/mpeg` stream with the song, artist and picture at that moment (the Chromecast sends no page address, so SomaFM's pages.dev block doesn't apply), and Listen here stops. Tapping again ends the cast. The song shown on the TV isn't updated at later songs (that would mean reloading the stream). next-check.js stands in for the library.

**Public install page (Nov 5, live; Access bypasses in place):** PWABuilder package `fyi.zamulagh.xmaslounge`; its `site/app/.well-known/assetlinks.json` (public through an Access bypass for `/.well-known`) lets the Android app open without an address bar. The signing key stays with Dan, never in the repo; a new key means a new fingerprint here. PWABuilder reads a site's manifest from outside, and Access hid it ("missing the web app manifest"). `site/app/install/index.html` is a small public page that links `/manifest.webmanifest`; Access needs Bypass/Everyone entries (in the same application as `/privacy`) for `xmaslounge.zamulagh.fyi/install`, `/manifest.webmanifest` and `/icons`. Give PWABuilder `https://xmaslounge.zamulagh.fyi/install/`. Its Android package will also want `/.well-known/assetlinks.json` (served from site/app, bypassed the same way) so the app opens without an address bar.

**Material 3 look (Nov 5, live):** Second pass, after Dan's look (matching his EPGSA themes): cards and the bar toned down to the card color with a hint of accent (the bar on a line), icon buttons on the plain chip color, selected filter chips and the current page's pill in the full accent with dark text/icon (the page label in the accent), and Listen in the bar quiet until it plays. The bar's current-page pill "pops" when the page changes (`animateNav`, ported from Dan's EPGSA app: a ghost pill grows from the middle, the icon bounces, its color fades in; skipped on first load and with reduced motion). a layer at the end of app.css (after a mock-up Dan approved): tonal surfaces mixed from each theme's accent (`--sc`, `--sc-high`, `--sec`, `--outline`), 16 px cards and a 28 px Now card with a soft shadow, 40 px buttons and round icon buttons, outlined 8 px filter chips with ✓ when on, a pill behind the current page in the bar (narrower under 400 px so six items fit), a filled 48 px search bar. Midnight's accent is now Material's dark-mode blue `#a8c7fa` (text on it `#062e6f`). Phones keep 13 px text on the Now card's buttons so the row fits at 360 px.

**Touch and Material fixes (Nov 5, live):** no tap highlight (`-webkit-tap-highlight-color:transparent`; buttons not selectable, each with its own `:active` look; selected text tinted with the accent); the Now card's note sits right under the album in a lighter color (outside `.hmain`, so the phone picture stays centered on artist and album); a gap where the second column stacks on a phone (Shuffle's Quota today); `.seg` choices' selected option is filled with the accent, the quota meter a lighter track, and Shuffle's `.big-btn.alt` a Material tonal fill (accent tint, no outline). No outlines (Dan found them off): `.seg` tracks and plain small `.pill`s get the same tonal accent tint as `.big-btn.alt` (20% accent over the card); the Now card's and the colored buttons keep their own.
