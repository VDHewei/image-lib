import { createCanvas, loadImage } from '@napi-rs/canvas';
import fs from 'fs';
import path from 'path';

const svgPath = path.join('assets', 'logo.svg');
const sizes = [
  { name: 'logo.png', size: 512 },
  { name: 'logo-256.png', size: 256 },
  { name: 'logo-128.png', size: 128 },
];

const img = await loadImage(svgPath);
for (const { name, size } of sizes) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, size, size);
  const buf = await canvas.encode('png');
  fs.writeFileSync(path.join('assets', name), buf);
  console.log(`OK ${name} (${buf.length} bytes)`);
}