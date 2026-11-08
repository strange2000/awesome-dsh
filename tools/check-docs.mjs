#!/usr/bin/env node
// Zero-dependency documentation checker for this repo.
//
// What it verifies (nothing else, and it never writes to the repository):
//   1. language switch   — README.md <-> README.en.md link to each other
//   2. structure         — heading levels, table rows, checklist items and code
//                          fences line up between the two languages
//   3. anchors           — every in-page (](#…) link resolves to a heading
//   4. svg               — assets/*.svg parse as balanced SVG with a viewBox
//   5. images            — every referenced asset exists; PNG dimensions are read
//                          from the IHDR header (social-preview.png must be 1280x640)
//   6. relative links    — links to repository files point at files that exist
//
// Usage: node tools/check-docs.mjs [repoRoot]
// Exit code: 0 = all checks passed, 1 = at least one failure, 2 = bad invocation.

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, resolve as presolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = presolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
const files = { zh: 'README.md', en: 'README.en.md' };

const failures = [];
const notes = [];
const fail = (group, msg) => failures.push(`[${group}] ${msg}`);
const note = (msg) => notes.push(msg);

// ---------- helpers ----------

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// GitHub heading -> id. Emoji (and other symbols) are dropped, whitespace becomes
// "-", and the variation selector U+FE0F is normalised away on both sides so that
// "🗺️"-style headings cannot produce phantom failures.
function slugify(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\uFE0E\uFE0F\u200B-\u200D]/g, '')
    .replace(/[^\p{L}\p{N}\p{M}_\s-]/gu, '')
    .replace(/\s/g, '-');
}

function headings(md, file) {
  const out = [];
  const lines = md.split('\n');
  let fence = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) fence = !fence;
    if (fence) return;
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) out.push({ level: m[1].length, text: m[2].trim(), id: slugify(m[2]), line: i + 1, file });
  });
  return out;
}

function countOutsideFences(md, re) {
  let n = 0;
  let fence = false;
  for (const line of md.split('\n')) {
    if (/^\s*```/.test(line)) { fence = !fence; continue; }
    if (!fence && re.test(line)) n += 1;
  }
  return n;
}

function codeFences(md) {
  return (md.match(/^\s*```/gm) ?? []).length;
}

function inPageLinks(md) {
  const out = [];
  const lines = md.split('\n');
  let fence = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) fence = !fence;
    if (fence) return;
    for (const m of line.matchAll(/\]\(#([^)\s]+)\)/g)) {
      out.push({ id: decodeURIComponent(m[1]).replace(/[\uFE0E\uFE0F\u200B-\u200D]/g, ''), line: i + 1 });
    }
  });
  return out;
}

function relativeFileLinks(md) {
  const out = [];
  const lines = md.split('\n');
  let fence = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) fence = !fence;
    if (fence) return;
    for (const m of line.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      out.push({ target: target.replace(/^\.\//, '').split('#')[0], line: i + 1 });
    }
  });
  return out;
}

function referencedAssets(md) {
  const out = new Set();
  for (const m of md.matchAll(/(?:src|href)="([^"]+\.(?:svg|png|jpe?g|gif))"/g)) out.add(m[1]);
  for (const m of md.matchAll(/!\[[^\]]*\]\(([^)\s]+\.(?:svg|png|jpe?g|gif))\)/g)) out.add(m[1]);
  return [...out];
}

function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// A deliberately small SVG sanity check: opening tag with a viewBox, balanced
// element tags, and no obviously broken attribute quoting.
function checkSvg(rel) {
  const text = read(rel);
  const body = text.replace(/^<\?xml[^>]*\?>\s*/, '').trim();
  if (!/^<svg[\s>]/.test(body)) fail('svg', `${rel}: does not start with an <svg> root element`);

  const open = body.match(/<svg[^>]*>/);
  if (!open) { fail('svg', `${rel}: unterminated <svg …> tag`); return; }
  if (!/\sviewBox\s*=/.test(open[0])) fail('svg', `${rel}: <svg> has no viewBox (it will not scale)`);

  const cleaned = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '');
  const stack = [];
  for (const m of cleaned.matchAll(/<\/?([A-Za-z][\w:-]*)([^>]*?)(\/?)>/g)) {
    const [full, name, attrs, selfClose] = m;
    if (full.startsWith('</')) {
      const top = stack.pop();
      if (top !== name) fail('svg', `${rel}: closing </${name}> does not match <${top ?? 'none'}>`);
    } else if (!selfClose) {
      stack.push(name);
    }
    if (name === 'svg' && full.startsWith('<svg')) {
      if (!/\swidth\s*=/.test(attrs) || !/\sheight\s*=/.test(attrs)) {
        note(`${rel}: <svg> has no explicit width/height (fine, viewBox only)`);
      }
    }
  }
  if (stack.length) fail('svg', `${rel}: ${stack.length} unclosed element(s): ${stack.slice(0, 3).join(', ')}`);
}

// ---------- 1. language switch ----------

