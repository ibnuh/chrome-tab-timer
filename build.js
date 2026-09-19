import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import esbuild from 'esbuild';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, 'dist');
const SRC = path.join(ROOT, 'src');
const watchMode = process.argv.includes('--watch');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function clean() {
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIST, 'icons'), { recursive: true });
}

/**
 * Copies the manifest, stamping in the version from package.json so the two
 * cannot drift apart.
 */
function buildManifest() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  manifest.version = pkg.version;
  fs.writeFileSync(path.join(DIST, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

function copyIcons() {
  const iconsDir = path.join(SRC, 'icons');
  if (!fs.existsSync(iconsDir)) {
    return;
  }
  // PNGs only: icon.svg is the source the PNGs are generated from, and the
  // manifest references nothing but the PNGs.
  for (const file of fs.readdirSync(iconsDir)) {
    if (!file.endsWith('.png')) {
      continue;
    }
    fs.copyFileSync(path.join(iconsDir, file), path.join(DIST, 'icons', file));
  }
}

function minifyHtml(html) {
  return html.replace(/\n\s*/g, '').replace(/>\s+</g, '><').replace(/\s{2,}/g, ' ');
}

/**
 * Inlines a stylesheet into its page and writes the minified result.
 *
 * Asserts that the expected link was found and that no stylesheet links remain:
 * a missed replacement would ship a page pointing at a file that is not in the
 * bundle, which fails silently at runtime.
 */
function buildHtmlWithInlineCSS(htmlFile, cssFile) {
  const htmlPath = path.join(SRC, htmlFile);
  let html = fs.readFileSync(htmlPath, 'utf8');
  const css = fs.readFileSync(path.join(SRC, cssFile), 'utf8');

  const linkRe = new RegExp(
    `<link\\s+rel="stylesheet"\\s+href="${cssFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*/?>`
  );
  if (!linkRe.test(html)) {
    throw new Error(`${htmlFile}: expected <link rel="stylesheet" href="${cssFile}"> to inline`);
  }
  html = html.replace(linkRe, () => `<style>${css}</style>`);

  const leftover = html.match(/<link\s+rel="stylesheet"[^>]*>/);
  if (leftover) {
    throw new Error(
      `${htmlFile}: still references an external stylesheet after inlining: ${leftover[0]}`
    );
  }

  fs.writeFileSync(path.join(DIST, htmlFile), minifyHtml(html));
}

function buildOffscreenHtml() {
  const html = fs.readFileSync(path.join(SRC, 'offscreen.html'), 'utf8');
  fs.writeFileSync(path.join(DIST, 'offscreen.html'), minifyHtml(html));
}

async function buildJs() {
  await esbuild.build({
    entryPoints: [
      path.join(SRC, 'background.js'),
      path.join(SRC, 'popup.js'),
      path.join(SRC, 'offscreen.js'),
      path.join(SRC, 'options.js'),
    ],
    outdir: DIST,
    bundle: true,
    minify: true,
    // Matches minimum_chrome_version in manifest.json (chrome.offscreen).
    target: ['chrome109'],
    format: 'iife',
  });
}

async function build() {
  console.log('Building...');
  const start = Date.now();

  clean();
  buildManifest();
  copyIcons();
  buildHtmlWithInlineCSS('popup.html', 'popup.css');
  buildHtmlWithInlineCSS('options.html', 'options.css');
  buildOffscreenHtml();
  await buildJs();

  console.log(`Built in ${Date.now() - start}ms -> dist/`);
}

async function main() {
  await build();

  if (!watchMode) {
    return;
  }

  console.log('Watching for changes...');
  fs.watch(SRC, { recursive: true }, (event, filename) => {
    if (!filename || filename.includes('node_modules')) {
      return;
    }
    console.log(`\nChanged: ${filename}`);
    build().catch(console.error);
  });

  fs.watch(ROOT, (event, filename) => {
    if (!filename || filename === 'dist' || filename.startsWith('.')) {
      return;
    }
    if (filename.endsWith('.json') || filename.endsWith('.js')) {
      console.log(`\nChanged: ${filename}`);
      build().catch(console.error);
    }
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
