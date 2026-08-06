const { test } = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const { drawIcon, SIZE } = require('../tools/generate-icon');

function chunks(buf) {
  const out = [];
  let off = 8; // 跳过 PNG 签名
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    out.push({ type, data: buf.subarray(off + 8, off + 8 + len) });
    off += 12 + len;
  }
  return out;
}

test('生成的 PNG 结构合法：签名 + IHDR 尺寸 + IDAT 可解压', () => {
  const buf = drawIcon(SIZE);
  assert.deepStrictEqual(
    [...buf.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'PNG 签名'
  );
  const parts = chunks(buf);
  assert.deepStrictEqual(parts.map((p) => p.type), ['IHDR', 'IDAT', 'IEND']);
  const ihdr = parts[0].data;
  assert.strictEqual(ihdr.readUInt32BE(0), SIZE, '宽度');
  assert.strictEqual(ihdr.readUInt32BE(4), SIZE, '高度');
  assert.strictEqual(ihdr[8], 8, '位深');
  assert.strictEqual(ihdr[9], 6, '色彩类型 RGBA');
  const raw = zlib.inflateSync(parts[1].data);
  assert.strictEqual(raw.length, SIZE * (SIZE * 4 + 1), '每行 filter 字节 + RGBA 像素');
  // 非空白：采样气泡内、红/黄弹幕条间隙的像素 (256, 225)（#f5f6fa 的 R 通道 = 245）
  const idx = 225 * (SIZE * 4 + 1) + 1 + 256 * 4;
  assert.strictEqual(raw[idx], 245);
});
