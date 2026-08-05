// 实机测试辅助：CDP 检查工具
// 用法:
//   node test/cdp.js "<js表达式>"                     — 在所有页面执行并打印结果
//   node test/cdp.js "<js表达式>" --page <标题片段>    — 只在标题匹配的页面执行
//   node test/cdp.js --list                            — 列出所有页面
const http = require('node:http');

const PORT = process.env.CDP_PORT || 9222;

function listPages() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}/json`, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body).filter((t) => t.type === 'page')); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function evalOn(page, expr) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    const id = Math.floor(Math.random() * 1e9);
    const timer = setTimeout(() => { ws.close(); reject(new Error('CDP 超时')); }, 15000);
    ws.onopen = () => {
      ws.send(JSON.stringify({
        id, method: 'Runtime.evaluate',
        params: { expression: expr, returnByValue: true, awaitPromise: true },
      }));
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.close();
      if (msg.error) return reject(new Error(msg.error.message));
      const r = msg.result.result;
      if (r.subtype === 'error') return resolve({ __error: r.description || r.value });
      resolve(r.value);
    };
    ws.onerror = (e) => { clearTimeout(timer); reject(e); };
  });
}

(async () => {
  const args = process.argv.slice(2);
  if (args[0] === '--list') {
    const pages = await listPages();
    for (const p of pages) console.log(`[${p.title}] ${p.url}`);
    return;
  }
  const expr = args[0];
  const filter = args.indexOf('--page') !== -1 ? args[args.indexOf('--page') + 1] : null;
  const pages = await listPages();
  for (const p of pages) {
    if (filter && !p.title.includes(filter)) continue;
    try {
      const val = await evalOn(p, expr);
      console.log(`[${p.title}] ${JSON.stringify(val)}`);
    } catch (e) {
      console.log(`[${p.title}] CDP 错误: ${e.message}`);
    }
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
