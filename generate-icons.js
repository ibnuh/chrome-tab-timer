import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SVG_PATH = path.join(ROOT, 'src', 'icons', 'icon.svg');
const OUT_DIR = path.join(ROOT, 'src', 'icons');
const SIZES = [16, 48, 128];

async function main() {
  for (const size of SIZES) {
    const outPath = path.join(OUT_DIR, `icon${size}.png`);
    await sharp(SVG_PATH).resize(size, size).png().toFile(outPath);
    console.log(`Generated icon${size}.png (${fs.statSync(outPath).size} bytes)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
