const sharp = require('sharp');
const path = require('path');

const SVG_PATH = path.join(__dirname, 'src', 'icons', 'icon.svg');
const OUT_DIR = path.join(__dirname, 'src', 'icons');

async function main() {
  for (const size of [16, 48, 128]) {
    const outPath = path.join(OUT_DIR, `icon${size}.png`);
    await sharp(SVG_PATH)
      .resize(size, size)
      .png()
      .toFile(outPath);

    const { size: bytes } = await sharp(outPath).metadata().then(() =>
      require('fs').promises.stat(outPath)
    );
    console.log(`Generated icon${size}.png (${bytes} bytes)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
