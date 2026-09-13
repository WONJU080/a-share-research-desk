const $ = (sel) => document.querySelector(sel);

const commandInput = $('#command');
const runButton = $('#run-button');
const pipeline = $('#pipeline');
const workflowState = $('#workflow-state');
const contextEmpty = $('#context-empty');
const contextDetails = $('#context-details');
const resultPlaceholder = $('#result-placeholder');
const resultsContent = $('#results-content');
const resultTitle = $('#result-title');
const resultCount = $('#result-count');
const exportButton = $('#export-button');
const scopeToggle = $('#scope-toggle');

let latestResults = [];
let latestParsed = null;
let latestCache = { reused: 0, fresh: 0 };

function setScopeUI(scope) {
  const current = scope === 'cached' ? 'cached' : 'all';
  scopeToggle.querySelectorAll('.scope-btn').forEach((btn) => {
    const active = btn.dataset.scope === current;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
}

async function initScopeControl() {
  const cfg = await window.researchDesk.getSettings();
  setScopeUI(cfg.research?.scope || 'all');
  scopeToggle.querySelectorAll('.scope-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      setScopeUI(btn.dataset.scope);
      const current = await window.researchDesk.getSettings();
      await window.researchDesk.saveSettings({ ...current, research: { scope: btn.dataset.scope } });
    });
  });
}

const initialStages = [
  ['识别指令', '等待你的研究问题'], ['获取股票集合', '不预先加载'], ['按需获取披露', '等候目标范围'], ['抽取业务事实', '等候原始文档'], ['整理研究结果', '等候分析完成']
];

const builtinConcepts = {
  '光纤': { type: '核心词', related: ['光通信', '光缆', '光纤预制棒', '光导纤维', '特种光纤'], note: '构建上下游与同义词关系' },
  '科创板': { type: '板块', related: ['688', '科技创新', '半导体', '高端制造'], note: '以代码前缀和主题关联' },
  '新能源': { type: '行业', related: ['光伏', '储能', '锂电', '风电', '充电桩'], note: '拆分为产业链环节' },
  '半导体': { type: '行业', related: ['芯片', '晶圆代工', '集成电路', '封测', '设备'], note: '含上下游判断' }
};

function renderPipeline(stages = initialStages) {
  pipeline.innerHTML = stages.map((stage, index) => {
    const value = Array.isArray(stage) ? { label: stage[0], detail: stage[1], state: 'pending' } : stage;
    const marker = value.state === 'done' ? '✓' : value.state === 'running' ? '•' : String(index + 1).padStart(2, '0');
    return `<div class="stage ${value.state}"><div class="stage-dot">${marker}</div><span class="stage-name">${value.label}</span><span class="stage-detail">${value.detail}</span></div>`;
  }).join('');
}

function renderContext(parsed, cache = { reused: 0, fresh: 0 }, mode = '演示数据') {
  latestParsed = parsed;
  latestCache = cache;
  contextEmpty.classList.add('hidden');
  contextDetails.classList.remove('hidden');
  contextDetails.innerHTML = [
    ['研究范围', parsed.universe],
    ['搜索范围', parsed.scope === 'cached' ? '仅已分析股票' : '全部股票（含未分析）'],
    ['筛选条件', parsed.sort],
    ['分析范围', parsed.analysisScope],
    ['执行模式', mode],
    ['计划数量', `${parsed.count} 家`],
    ['本地缓存', `${cache.reused} 家复用 · ${cache.fresh} 家新分析`],
    ['数据窗口', parsed.specificYear ? `${parsed.specificYear}年年度报告` : (parsed.windowYears === 1 ? '最近一个会计年度' : `最近 ${parsed.windowYears} 年`)],
    ['采集策略', '按需 · 逐步执行']
  ].map(([key, value]) => `<div class="context-row"><span>${key}</span><strong>${value}</strong></div>`).join('');
}

