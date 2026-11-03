// Sets the site's four secrets for the test address (Pages' preview environment, next.xmaslounge.pages.dev) from files
// you already keep them in. Cloudflare never gives a secret back once it's set, so they can't be copied from the
// running site; this reads them from your files instead and hands each one to wrangler without showing it.
//
//   node site/copy-secrets.js YT_KEY=C:\path\youtube.txt GOOGLE_CLIENT_ID=C:\path\google.txt ACCESS_TEAM=... ACCESS_AUD=...
//   node site/copy-secrets.js --check ...      reads the files and says what it found, without setting anything
//   node site/copy-secrets.js --env production ...   for the live site instead (not needed for the test address)
//
// A file can hold just the value, or lines like NAME=value or NAME: value (several secrets in one file is fine;
// give the same file for each). A file that has neither is refused, and nothing is guessed.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const NAMES = ['YT_KEY', 'GOOGLE_CLIENT_ID', 'ACCESS_TEAM', 'ACCESS_AUD'];
// What each value looks like, so a wrong line or file is caught before it's set
const LOOKS = {
  YT_KEY: v => /^AIza[\w-]{30,}$/.test(v),
  GOOGLE_CLIENT_ID: v => /^[\w.-]+\.apps\.googleusercontent\.com$/.test(v),
  ACCESS_TEAM: v => /^[a-z0-9][a-z0-9.-]*$/i.test(v),
  ACCESS_AUD: v => /^[0-9a-f]{32,128}$/i.test(v),
};

const args = process.argv.slice(2);
const checkOnly = args.indexOf('--check') >= 0;
const envAt = args.indexOf('--env'), env = envAt >= 0 ? args[envAt + 1] : 'preview';
if (env !== 'preview' && env !== 'production') { console.error('--env is preview or production'); process.exit(1); }
const files = {};
for (const a of args) {
  const m = /^([A-Z_]+)=(.+)$/.exec(a);
  if (m && NAMES.indexOf(m[1]) >= 0) files[m[1]] = m[2].replace(/^"|"$/g, '');
  else if (m) { console.error(`${m[1]} isn't one of the site's secrets (${NAMES.join(', ')})`); process.exit(1); }
}
if (!Object.keys(files).length) { console.error('Give each secret\'s file, e.g. YT_KEY=C:\\path\\key.txt (see the top of this file).'); process.exit(1); }

function valueFrom(name, file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8').replace(/^\ufeff/, ''); } catch (e) { return { error: `can't read ${file} (${e.code || e.message})` }; }
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const l of lines) {
    const m = new RegExp('^(?:export\\s+)?' + name + '\\s*[=:]\\s*(.+)$').exec(l);
    if (m) return { value: m[1].replace(/^["']|["']$/g, '').trim() };
  }
  if (lines.length === 1 && !/[=:]\s/.test(lines[0])) return { value: lines[0] };
  return { error: `${file} has no line "${name}=…" and isn't just the value on its own` };
}

const wrangler = path.join(__dirname, '..', 'worker', 'node_modules', 'wrangler', 'bin', 'wrangler.js');
let bad = 0;
for (const name of NAMES) {
  if (!files[name]) { console.log(`${name}: skipped (no file given)`); continue; }
  const got = valueFrom(name, files[name]);
  if (got.error) { console.log(`${name}: not set — ${got.error}`); bad++; continue; }
  if (!LOOKS[name](got.value)) { console.log(`${name}: not set — the value found (${got.value.length} characters) doesn't look like one. Check the file.`); bad++; continue; }
  if (checkOnly) { console.log(`${name}: found (${got.value.length} characters), looks right`); continue; }
  // The value goes in on wrangler's input, so it's never on the command line or the screen
  const r = spawnSync(process.execPath, [wrangler, 'pages', 'secret', 'put', name, '--project-name', 'xmaslounge', '--env', env],
    { cwd: path.join(__dirname, '..', 'worker'), input: got.value + '\n', encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.status === 0) console.log(`${name}: set for ${env}`);
  else { console.log(`${name}: wrangler refused — ${out.split('\n').filter(l => /error|✘/i.test(l)).join(' ').slice(0, 300) || 'exit ' + r.status}`); bad++; }
}
if (!checkOnly && !bad) console.log(`\nDone. They reach the site on its next deployment: node site/deploy-next.js`);
process.exit(bad ? 1 : 0);
