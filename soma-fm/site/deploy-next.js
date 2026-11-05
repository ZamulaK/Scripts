// Deploys the new site (site/app, Pocket v2). `node site/deploy-next.js` sends it to the test address
// next.xmaslounge.pages.dev; `node site/deploy-next.js main` to the live site, xmaslounge.pages.dev (switched Nov 4, 2026).
// Since Nov 5 both are also on Dan's own domain: xmaslounge.zamulagh.fyi (Pages custom domain) and
// next.xmaslounge.zamulagh.fyi (a custom domain whose DNS record points at next.xmaslounge.pages.dev).
// Copies the checker's modules (the userscript file) next to the page, builds the old site into /old (below), then
// `wrangler pages deploy app --branch <branch>`, with the same /api (site/functions) as before.
//
// /old: the site before the switch (site/public), kept as a page to look things up in, at xmaslounge.pages.dev/old/
// (Dan, Nov 4). Its files ask for /site.js and /soma-xmas-checker.user.js from the top of the site, which is now the new
// site's, so the copies here ask for them under /old/ instead. It keeps its own saved copy in this browser (IndexedDB, as
// before), and still syncs with the same document. Back to the old site as the live one: `node site/deploy.js`.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const here = __dirname, branch = process.argv[2] || 'next';
const script = path.join(here, '..', 'soma-xmas-checker.user.js');
fs.mkdirSync(path.join(here, 'app', 'lib'), { recursive: true });
fs.copyFileSync(script, path.join(here, 'app', 'lib', 'soma-xmas-checker.user.js'));

const old = path.join(here, 'app', 'old');
fs.mkdirSync(old, { recursive: true });
const swap = (text, from, to, file) => {
  if (text.split(from).length !== 2) throw new Error(`site/public/${file} changed: "${from}" isn't there once, so /old can't be built`);
  return text.replace(from, to);
};
let html = fs.readFileSync(path.join(here, 'public', 'index.html'), 'utf8');
html = swap(html, '<script src="/site.js"></script>', '<script src="/old/site.js"></script>', 'index.html');
html = swap(html, '<title>Christmas Lounge</title>', '<title>Christmas Lounge (old site)</title>', 'index.html');
fs.writeFileSync(path.join(old, 'index.html'), html);
let js = fs.readFileSync(path.join(here, 'public', 'site.js'), 'utf8');
js = swap(js, "fetch('/soma-xmas-checker.user.js'", "fetch('/old/soma-xmas-checker.user.js'", 'site.js');
fs.writeFileSync(path.join(old, 'site.js'), js);
fs.copyFileSync(script, path.join(old, 'soma-xmas-checker.user.js'));

const wrangler = path.join(here, '..', 'worker', 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const r = spawnSync(process.execPath, [wrangler, 'pages', 'deploy', 'app', '--project-name', 'xmaslounge', '--branch', branch, '--commit-dirty=true'], { cwd: here, stdio: 'inherit' });
if (r.status === 0) console.log(`
On your own domain: https://${branch === 'main' ? '' : branch + '.'}xmaslounge.zamulagh.fyi`);
process.exit(r.status === null ? 1 : r.status);
