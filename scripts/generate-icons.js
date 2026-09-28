// One artwork supplies both the desktop app and unpacked Chrome extension.
const fs = require('node:fs');
const path = require('node:path');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
(async () => {
  const assets = path.resolve(__dirname, '../src/assets');
  const extension = path.resolve(__dirname, '../extension/icons');
  fs.mkdirSync(extension, { recursive: true });
  const artwork = await loadImage(path.join(assets, 'app-icon.svg'));
  for (const size of [16, 32, 48, 128, 256]) {
    const canvas = createCanvas(size, size);
    canvas.getContext('2d').drawImage(artwork, 0, 0, size, size);
    const png = canvas.toBuffer('image/png');
    fs.writeFileSync(path.join(extension, `icon-${size}.png`), png);
    if (size === 256) {
      fs.writeFileSync(path.join(assets, 'app-icon.png'), png);
      const header = Buffer.alloc(22);
      header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
      header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12);
      header.writeUInt32LE(png.length, 14); header.writeUInt32LE(22, 18);
      fs.writeFileSync(path.join(assets, 'app-icon.ico'), Buffer.concat([header, png]));
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
