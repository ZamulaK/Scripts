# SomaFM → Xmas Mixed checker

Tampermonkey userscript (`soma-xmas-checker.user.js`) that checks SomaFM Christmas Lounge plays against Dan's
YouTube playlist "Xmas Mixed", records play history, and shows stats. **Read `HANDOFF.md` before changing anything**:
it has the architecture, saved-data keys, matching rules and the reasons behind them, and open items.

## Rules

- **One file.** The script stays a single `.user.js` that Dan imports into Tampermonkey. Bump `@version` on every change.
- **No `Array.from`, `.map`, `.some`, `.every`, `.find`** anywhere in the script: SomaFM's prototype.js replaces them.
  Use `Matcher.anyOf / allOf / mapOf / keep` or loops. Test code in the sabotaged pass follows the same rule.
- **Never read `e.target` inside a `runBusy(...)` action**; read the element directly (the target is cleared after the delay).
- **Matching stays conservative.** A wrong green hides a song Dan wants. Fix reported misses with a targeted rule plus a test;
  near-miss rules require the same artist.
- **Never mark songs gone from an incomplete or suspicious playlist read.**
- **Regression gate with every change:** add tests, then run `npm test` (unit, both normal and sabotaged) and
  `npm run test:page` (real SomaFM page, several widths, light and dark). UI changes must work at **600 px portrait**
  (Dan's tablet) and 360 px, with every card's buttons on one line at 600 px.
- Anything reading the real YouTube playlist must run from a US connection (region-blocked songs are hidden elsewhere).

## Working with Dan

Concise; explain the *why*; refuse and report rather than guess; ask before anything hard to undo.
**Ask questions as plain typed text, never pick-list/selector UI** (those answers don't reach him).
