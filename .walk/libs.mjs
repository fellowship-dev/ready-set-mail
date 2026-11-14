// Fetch the shared libraries headless Chromium needs into ~/chromelibs (no root in the devbox): Debian bookworm arm64 .debs,
// with their dependencies, skipping what is already installed. usage: node libs.mjs pkg...
import { gunzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const MIRROR = 'https://deb.debian.org/debian';
const OUT = `${process.env.HOME}/chromelibs`;
mkdirSync(`${OUT}/debs`, { recursive: true });
const installed = new Set([...readFileSync('/var/lib/dpkg/status', 'utf8').matchAll(/^Package: (\S+)\n(?:[^\n]+\n)*?Status: install ok installed/gm)].map(m => m[1]));
const index = new Map();
for (const suite of ['bookworm', 'bookworm-updates']) {
  const res = await fetch(`${MIRROR}/dists/${suite}/main/binary-arm64/Packages.gz`);
  if (!res.ok) continue;
  const text = gunzipSync(Buffer.from(await res.arrayBuffer())).toString();
  for (const block of text.split('\n\n')) {
    const name = block.match(/^Package: (\S+)/m)?.[1];
    if (!name) continue;
    index.set(name, { file: block.match(/^Filename: (\S+)/m)?.[1], depends: (block.match(/^(?:Pre-)?Depends: (.+)$/gm) ?? []).join(', ').replace(/^(?:Pre-)?Depends: /gm, '') });
  }
}
const want = new Set();
const visit = (name) => {
  if (want.has(name) || installed.has(name) || !index.has(name)) return;
  want.add(name);
  for (const alt of index.get(name).depends.split(',').map(s => s.trim()).filter(Boolean)) {
    const first = alt.split('|')[0].trim().split(' ')[0].split(':')[0];
    visit(first);
  }
};
for (const p of process.argv.slice(2)) visit(p);
for (const name of want) {
  const { file } = index.get(name);
  const dest = `${OUT}/debs/${name}.deb`;
  if (!existsSync(dest)) writeFileSync(dest, Buffer.from(await (await fetch(`${MIRROR}/${file}`)).arrayBuffer()));
  execFileSync('dpkg-deb', ['-x', dest, OUT]);
}
console.log(`extracted ${want.size} packages`);
