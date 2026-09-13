let config = { ai: { baseUrl: '', apiKey: '', model: '', maxTokens: 8192, timeout: 120, extraParams: '' } };
let running = false;

async function callAI(messages, opts = {}) {
  const baseUrl = opts.baseUrl || config.ai.baseUrl;
  const apiKey = opts.apiKey || config.ai.apiKey;
  const model = opts.model || config.ai.model;
  if (!baseUrl || !apiKey || !model) throw new Error('AI 未配置');

  const maxTokens = Number(opts.maxTokens ?? config.ai.maxTokens ?? 8192) || 8192;
  const timeoutMs = (Number(opts.timeout ?? config.ai.timeout ?? 120) || 120) * 1000;

  let extra = {};
  const extraParams = (opts.extraParams ?? config.ai.extraParams ?? '').trim();
  if (extraParams) {
    try {
      const parsed = JSON.parse(extraParams);
      if (parsed && typeof parsed === 'object') extra = parsed;
    } catch {
      throw new Error('附加参数不是合法的 JSON，请检查格式');
    }
  }

  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const body = JSON.stringify({ model, messages, temperature: opts.temperature ?? 0.7, max_tokens: maxTokens, ...extra });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body,
      signal: controller.signal
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`API 错误 ${res.status}: ${err.slice(0, 300)}`);
    }
    const json = await res.json();
    const message = json.choices?.[0]?.message || {};
    const content = String(message.content || '').trim();
    if (!content) throw new Error('AI 响应为空（可能是推理模型使用了非标准格式）');
    return {
      text: content,
      reasoning: message.reasoning_content ? String(message.reasoning_content) : null,
      model: json.model || null,
      usage: json.usage || null,
      raw: json
    };
  } finally {
    clearTimeout(timer);
  }
}

async function listModels(opts = {}) {
  const baseUrl = opts.baseUrl || config.ai.baseUrl;
  const apiKey = opts.apiKey || config.ai.apiKey;
  if (!baseUrl || !apiKey) throw new Error('请先填写 Base URL 和 API Key');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(baseUrl.replace(/\/+$/, '') + '/models', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: controller.signal
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`无法获取模型列表（HTTP ${res.status}）：${err.slice(0, 200)}\n中转站若未开放 /models，可以忽略该错误，直接使用已知模型名。`);
    }
    const json = await res.json();
    const list = Array.isArray(json.data) ? json.data : [];
    return list.map((m) => ({ id: m.id, object: m.object, owned: m.owned_by }));
  } finally {
    clearTimeout(timer);
  }
}

function setConfig(cfg) { config = cfg; }
function getConfig() { return config; }
function isConfigured() { return !!(config.ai && config.ai.baseUrl && config.ai.apiKey && config.ai.model); }
function setRunning(v) { running = v; }
function isRunning() { return running; }

module.exports = { callAI, listModels, setConfig, getConfig, isConfigured, setRunning, isRunning };