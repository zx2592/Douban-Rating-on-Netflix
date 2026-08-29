#!/usr/bin/env node
/**
 * 生成扩展图标（豆瓣绿圆角方块 + 白色五角星）。
 *
 * 用脚本生成而不是提交二进制：图标是纯几何图形，代码比 PNG 更容易 review 和
 * 修改，也省得在仓库里塞四份二进制。只依赖 Node 内置的 zlib，不引图形库。
 */
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'icons');
const SIZES = [16, 32, 48, 128];

const GREEN = [46, 150, 61];
const WHITE = [255, 255, 255];
/** 每个像素在每个方向上采样这么多次，用来做抗锯齿。 */
const SUPERSAMPLE = 4;

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** 把 RGBA 像素数组编码成 PNG。 */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // 颜色类型：RGBA
  // 10–12 保持 0：deflate 压缩、标准滤波、非隔行

  // 每行前面要加一个滤波类型字节，这里统一用 0（不滤波）。
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 五角星的 10 个顶点，外顶点朝上。 */
function starPolygon(cx, cy, outerRadius) {
  const innerRadius = outerRadius * 0.382;
  const points = [];
  for (let i = 0; i < 10; i += 1) {
    const radius = i % 2 === 0 ? outerRadius : innerRadius;
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    points.push([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)]);
  }
  return points;
}

/** 射线法判断点是否在多边形内。 */
function insidePolygon(polygon, x, y) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function insideRoundedRect(x, y, size, radius) {
  const inset = size * 0.04;
  const min = inset;
  const max = size - inset;
  if (x < min || x > max || y < min || y > max) return false;
  // 只有四个角需要用圆心距离判断，其余部分直接算在内。
  const cx = Math.min(Math.max(x, min + radius), max - radius);
  const cy = Math.min(Math.max(y, min + radius), max - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  const star = starPolygon(size / 2, size * 0.52, size * 0.30);
  const step = 1 / SUPERSAMPLE;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let bgHits = 0;
      let starHits = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const px = x + (sx + 0.5) * step;
          const py = y + (sy + 0.5) * step;
          if (!insideRoundedRect(px, py, size, radius)) continue;
          bgHits += 1;
          if (insidePolygon(star, px, py)) starHits += 1;
        }
      }

      const samples = SUPERSAMPLE * SUPERSAMPLE;
      const offset = (y * size + x) * 4;
      if (bgHits === 0) continue;

      // 星形覆盖率作为白绿混合比例，边缘自然过渡。
      const starRatio = starHits / bgHits;
      for (let channel = 0; channel < 3; channel += 1) {
        rgba[offset + channel] = Math.round(
          GREEN[channel] * (1 - starRatio) + WHITE[channel] * starRatio,
        );
      }
      rgba[offset + 3] = Math.round((bgHits / samples) * 255);
    }
  }
  return encodePng(size, size, rgba);
}

await mkdir(outDir, { recursive: true });
for (const size of SIZES) {
  const file = resolve(outDir, `icon${size}.png`);
  await writeFile(file, renderIcon(size));
  console.log(`生成 ${file}`);
}
