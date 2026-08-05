const TIMEOUT_MS = 45000; // 视觉模型处理大截图较慢（火山 coding plan 实测可达 30s+），放宽到 45 秒
const MAX_DANMAKU = 5; // 一次调用最多解析条数（多角色弹幕，摊薄单条成本）
const MAX_LEN = 24;

// 64×64 红色方块（带白边），视觉测试连接用。1×1 像素图部分模型拒绝处理，稍大更容易识别
const RED_SQUARE_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAjElEQVR4nN3aIRKAUBDD0GyG+1958VgE5D9Z1Znazu5SJnESJ3ESdz2DGX5u96gFJE7iJE7iJE7iJE7iJE7iJE7iJE7iJE7iJE7iJE7iJE7iJE7iJE7iJE7iJE7iJE7iJE7iJE7iJE7iJE7iJE7iJE7iJE7iJE7iJE7iJE5Oey1u7IkscRIncX5d4K0byJgHf4MkHBUAAAAASUVORK5CYII=';

class ApiError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function friendlyError(status) {
  if (status === 401) return new ApiError('auth', '鉴权失败：API Key 无效（401）', status);
  if (status === 402) return new ApiError('balance', '余额不足或额度用尽（402）', status);
  if (status === 404) return new ApiError('model', '模型名不存在（404），检查模型名是否正确', status);
  if (status === 429) return new ApiError('rate', '请求过于频繁（429），请稍后再试', status);
  if (status >= 500) return new ApiError('server', `服务端错误（HTTP ${status}）`, status);
  return new ApiError('http', `HTTP 错误（${status}）`, status);
}

// 端点类型缓存：baseUrl -> 'chat' | 'responses'。
// 首次请求探测：chat/completions 404 → 自动回退 Responses API（如火山方舟 coding plan），成功后缓存
const endpointCache = new Map();

function resetEndpointCache() {
  endpointCache.clear();
}

async function doFetch(url, apiKey, body) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') throw new ApiError('timeout', '请求超时（30 秒无响应）', 408);
    throw new ApiError('network', `网络错误：${err.message}`);
  }
  if (!res.ok) throw friendlyError(res.status);
  let data;
  try {
    data = await res.json();
  } catch {
    // 200 但响应体不是 JSON（如代理返回 HTML 错误页）
    throw new ApiError('bad-response', '服务端返回了非 JSON 内容');
  }
  return data;
}

// OpenAI Chat Completions 响应提取
function parseChatReply(data) {
  return data.choices?.[0]?.message?.content ?? '';
}

// OpenAI Responses API 响应提取：output[] 中 type=message 的 content[].text 拼接
function parseResponsesReply(data) {
  const out = data.output || [];
  const text = out
    .filter((o) => o.type === 'message')
    .map((o) => (o.content || []).filter((c) => c.type === 'output_text').map((c) => c.text).join(''))
    .join('');
  return text || data.output_text || '';
}

// 把 chat messages 转成 Responses API 格式：system → instructions，图片 → input_image
function toResponsesBody(body) {
  const system = (body.messages.find((m) => m.role === 'system') || {}).content || '';
  const input = body.messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      if (Array.isArray(m.content)) {
        // 视觉消息
        const text = m.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
        const images = m.content
          .filter((p) => p.type === 'image_url')
          .map((p) => ({ type: 'input_image', image_url: p.image_url.url }));
        const parts = [];
        if (text) parts.push({ type: 'input_text', text });
        return { role: m.role, content: [...parts, ...images] };
      }
      return { role: m.role, content: m.content };
    });
  const out = {
    model: body.model,
    instructions: system,
    input,
    max_output_tokens: body.max_tokens,
  };
  if (body.temperature !== undefined) out.temperature = body.temperature;
  return out;
}

