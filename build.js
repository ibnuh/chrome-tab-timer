const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, 'dist');
const SRC = path.join(__dirname, 'src');
const watchMode = process.argv.includes('--watch');

function clean() {
  if (fs.existsSync(DIST)) {
    fs.rmSync(DIST, { recursive: true });
  }
  fs.mkdirSync(DIST, { recursive: true });
  fs.mkdirSync(path.join(DIST, 'icons'), { recursive: true });
}

function copyManifest() {
  fs.copyFileSync(
    path.join(__dirname, 'manifest.json'),
    path.join(DIST, 'manifest.json')
  );
}

function copyIcons() {
  const iconsDir = path.join(SRC, 'icons');
  if (!fs.existsSync(iconsDir)) return;
  for (const file of fs.readdirSync(iconsDir)) {
    fs.copyFileSync(
      path.join(iconsDir, file),
      path.join(DIST, 'icons', file)
    );
  }
}

function buildHtmlWithInlineCSS(htmlFile, cssFile) {
  let html = fs.readFileSync(path.join(SRC, htmlFile), 'utf8');
  const css = fs.readFileSync(path.join(SRC, cssFile), 'utf8');

  html = html.replace(
    /<link\s+rel="stylesheet"\s+href="[^"]+"\s*\/?>/,
    `<style>${css}</style>`
  );

  html = html
    .replace(/\n\s*/g, '')
    .replace(/>\s+</g, '><')
    .replace(/\s{2,}/g, ' ');

  fs.writeFileSync(path.join(DIST, htmlFile), html);
}

async function buildJs() {
  const commonOptions = {
    bundle: true,
    minify: true,
    target: ['chrome100'],
    format: 'iife',
  };

  await esbuild.build({
    ...commonOptions,
    entryPoints: [path.join(SRC, 'background.js')],
    outfile: path.join(DIST, 'background.js'),
  });

  await esbuild.build({
    ...commonOptions,
    entryPoints: [path.join(SRC, 'popup.js')],
    outfile: path.join(DIST, 'popup.js'),
  });

  await esbuild.build({
    ...commonOptions,
    entryPoints: [path.join(SRC, 'offscreen.js')],
    outfile: path.join(DIST, 'offscreen.js'),
  });

  await esbuild.build({
    ...commonOptions,
    entryPoints: [path.join(SRC, 'options.js')],
    outfile: path.join(DIST, 'options.js'),
  });
}

function buildOffscreenHtml() {
  let html = fs.readFileSync(path.join(SRC, 'offscreen.html'), 'utf8');
  html = html.replace(/\n\s*/g, '').replace(/>\s+</g, '><').replace(/\s{2,}/g, ' ');
  fs.writeFileSync(path.join(DIST, 'offscreen.html'), html);
}

async function build() {
  console.log('Building...');
  const start = Date.now();

  clean();
  copyManifest();
  copyIcons();
  buildHtmlWithInlineCSS('popup.html', 'popup.css');
  buildHtmlWithInlineCSS('options.html', 'options.css');
  buildOffscreenHtml();
  await buildJs();

  const elapsed = Date.now() - start;
  console.log(`Built in ${elapsed}ms → dist/`);
}

async function main() {
  await build();

  if (watchMode) {
    console.log('Watching for changes...');
    const dirs = [SRC, __dirname];
    const watchFiles = ['manifest.json'];

    for (const dir of dirs) {
      fs.watch(dir, { recursive: dir === SRC }, (event, filename) => {
        if (!filename) return;
        if (filename.includes('node_modules') || filename.includes('dist')) return;
        console.log(`\nChanged: ${filename}`);
        build().catch(console.error);
      });
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