function renderResults(payload) {
  latestResults = payload.results;
  resultPlaceholder.classList.add('hidden');
  resultsContent.classList.remove('hidden');
  resultTitle.textContent = `${payload.parsed.universe} · ${payload.parsed.sort}`;
  resultCount.textContent = `已获取 ${payload.results.length} 家`;
  exportButton.disabled = false;
  const rows = payload.results.map((item) => {
    const mc = Number(item.marketCap);
    const mcCell = mc > 0
      ? `<b>${mc.toLocaleString()}</b><span class="unit">亿元</span>`
      : `<span class="muted">—</span><div class="evidence">待确认</div>`;
    const changeCell = typeof item.change === 'number'
      ? `<span class="${item.change >= 0 ? 'confidence' : 'confidence partial'}">${item.change >= 0 ? '+' : ''}${item.change}% 今日</span>`
      : '';
    const cachedAt = item.cachedAt ? `<div class="evidence">保存于 ${new Date(item.cachedAt).toLocaleDateString('zh-CN')}</div>` : '';
    const source = item.source || item.reports || '—';
    const facts = Array.isArray(item.facts) && item.facts.length ? item.facts : [];
    const reportTitles = [...new Set(facts.map((f) => f.source || '').filter(Boolean))];
    const realSource = reportTitles.length
      ? reportTitles.slice(0, 4).join('、') + (reportTitles.length > 4 ? ` 等 ${reportTitles.length} 份年报` : '')
      : source;
    const factsCell = facts.length
      ? facts.slice(0, 4).map((f) => `<div class="fact-item"><b>${f.year || '—'}年</b> ${f.product || '—'}<div class="evidence">${(f.description || '').slice(0, 60)}<i> · ${f.source || source}</i></div></div>`).join('')
      : `<span class="muted">仅有摘要，未抽取逐年事实</span>`;
    const businessCell = item.business && item.business !== item.match
      ? `<div class="evidence">${item.business}</div>`
      : `<div class="evidence">${item.match}</div>`;
    const hitsTag = Array.isArray(item.hits) && item.hits.length ? `<div class="evidence">命中关键词：<b class="confidence">${item.hits.join('、')}</b></div>` : '';
    const scoreTag = typeof item.score === 'number' && item.score > 0 ? `<div class="evidence">相关度：命中 ${item.score} 个关键词</div>` : '';
    const evidenceItems = [];
    if (Array.isArray(item.relevance) && item.relevance.length) {
      item.relevance.forEach((e) => evidenceItems.push(`<div class="evidence-item"><b>${e.term}</b><span>${e.snippet}</span><span class="source-tag">${e.source}${e.via ? ` · ${e.via}` : ''}</span></div>`));
    }
    if (item.reason) evidenceItems.push(`<div class="evidence-item reason">${item.reason}</div>`);
    const evidenceCell = evidenceItems.length ? evidenceItems.join('') : `<span class="muted">—</span>`;
    return `<tr><td>${String(item.rank).padStart(2, '0')}</td><td><span class="stock-name">${item.name}</span><span class="stock-code">${item.code}</span><br /><span class="stock-code">${item.sector}</span></td><td>${mcCell}${changeCell ? `<br />${changeCell}` : ''}</td><td><b>${item.match}</b>${hitsTag}${scoreTag}${businessCell}</td><td class="facts-cell">${factsCell}</td><td class="evidence-cell">${evidenceCell}</td><td><span class="source-tag">${realSource}</span></td><td><span class="tag ${item.status === 'partial' ? 'partial' : 'high'}">${item.status === 'partial' ? '部分缺失' : '已分析'}</span><div class="evidence">${item.evidence}</div><div class="confidence ${item.status === 'partial' ? 'partial' : ''}">${item.confidence}可信度</div></td><td><span class="tag ${item.cacheStatus === 'reused' ? 'cached' : 'new'}">${item.cacheStatus === 'reused' ? '已复用' : '本次新分析'}</span>${cachedAt}</td></tr>`;
  }).join('');
  resultsContent.innerHTML = `<table class="result-table"><thead><tr><th>#</th><th>公司</th><th>总市值</th><th>业务摘要</th><th>业务事实</th><th>相关依据</th><th>信息来源</th><th>证据状态</th><th>本次处理</th></tr></thead><tbody>${rows}</tbody></table><div class="notice">${payload.dataNotice}</div>`;
}