async function postChat({ baseUrl, apiKey, body }) {
  const base = baseUrl.replace(/\/+$/, '');
  if (endpointCache.get(base) === 'responses') {
    return parseResponsesReply(await doFetch(base + '/responses', apiKey, toResponsesBody(body)));
  }
  try {
    const data = await doFetch(base + '/chat/completions', apiKey, body);
    endpointCache.set(base, 'chat');
    return parseChatReply(data);
  } catch (err) {
    // chat/completions 路径不存在（404）→ 该端点只支持 Responses API：
    // 回退尝试 /responses；responses 也 404 才认为是模型名错误（保持原友好报错）
    if (err instanceof ApiError && err.status === 404) {
      try {
        const data = await doFetch(base + '/responses', apiKey, toResponsesBody(body));
        endpointCache.set(base, 'responses');
        return parseResponsesReply(data);
      } catch { /* 回退失败：抛原始 404（模型名不存在） */ }
    }
    throw err;
  }
}

async function chatCompletion({ baseUrl, apiKey, model, system, user }) {
  return postChat({ baseUrl, apiKey, body: {
    model, temperature: 1.1, max_tokens: 1024,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  } });
}

async function visionCompletion({ baseUrl, apiKey, model, system, imageDataUrl }) {
  return postChat({ baseUrl, apiKey, body: {
    model, temperature: 1.1, max_tokens: 1024,
    messages: [
      // 单条 user 消息（含图片），兼容不支持 system+图片的端点
      { role: 'user', content: [
        { type: 'text', text: `${system}\n请根据这张截图发 3~5 条弹幕吐槽：扮演多个不同性格的观众（如毒舌、捧场、脑补、温柔、玩梗），每人发一条，每条不超过 20 个字。只返回 JSON 数组。` },
        { type: 'image_url', image_url: { url: imageDataUrl } },
      ] },
    ],
  } });
}

function parseDanmakuJson(text) {
  if (!text) return [];
  let cleaned = text.trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) cleaned = fence[1].trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1) return [];
  try {
    const arr = JSON.parse(cleaned.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((s) => typeof s === 'string' && s.trim())
      .map((s) => s.trim().slice(0, MAX_LEN))
      .slice(0, MAX_DANMAKU);
  } catch {
    // JSON 解析失败：手工提取所有双引号字符串
    const items = [...cleaned.slice(start + 1, end).matchAll(/"([^"]*)"/g)]
      .map((m) => m[1].trim()).filter(Boolean).slice(0, MAX_DANMAKU);
    return items.map((s) => s.slice(0, MAX_LEN));
  }
}

async function testTextConnection(cfg) {
  try {
    const reply = await chatCompletion({
      baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model,
      system: '你是连接测试助手', user: '只回复一个字：通',
    });
    const first = (reply || '').trim().split(/\s+/)[0] || '(无回复)';
    return { ok: true, message: first };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

// 模型"连接成功但看不到图片"的回复特征（对视觉能力做提示而非判失败）
const VISION_BLIND_HINTS = [
  '无法识别', '无法查看', '无法分析', '看不清', '看不到', '看不见', '没有图片', '不能识别',
  '不包含图片', '不是图片', 'not an image', 'no image', 'cannot see', "can't see",
  'cannot identify', 'unable to identify', 'unable to see', 'do not see', 'dont see',
  'does not see', 'no visual', 'no vision',
];

async function testVisionConnection(cfg, redImageDataUrl = RED_SQUARE_DATA_URL) {
  try {
    // 测试连接用独立 prompt（问颜色），不走弹幕生成 prompt，回复聚焦便于判断
    const reply = await postChat({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, body: {
      model: cfg.model, temperature: 0.3, max_tokens: 60,
      messages: [
        { role: 'user', content: [
          { type: 'text', text: '这是一张测试图片。请简短回答：你看到了什么颜色？' },
          { type: 'image_url', image_url: { url: redImageDataUrl } },
        ] },
      ],
    } });
    const text = (reply || '').trim();
    if (!text) return { ok: true, message: '连接正常（模型未返回内容）' };
    if (VISION_BLIND_HINTS.some((h) => text.toLowerCase().includes(h))) {
      return { ok: true, message: `连接正常，但模型回复「${text.slice(0, 40)}」——可能不支持图片输入，屏幕弹幕可能无法工作` };
    }
    return { ok: true, message: `连接正常，模型回复：${text.slice(0, 60)}` };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

module.exports = {
  ApiError, chatCompletion, visionCompletion, parseDanmakuJson,
  testTextConnection, testVisionConnection, RED_SQUARE_DATA_URL,
  parseChatReply, parseResponsesReply, resetEndpointCache,
};
