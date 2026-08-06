// 生成应用图标（占位）：纯 Node 手写 PNG 编码，零依赖。
// 画面：深色圆角底 + 白色气泡（带小尾巴）+ 三条彩色弹幕条
// 用法：node tools/generate-icon.js [输出路径]（默认 assets/icon.png）
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

const SIZE = 512;

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // 色彩类型：RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // 每行前导 filter=0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- 图形绘制 ----------
// 圆角矩形包含测试（SDF 思路：夹到内矩形后测角距离）
function roundedRectContains(x, y, rx, ry, rw, rh, r) {
  if (x < rx || x > rx + rw || y < ry || y > ry + rh) return false;
  const cx = Math.min(Math.max(x, rx + r), rx + rw - r);
  const cy = Math.min(Math.max(y, ry + r), ry + rh - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

// 点在三角形内（符号法）
function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const sign = (x1, y1, x2, y2, x3, y3) => (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3);
  const d1 = sign(px, py, ax, ay, bx, by);
  const d2 = sign(px, py, bx, by, cx, cy);
  const d3 = sign(px, py, cx, cy, ax, ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function hexToRgb(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

const BG = hexToRgb('#1e1e2e');    // 深色底
const BUBBLE = hexToRgb('#f5f6fa'); // 白色气泡
const BAR1 = hexToRgb('#ff6b6b');  // 弹幕条（红）
const BAR2 = hexToRgb('#ffd93d');  // 弹幕条（黄）
const BAR3 = hexToRgb('#4dabf7');  // 弹幕条（蓝）

function drawIcon(size = SIZE) {
  const rgba = Buffer.alloc(size * size * 4);
  const s = size / SIZE;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5) / s;
      const py = (y + 0.5) / s;
      let color = null;
      if (roundedRectContains(px, py, 16, 16, 480, 480, 96)) {
        color = BG;
        if (roundedRectContains(px, py, 80, 120, 352, 248, 44)) color = BUBBLE;
        if (pointInTriangle(px, py, 100, 368, 180, 368, 76, 436)) color = BUBBLE;
        if (roundedRectContains(px, py, 110, 180, 260, 34, 17)) color = BAR1;
        if (roundedRectContains(px, py, 110, 236, 220, 34, 17)) color = BAR2;
        if (roundedRectContains(px, py, 110, 292, 280, 34, 17)) color = BAR3;
      }
      const i = (y * size + x) * 4;
      if (color) {
        rgba[i] = color[0];
        rgba[i + 1] = color[1];
        rgba[i + 2] = color[2];
        rgba[i + 3] = 255;
      }
    }
  }
  return encodePng(size, size, rgba);
}

function main() {
  const out = process.argv[2] || path.join(__dirname, '..', 'assets', 'icon.png');
  fs.writeFileSync(out, drawIcon(SIZE));
  console.log('icon written:', out, `(${SIZE}×${SIZE})`);
}

if (require.main === module) main();

module.exports = { drawIcon, SIZE };
