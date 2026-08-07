// 生成 Windows 托盘图标（彩色版）：macOS 用 template image（黑色+透明，系统自动适配深浅色），
// Windows 无此机制——纯黑气泡在深色任务栏上看不见，故 Windows 用彩色气泡
// 用法：node tools/generate-tray-win.js
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

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

function encodePng(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// 设计：蓝圆底 + 白色气泡 + 彩色弹幕条（32px 有细节，16px 自动简化为蓝圆+白点）
function drawTray(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const c = size / 32; // 以 32 为基准坐标，16px 按比例缩小
  const circle = (x, y, cx, cy, r) => (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r;
  const rect = (x, y, x0, y0, w, h) => x >= x0 && x <= x0 + w && y >= y0 && y <= y0 + h;
  const BLUE = [74, 108, 247], WHITE = [245, 246, 250];
  const BAR1 = [255, 107, 107], BAR2 = [255, 217, 61], BAR3 = [77, 171, 247];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5) / c, py = (y + 0.5) / c;
      let col = null;
      if (circle(px, py, 16, 16, 15)) col = BLUE;           // 圆底
      if (circle(px, py, 11, 10, 5.5)) col = WHITE;         // 气泡
      if (rect(px, py, 13, 17, 16, 3.5)) col = BAR1;        // 红弹幕条
      if (rect(px, py, 13, 22.5, 12, 3.5)) col = BAR2;      // 黄弹幕条
      if (rect(px, py, 13, 28, 16, 3.5)) col = BAR3;        // 蓝弹幕条
      const i = (y * size + x) * 4;
      if (col) {
        rgba[i] = col[0]; rgba[i + 1] = col[1]; rgba[i + 2] = col[2]; rgba[i + 3] = 255;
      }
    }
  }
  return encodePng(size, rgba);
}

function main() {
  const outDir = path.join(__dirname, '..', 'assets');
  fs.writeFileSync(path.join(outDir, 'tray-win.png'), drawTray(16));
  fs.writeFileSync(path.join(outDir, 'tray-win@2x.png'), drawTray(32));
  console.log('tray-win written:', outDir, '(16 + 32)');
}

if (require.main === module) main();

module.exports = { drawTray };
