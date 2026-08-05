const TIMEOUT_MS = 30000;
const MAX_DANMAKU = 3;
const MAX_LEN = 24;

// 1×1 红色 PNG
const RED_SQUARE_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function friendlyError(status) {
  if (status === 401) return new ApiError('auth', '鉴权失败：API Key 无效（401）');
  if (status === 402) return new ApiError('balance', '余额不足或额度用尽（402）');
  if (status === 404) return new ApiError('model', '模型名不存在（404），检查模型名是否正确');
  if (status === 429) return new ApiError('rate', '请求过于频繁（429），请稍后再试');
  if (status >= 500) return new ApiError('server', `服务端错误（HTTP ${status}）`);
  return new ApiError('http', `HTTP 错误（${status}）`);
}

async function postChat({ baseUrl, apiKey, body }) {
  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') throw new ApiError('timeout', '请求超时（30 秒无响应）');
    throw new ApiError('network', `网络错误：${err.message}`);
  }
  if (!res.ok) throw friendlyError(res.status);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

async function chatCompletion({ baseUrl, apiKey, model, system, user }) {
  return postChat({ baseUrl, apiKey, body: {
    model, temperature: 1.1, max_tokens: 120,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  } });
}

async function visionCompletion({ baseUrl, apiKey, model, system, imageDataUrl }) {
  return postChat({ baseUrl, apiKey, body: {
    model, temperature: 1.1, max_tokens: 120,
    messages: [
      // 单条 user 消息（含图片），兼容不支持 system+图片的端点
      { role: 'user', content: [
        { type: 'text', text: `${system}\n请根据这张截图发 1~2 条弹幕吐槽，每条不超过 20 个字。只返回 JSON 数组。` },
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

async function testVisionConnection(cfg, redImageDataUrl = RED_SQUARE_DATA_URL) {
  try {
    const reply = await visionCompletion({
      baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model,
      system: '你是连接测试助手', imageDataUrl: redImageDataUrl,
    });
    if (/红|red|赤/i.test(reply)) return { ok: true, message: '视觉能力正常' };
    return { ok: false, message: `视觉测试未通过：模型回复「${(reply || '').trim().slice(0, 30)}」，未能识别红色` };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

module.exports = {
  ApiError, chatCompletion, visionCompletion, parseDanmakuJson,
  testTextConnection, testVisionConnection, RED_SQUARE_DATA_URL,
};