for (const [lang, file] of Object.entries(files)) {
  if (!existsSync(join(ROOT, file))) { fail('switch', `${file} is missing`); continue; }
  const md = read(file);
  const other = lang === 'zh' ? files.en : files.zh;
  if (!md.includes(`](${other})`)) fail('switch', `${file}: no link to ${other}`);
}

// ---------- 2. structure ----------

const md = {};
for (const [lang, file] of Object.entries(files)) {
  if (!existsSync(join(ROOT, file))) continue;
  md[lang] = read(file);
}

if (md.zh && md.en) {
  const levels = (text) => headings(text, '').map((h) => h.level).join(',');
  const hz = headings(md.zh, files.zh);
  const he = headings(md.en, files.en);
  if (levels(md.zh) !== levels(md.en)) {
    fail('structure', `heading levels differ: zh=[${levels(md.zh)}] en=[${levels(md.en)}]`);
  }
  if (hz.length !== he.length) {
    fail('structure', `heading count differs: zh=${hz.length} en=${he.length}`);
  }

  const metrics = [
    ['table rows', (t) => countOutsideFences(t, /^\s*\|/)],
    ['checklist items', (t) => countOutsideFences(t, /^\s*- \[[ x]\]/)],
    ['code fences', (t) => codeFences(t)],
    ['bullets', (t) => countOutsideFences(t, /^\s*[-*] (?!\[[ x]\])/)],
  ];
  for (const [label, fn] of metrics) {
    const a = fn(md.zh);
    const b = fn(md.en);
    if (a !== b) fail('structure', `${label} differ: zh=${a} en=${b}`);
  }

  const lz = md.zh.split('\n').length;
  const le = md.en.split('\n').length;
  const drift = Math.abs(lz - le) / Math.max(lz, le);
  note(`line count: zh=${lz} en=${le} (drift ${(drift * 100).toFixed(1)}%)`);
  if (drift > 0.15) fail('structure', `line count drift ${(drift * 100).toFixed(1)}% > 15% — the two languages have drifted apart`);
}

// ---------- 3. anchors ----------

for (const [lang, text] of Object.entries(md)) {
  const idSet = new Set(headings(text, files[lang]).map((h) => h.id));
  for (const link of inPageLinks(text)) {
    if (!idSet.has(link.id)) {
      fail('anchor', `${files[lang]}:${link.line}: #${link.id} matches no heading id`);
    }
  }
}

// ---------- 4. svg + 5. images + 6. relative links ----------

const assetDir = join(ROOT, 'assets');
if (existsSync(assetDir)) {
  const svgs = readdirSync(assetDir).filter((f) => f.toLowerCase().endsWith('.svg'));
  if (!svgs.length) note('assets/: no SVG files found');
  for (const f of svgs) checkSvg(join('assets', f));
} else {
  fail('svg', 'assets/ directory is missing');
}

// the social preview is not referenced from the READMEs, but it is the repo's
// share card, so check it unconditionally when it is present
const previewPath = join(ROOT, 'assets', 'social-preview.png');
if (existsSync(previewPath)) {
  const size = pngSize(readFileSync(previewPath));
  if (!size) fail('image', 'assets/social-preview.png: not a valid PNG (bad signature)');
  else {
    note(`assets/social-preview.png: ${size.width}x${size.height}`);
    if (size.width !== 1280 || size.height !== 640) {
      fail('image', `assets/social-preview.png: social preview must be 1280x640, got ${size.width}x${size.height}`);
    }
  }
} else {
  note('assets/social-preview.png: absent (no share card in the repo)');
}

for (const [lang, text] of Object.entries(md)) {
  for (const rel of referencedAssets(text)) {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) { fail('image', `${files[lang]}: referenced ${rel} does not exist`); continue; }
    const st = statSync(abs);
    if (!st.isFile() || st.size === 0) fail('image', `${files[lang]}: ${rel} is empty or not a file`);
    if (rel.toLowerCase().endsWith('.png')) {
      const size = pngSize(readFileSync(abs));
      if (!size) fail('image', `${rel}: not a valid PNG (bad signature)`);
      else {
        note(`${rel}: ${size.width}x${size.height}`);
        if (rel.endsWith('social-preview.png') && (size.width !== 1280 || size.height !== 640)) {
          fail('image', `${rel}: social preview must be 1280x640, got ${size.width}x${size.height}`);
        }
      }
    }
  }
  for (const link of relativeFileLinks(text)) {
    if (!link.target) continue;
    if (!existsSync(join(ROOT, link.target))) {
      fail('link', `${files[lang]}:${link.line}: ${link.target} does not exist`);
    }
  }
}

// ---------- report ----------

const applied = note.length;
console.log(`docs check — root: ${ROOT}`);
console.log(`  files: ${Object.values(files).join(', ')}`);
for (const n of notes) console.log(`  · ${n}`);

if (failures.length === 0) {
  console.log(`\n✅ all checks passed (${applied} informational)`);
  process.exit(0);
}

console.log(`\n❌ ${failures.length} problem(s):`);
for (const f of failures) console.log(`  - ${f}`);
console.log('\nThis check never edits files: fix the source and push again.');
process.exit(1);
