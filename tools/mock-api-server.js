// BulletChat 实机测试用 mock OpenAI 兼容服务器
// 用法: node tools/mock-api-server.js [port]   (默认 3999)
// 环境变量控制故障模式:
//   MOCK_MODE=401|404|500|delay|html|flaky|text401|resp404
//            — 401 鉴权失败 / 404 模型不存在 / 500 服务端错误 / delay 35 秒无响应(超时)
//            / html 返回非 JSON / flaky 前 2 次失败后成功 / text401 只让文字请求失败（视觉正常）
//            / resp404 模拟 Responses-only 端点（如火山方舟 coding plan）：/chat/completions 404，/responses 正常
// 行为:
//   - 文字测试连接 (user 含 "只回复一个字") → "通"
//   - 视觉请求 (content 含 image_url / input_image)：
//       image 为空 → 400 (模拟真实端点拒绝空图——验证修复 1)
//       否则 → "红色" (测试连接) 或 "屏幕画面有变化" (弹幕生成)
//   - 弹幕生成 (system 含 "观众") → 返回 1~2 条弹幕 JSON
//   - 其他 → "通"
// /responses 路径按 OpenAI Responses API 格式解析与返回（instructions/input → output_text）
const http = require('node:http');
const ts = () => new Date().toISOString().slice(11, 19);

const PORT = Number(process.argv[2] || process.env.MOCK_PORT || 3999);
const MODE = process.env.MOCK_MODE || 'ok';
let flakyCount = 0;

function danmakuFor(userText) {
  if (userText.includes('新建了文件夹')) return ['666，新建了文件夹！', '这波起手式很经典'];
  if (userText.includes('删除了')) return ['删了？真的删了？我不信'];
  if (userText.includes('修改了')) return ['改来改去，大工程！'];
  if (userText.includes('移动')) return ['好家伙，这文件长了脚'];
  return ['666', '这波操作有点东西'];
}

// 从 chat messages 或 responses input 中提取最后一条消息的内容特征
function extractFromMessages(msgs) {
  const last = msgs[msgs.length - 1] || {};
  const text = typeof last.content === 'string' ? last.content
    : Array.isArray(last.content) ? last.content.map((p) => (p.type === 'text' || p.type === 'input_text' ? p.text : '[图片]')).join('\n')
    : '';
  const hasImage = Array.isArray(last.content) && last.content.some((p) => p.type === 'image_url' || p.type === 'input_image');
  const imageUrl = hasImage
    ? (last.content.find((p) => p.type === 'image_url')?.image_url?.url
       || last.content.find((p) => p.type === 'input_image')?.image_url || '')
    : '';
  return { text, hasImage, imageUrl };
}

function buildReply({ text, hasImage, imageUrl }) {
  if (hasImage) {
    if (!imageUrl) return { status: 400, reply: JSON.stringify({ error: { message: 'image_url must not be empty' } }) };
    const reply = text.includes('什么颜色') ? '红色' : JSON.stringify(['屏幕画面有变化，有点东西']);
    return { status: 200, reply };
  }
  if (text.includes('只回复一个字')) return { status: 200, reply: '通' };
  if (text.includes('新建了') || text.includes('删除了') || text.includes('修改了') || text.includes('移动')) {
    return { status: 200, reply: JSON.stringify(danmakuFor(text)) };
  }
  return { status: 200, reply: '通' };
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    console.log(`[${ts()}] [mock:${MODE}] ${req.method} ${req.url}`);

    if (MODE === 'delay') {
      setTimeout(() => res.end(), 35000);
      return;
    }
    if (MODE === 'html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>Gateway Error</body></html>');
      return;
    }
    if (MODE === 'flaky' && flakyCount < 2) {
      flakyCount++;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'flaky server error' } }));
      return;
    }
    if (MODE === '401') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
      return;
    }
    if (MODE === '500') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Internal server error' } }));
      return;
    }

    const isResponses = req.url.endsWith('/responses');
    const isChat = req.url.endsWith('/chat/completions');
    // resp404 模式：模拟 Responses-only 端点（coding plan），chat 路径不存在
    if (MODE === 'resp404' && !isResponses) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Not Found' } }));
      return;
    }
    if (MODE === '404') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Model not found' } }));
      return;
    }

    let data;
    try { data = JSON.parse(body || '{}'); } catch { data = {}; }

    // chat 与 responses 的输入结构不同：messages[] vs {instructions, input[]}
    const messages = isResponses ? data.input || [] : data.messages || [];
    const { text, hasImage, imageUrl } = extractFromMessages(messages);

    // 按通道故障：只让文字请求失败，视觉请求照常（测按通道隔离）
    if (MODE === 'text401' && !hasImage) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
      console.log(`[${ts()}] [mock:text401] -> 401 文字请求被拒`);
      return;
    }

    const { status, reply } = buildReply({ text, hasImage, imageUrl });
    if (status === 400) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(reply);
      console.log(`[${ts()}] [mock] -> 400 空图片被拒 body=${String(body).slice(0, 250)}`);
      return;
    }
    console.log(`[${ts()}] [mock] -> ${String(reply).slice(0, 50)}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (isResponses) {
      res.end(JSON.stringify({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: reply }] }] }));
    } else {
      res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
    }
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`mock api server on http://127.0.0.1:${PORT} mode=${MODE}`));
