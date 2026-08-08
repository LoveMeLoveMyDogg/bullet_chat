// electron-builder 26 构建兼容补丁（npm postinstall 自动执行）：
// app-builder-lib 编译产物 require('@noble/hashes/blake2.js')（blake2b 函数），
// 但 @noble/hashes 1.4.0 的 exports 只有 ./blake2b（blake2.js 已在 1.4.0 拆分删除）。
// 给安装的两处副本（pkijs / app-builder-lib 各自依赖）加 ./blake2.js → ./blake2b.js 别名。
// 幂等：exports 已含该子路径时跳过。
const fs = require('node:fs');
const path = require('node:path');

const TARGETS = [
  'node_modules/pkijs/node_modules/@noble/hashes/package.json',
  'node_modules/app-builder-lib/node_modules/@noble/hashes/package.json',
];

let fixed = 0;
for (const rel of TARGETS) {
  const file = path.join(__dirname, '..', rel);
  if (!fs.existsSync(file)) continue; // 依赖树布局变化时跳过，不阻塞安装
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!p.exports || p.exports['./blake2.js']) continue; // 无需修补（或已修）
  p.exports['./blake2.js'] = './blake2b.js';
  fs.writeFileSync(file, JSON.stringify(p, null, 2) + '\n');
  fixed++;
  console.log('[patch-noble-hashes] 已添加 ./blake2.js 别名 →', rel);
}
if (!fixed) console.log('[patch-noble-hashes] 无需修补');