function setRunning(running) {
  runButton.disabled = running;
  runButton.innerHTML = running ? '<span class="play">●</span>执行中…' : '<span class="play">▶</span>开始执行';
  workflowState.textContent = running ? '正在执行' : '已完成';
  document.querySelector('.live-label').className = `live-label ${running ? 'running' : 'done'}`;
}

/* ---------- 视图切换 ---------- */
const VIEW_TITLES = { research: '研究任务', assets: '数据资产', concepts: '概念词典', history: '任务记录', settings: '数据源与设置' };

function switchView(view) {
  document.querySelectorAll('.view').forEach((el) => el.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach((el) => el.classList.remove('active'));
  const target = document.getElementById(`view-${view}`);
  if (target) target.classList.add('active');
  const nav = document.querySelector(`[data-view="${view}"]`);
  if (nav) nav.classList.add('active');
  if (view === 'assets') refreshAssets();
  if (view === 'history') refreshHistory();
  if (view === 'settings') loadSettingsForm();
}

document.querySelectorAll('[data-view]').forEach((btn) => btn.addEventListener('click', () => switchView(btn.dataset.view)));

/* ---------- 设置 ---------- */
async function loadSettingsForm() {
  const cfg = await window.researchDesk.getSettings();
  $('#set-baseurl').value = cfg.ai?.baseUrl || '';
  $('#set-apikey').value = cfg.ai?.apiKey || '';
  $('#set-model').value = cfg.ai?.model || '';
  $('#set-maxtokens').value = cfg.ai?.maxTokens || 8192;
  $('#set-timeout').value = cfg.ai?.timeout || 120;
  $('#set-extra').value = cfg.ai?.extraParams || '';
  $('#set-realdata').checked = cfg.research?.realData !== false;
  renderCurrentConfig(cfg);
  updateStatusPill(cfg);
}

function renderCurrentConfig(cfg) {
  const ai = cfg.ai || {};
  const configured = !!(ai.baseUrl && ai.apiKey && ai.model);
  $('#current-config').innerHTML = configured
    ? `<div class="config-active"><i></i>已配置：<b>${ai.baseUrl}</b> · 模型 <b>${ai.model}</b> · 最大 ${ai.maxTokens || 8192} tokens · 超时 ${ai.timeout || 120}s${ai.extraParams ? ' · 附加参数' : ''}</div>`
    : `<div class="config-idle"><i></i>尚未配置 AI 接口</div>`;
  $('#test-result').textContent = '';
  $('#models-result').textContent = '';
}

function updateStatusPill(cfg) {
  const ai = cfg.ai || {};
  const configured = !!(ai.baseUrl && ai.apiKey && ai.model);
  $('#status-text').textContent = configured ? 'AI 已连接' : '演示模式 · 待接入';
  document.querySelector('.source-status i').style.background = configured ? '#2f9a75' : '#eb8351';
}

async function saveSettingsHandler() {
  const cfg = {
    ai: {
      baseUrl: $('#set-baseurl').value.trim().replace(/\/+$/, ''),
      apiKey: $('#set-apikey').value.trim(),
      model: $('#set-model').value.trim(),
      maxTokens: Number($('#set-maxtokens').value) || 8192,
      timeout: Number($('#set-timeout').value) || 120,
      extraParams: $('#set-extra').value.trim()
    },
    research: { realData: $('#set-realdata').checked }
  };
  const result = await window.researchDesk.saveSettings(cfg);
  if (result?.ok) {
    $('#test-result').innerHTML = `<div class="ok">设置已保存</div>`;
    renderCurrentConfig(cfg);
    updateStatusPill(cfg);
  }
}

function currentParams() {
  return {
    baseUrl: $('#set-baseurl').value.trim().replace(/\/+$/, ''),
    apiKey: $('#set-apikey').value.trim(),
    model: $('#set-model').value.trim(),
    maxTokens: Number($('#set-maxtokens').value) || 8192,
    timeout: Number($('#set-timeout').value) || 120,
    extraParams: $('#set-extra').value.trim()
  };
}

async function testConnectionHandler() {
  const target = $('#test-result');
  target.innerHTML = `<div class="testing">正在测试连接…</div>`;
  const params = currentParams();
  if (!params.baseUrl || !params.apiKey || !params.model) {
    target.innerHTML = `<div class="fail">请先填写 Base URL、Key 和模型名称</div>`;
    return;
  }
  const res = await window.researchDesk.testConnection(params);
  if (res.ok) {
    const extra = [];
    if (res.model) extra.push(`模型回显：${res.model}`);
    if (res.reasoning) extra.push(`含推理过程（reasoning_content）`);
    if (res.usage) extra.push(`本次用量 ${res.usage.total_tokens ?? '?'} tokens`);
    target.innerHTML = `<div class="ok">✓ 连接成功：${res.message}${extra.length ? ` · ${extra.join(' · ')}` : ''}</div>`;
  } else {
    target.innerHTML = `<div class="fail">✕ 连接失败：${res.message}</div>`;
  }
}

async function listModelsHandler() {
  const target = $('#models-result');
  target.innerHTML = `<div class="testing">正在获取模型列表…（部分中转站未开放 /models，会失败，属正常现象）</div>`;
  const params = {
    baseUrl: $('#set-baseurl').value.trim().replace(/\/+$/, ''),
    apiKey: $('#set-apikey').value.trim()
  };
  if (!params.baseUrl || !params.apiKey) {
    target.innerHTML = `<div class="fail">请先填写 Base URL 和 API Key</div>`;
    return;
  }
  const res = await window.researchDesk.listModels(params);
  if (!res.ok) {
    target.innerHTML = `<div class="fail">✕ ${res.message}</div>`;
    return;
  }
  const current = $('#set-model').value.trim();
  $('#models-result').innerHTML = `<div class="ok">✓ 该接口提供 ${res.models.length} 个模型，可按实际模型名修改上方「模型名称」：</div><div class="models-list">${res.models.map((m) => `<div><span class="${m.id === current ? 'm-current' : ''}">${m.id}</span><span>${m.owned || ''}</span></div>`).join('')}</div>`;
  if (!res.models.some((m) => m.id === current)) {
    $('#models-result').innerHTML += `<div class="cap-hint"><b>提示：</b>当前填写的模型名 <b>${current}</b> 未出现在列表中。中转站通常需要精确匹配其模型名（如别名、编号），请从上方列表中选择，或询问中转站客服确认真实模型名。</div>`;
  }
}

$('#settings-form').addEventListener('submit', (e) => { e.preventDefault(); saveSettingsHandler(); });
$('#test-btn').addEventListener('click', testConnectionHandler);
$('#models-btn').addEventListener('click', listModelsHandler);

/* ---------- 数据资产 ---------- */
async function refreshAssets() {
  const cache = await window.researchDesk.getCache();
  const entries = Object.entries(cache || {});
  const tbody = $('#assets-tbody');
  if (!entries.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#a0aab7;padding:30px">还没有缓存数据，先执行一个研究任务吧</td></tr>`;
  } else {
    tbody.innerHTML = entries.map(([code, v]) => {
      const facts = Array.isArray(v.facts) ? v.facts : [];
      const products = Array.isArray(v.products) ? v.products : [];
      const factsHtml = facts.slice(0, 3).map((f) => `<div class="fact-item"><b>${f.year || '—'}年</b> ${f.product || '—'}<span class="evidence">${(f.description || '').slice(0, 40)}</span></div>`).join('') + (facts.length > 3 ? `<div class="evidence">…另有 ${facts.length - 3} 条</div>` : '');
      return `<tr>
        <td><span class="stock-code">${code}</span></td>
        <td><span class="stock-name">${v.name || '未知'}</span></td>
        <td>${(v.analysisScopes || [v.analysisScope]).join(' / ') || '—'}</td>
        <td>${v.cachedAt ? new Date(v.cachedAt).toLocaleString('zh-CN') : '—'}</td>
        <td class="facts-cell"><b>${v.match || '—'}</b><div class="evidence">${facts.length ? `共 ${facts.length} 条逐年业务事实 · ${products.length} 项产品` : '无逐年事实（旧缓存，请重新分析）'}</div>${factsHtml}</td>
      </tr>`;
    }).join('');
  }
  const cachedCount = entries.length;
  const factsTotal = entries.reduce((acc, [, v]) => acc + (Array.isArray(v.facts) ? v.facts.length : 0), 0);
  $('#assets-summary').innerHTML = `
    <div class="hero-stat"><b>${cachedCount}</b><span>已缓存股票</span></div>
    <div class="hero-stat"><b>${new Set(entries.flatMap(([, v]) => v.analysisScopes || [v.analysisScope])).size}</b><span>分析覆盖类型</span></div>
    <div class="hero-stat"><b>${factsTotal}</b><span>逐年业务事实（条）</span></div>
    <div class="hero-stat"><b>${entries.filter(([, v]) => v.status === 'partial').length}</b><span>部分数据</span></div>`;
}

$('#assets-refresh').addEventListener('click', refreshAssets);
$('#assets-clear').addEventListener('click', async () => {
  if (!confirm('确定清空全部本地缓存？')) return;
  await window.researchDesk.clearCache();
  refreshAssets();
});

/* ---------- 任务记录 ---------- */
async function refreshHistory() {
  const history = await window.researchDesk.getHistory();
  const empty = $('#history-empty');
  const list = $('#history-list');
  if (!history.length) {
    empty.classList.remove('hidden');
    list.innerHTML = '';
    return;
  }
  empty.classList.add('hidden');
  list.innerHTML = history.map((t) => `<div class="history-item">
    <div class="history-head"><span class="tag ${t.mode === 'AI分析' ? 'new' : 'cached'}">${t.mode}</span><b>${t.command}</b><span class="history-time">${new Date(t.timestamp).toLocaleString('zh-CN')}</span></div>
    <div class="history-meta">范围：${t.parsed?.universe} · 结果 ${t.results?.length || 0} 家 · 分析 ${t.parsed?.analysisScope}</div>
    ${t.results && t.results.length ? `<div class="history-stocks">${t.results.map((r) => `<span>${r.name}${r.code ? ' (' + r.code + ')' : ''}</span>`).join('')}</div>` : ''}
  </div>`).join('');
}

$('#history-clear').addEventListener('click', async () => {
  if (!confirm('确定清空全部任务记录？')) return;
  await window.researchDesk.clearHistory();
  refreshHistory();
});

$('#provider-tips').innerHTML = [
  ['DeepSeek', 'https://api.deepseek.com · 模型：deepseek-chat'],
  ['Moonshot (Kimi)', 'https://api.moonshot.cn · 模型：moonshot-v1-8k / kimi-k2'],
  ['智谱 (Zhipu/GLM)', 'https://open.bigmodel.cn · 模型：glm-4-flash / glm-4-plus'],
  ['OpenAI', 'https://api.openai.com/v1 · 模型：gpt-4o / gpt-4o-mini'],
  ['任何其他 OpenAI 兼容服务', '只需填写其 Base URL + Key + 模型名即可']
].map(([name, desc]) => `<div><b>${name}</b>　${desc}</div>`).join('');

/* ---------- 概念词典 ---------- */
function renderConcepts() {
  $('#concept-grid').innerHTML = Object.entries(builtinConcepts).map(([word, info]) => `<div class="concept-card">
    <div class="concept-word">${word}</div>
    <div class="concept-type">${info.type}</div>
    <div class="concept-note">${info.note}</div>
    <div class="concept-related">${info.related.map((r) => `<span>${r}</span>`).join('')}</div>
  </div>`).join('');
}

/* ---------- 研究任务 ---------- */
renderPipeline();
renderConcepts();
document.querySelectorAll('[data-command]').forEach((button) => button.addEventListener('click', () => { commandInput.value = button.dataset.command; commandInput.focus(); }));

runButton.addEventListener('click', () => {
  if (!commandInput.value.trim()) { commandInput.focus(); return; }
  setRunning(true);
  resultsContent.classList.add('hidden');
  resultPlaceholder.classList.remove('hidden');
  resultTitle.textContent = '正在整理结果…';
  resultCount.textContent = '';
  window.researchDesk.run(commandInput.value);
});

window.researchDesk.on('research:started', ({ parsed, stages, cache, mode }) => { renderContext(parsed, cache, mode); renderPipeline(stages); });
window.researchDesk.on('research:stage', ({ stage, stages }) => { renderPipeline(stages); workflowState.textContent = stage.state === 'done' ? `已完成：${stage.label}` : `正在执行：${stage.label}`; });
window.researchDesk.on('research:completed', (payload) => { setRunning(false); renderPipeline(payload.stages); renderResults(payload); renderContext(payload.parsed, payload.cache, payload.mode); workflowState.textContent = '已完成'; document.querySelector('.live-label').className = 'live-label'; });

window.researchDesk.on('research:error', (payload) => {
  setRunning(false);
  renderPipeline(payload.stages || initialStages);
  contextEmpty.classList.add('hidden');
  contextDetails.classList.remove('hidden');
  contextDetails.innerHTML = [
    ['研究范围', payload.parsed?.universe || '—'],
    ['搜索范围', payload.parsed?.scope === 'cached' ? '仅已分析股票' : '全部股票（含未分析）'],
    ['执行模式', payload.mode || '—'],
    ['任务状态', '已取消']
  ].map(([key, value]) => `<div class="context-row"><span>${key}</span><strong>${value}</strong></div>`).join('');
  resultPlaceholder.classList.add('hidden');
  resultsContent.classList.remove('hidden');
  resultTitle.textContent = '任务已取消';
  resultCount.textContent = '';
  exportButton.disabled = true;
  workflowState.textContent = '执行失败';
  document.querySelector('.live-label').className = 'live-label failed';
  resultsContent.innerHTML = `<div class="error-banner">⚠ ${payload.message}</div><div class="notice">可以在「数据源与设置」中检查并测试 AI 连接（超时、Base URL、模型名），修复后重新执行。</div>`;
});

window.researchDesk.on('research:notice', (payload) => {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = payload.message || '';
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 9000);
});

exportButton.addEventListener('click', () => {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const content = ['排名,代码,公司,总市值(亿元),业务摘要,业务描述,主要产品,逐年业务事实,相关依据,信息来源,可信度', ...latestResults.map((item) => {
    const relevance = (Array.isArray(item.relevance) ? item.relevance.map((e) => `[${e.term}]${e.snippet}（${e.source}${e.via ? `·${e.via}` : ''}）`) : []).concat(item.reason ? [`AI说明：${item.reason}`] : []).filter(Boolean);
    return [
      item.rank, item.code, item.name, item.marketCap, item.match,
      item.business || '',
      (item.products || []).join('；'),
      (item.facts || []).map((f) => `${f.year}年(${f.product})${f.description}`).join(' | '),
      relevance.join('；'),
      item.source || item.reports || '—', item.confidence
    ].map(esc).join(',');
  })].join('\n');
  const blob = new Blob([`\ufeff${content}`], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${latestParsed?.universe || '研究结果'}-按需研究.csv`; link.click(); URL.revokeObjectURL(link.href);
});

window.researchDesk.getSettings().then((cfg) => updateStatusPill(cfg));
initScopeControl();