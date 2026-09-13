const { app, BrowserWindow, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const ai = require('./ai');
const cninfo = require('./cninfo');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let config = { ai: { baseUrl: '', apiKey: '', model: '', maxTokens: 8192, timeout: 120, extraParams: '' }, research: { scope: 'all', realData: true } };
let researchCache = {};
let taskHistory = [];

function userDataDir() { return app.getPath('userData'); }
function configFile() { return path.join(userDataDir(), 'config.json'); }
function cacheFile() { return path.join(userDataDir(), 'research-cache.json'); }
function historyFile() { return path.join(userDataDir(), 'task-history.json'); }

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) {
    console.error(`JSON 读取失败（${file}）：${err.message}`);
    try {
      const bak = `${file}.corrupt-${Date.now()}`;
      fs.copyFileSync(file, bak);
      console.error(`已备份损坏文件：${bak}`);
    } catch { /* 备份失败不阻断 */ }
    return fallback;
  }
}

function saveJSON(file, data) {
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function loadConfig() { config = loadJSON(configFile(), config); ai.setConfig(config); }
function saveConfig() { saveJSON(configFile(), config); ai.setConfig(config); }
function loadResearchCache() { researchCache = loadJSON(cacheFile(), {}); }
function saveResearchCache() { saveJSON(cacheFile(), researchCache); }
function loadTaskHistory() { taskHistory = loadJSON(historyFile(), []); }
function saveTaskHistory() { saveJSON(historyFile(), taskHistory); }

const EXTRA_KNOWN_NAMES = [
  '贵州茅台','泸州老窖','宁德时代','五粮液','比亚迪','招商银行','中国平安','中国移动','长江电力','中国神华',
  '美的集团','海尔智家','格力电器','隆基绿能','阳光电源','通威股份','TCL科技','京东方A','立讯精密','歌尔股份',
  '三一重工','中国中免','紫金矿业','恒瑞医药','药明康德','迈瑞医疗','爱尔眼科','万科A','保利发展','工商银行',
  '建设银行','农业银行','中国银行','中国人寿','中国石油','中国石化','海螺水泥','万华化学','北方稀土','片仔癀',
  '云南白药','顺丰控股','伊利股份','海天味业','山西汾酒','大秦铁路','温氏股份','中远海控','中国铝业'
];
const ALIAS_NAMES = { '茅台': '贵州茅台' };

function countSubjectPhrases(command) {
  if (!/分析|研究|调研|看看|看下|关注/.test(command) || /龙头|概念|热门|板块|行业|赛道|机会|成分股|名单|梳理|哪些|全景|概览|优选|盘点/.test(command)) return 0;
  if (String(command).length > 24) return 0;
  const subject = String(command)
    .replace(/\d{6}/g, ' ')
    .replace(/分析|研究|调研|看看|看下|关注|查询|帮我|请|给我|评估|评价|剖析|拆解|一下|这家|那家|这只|那只|这支|那支|近期|近些|最新|的|了|呢|和|与|及|或|等/g, ' ')
    .trim();
  const stop = new Set(['年报','财报','中报','季报','业务','基本面','发展','走势','行情','业绩','情况','主营','表现','公司','个股','企业','股票','如何','怎样','怎么样','好不好','龙头','板块','行业','市场','同行']);
  const parts = subject.split(/[\s、，,;；/]+/).filter((t) => t.length >= 2 && !stop.has(t));
  return parts.length >= 1 && parts.length <= 5 ? parts.length : 0;
}

function parseCommand(command) {
  const countMatch = command.match(/(?:最大|前|top|TOP|取|只要|选出|找出|调研|给)\s*(\d+)\s*(?:家|支|只|个|大|名)?|(\d+)\s*(?:家|支|只|个|家公司|个股|股票)\s*|(?:一共|最多|总共)\s*(\d+)/);
  const codeHits = [...new Set((String(command).match(/\b\d{6}\b/g) || []))].filter((c) => /^(60|68|00|30|43|8|92)/.test(c));
  const nameHits = /分析|研究|调研|看看|看下|关注/.test(command)
    ? [...new Set([...demoUniverse.map((s) => s.name), ...EXTRA_KNOWN_NAMES])]
        .map((n) => ALIAS_NAMES[n] || n)
        .filter((n) => n && command.includes(n))
    : [];
  const count = Math.min(Math.max(
    Number((countMatch && (countMatch[1] || countMatch[2] || countMatch[3])) || Math.max(codeHits.length, nameHits.length, countSubjectPhrases(command)) || 10),
    1
  ), 50);
  const hasStar = /科创\s*50|科创板|688/.test(command);
  const sortByMarketCap = /市值|市值最大|规模/.test(command);
  const needsBusinessAnalysis = /业务|主营|财报|年报|公告|产品|研发|包含|涉及|企业/.test(command);
  const hasCachedHint = /已分析|已经分析|已缓存|现有|存量|已有/.test(command);
  const hasAllHint = /全部|所有|新的/.test(command);

  const WINDOW_MAP = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12, 十三: 13, 十四: 14, 十五: 15, 十六: 16, 十七: 17, 十八: 18, 十九: 19, 二十: 20, 二十一: 21, 三十: 30 }; // 至少覆盖常用窗口
  let windowYears = 1;
  const wm = command.match(/近?\s*([一二三四五六七八九十两]+)\s*年/);
  if (wm && WINDOW_MAP[wm[1]]) {
    windowYears = Math.min(WINDOW_MAP[wm[1]], 50);
  } else if (/多年|历年|历史|近十年|十年/.test(command)) {
    windowYears = 10;
  }
  let specificYear = null;
  const ym = command.match(/(20\d{2})\s*年[的度]*\s*年?报/);
  if (ym) specificYear = Number(ym[1]);
  else if (/去年/.test(command)) specificYear = new Date().getFullYear() - 1;

  const universe = hasStar
    ? '科创50'
    : hasCachedHint ? '已分析股票库'
    : /创业板|深证/.test(command) ? '深市'
    : /北交所/.test(command) ? '北交所'
    : 'A股全市场';
  return {
    universe,
    count: Math.min(Math.max(count, 1), 50),
    sort: sortByMarketCap ? '总市值降序' : '按指令默认排序',
    analysisScope: needsBusinessAnalysis ? '业务与财报' : '基础信息',
    scopeHint: hasCachedHint ? 'cached' : (hasAllHint ? 'all' : null),
    windowYears,
    specificYear,
    intent: command.trim()
  };
}

function makeStages(parsed) {
  const windowLabel = parsed.specificYear
    ? `${parsed.specificYear}年年度报告`
    : (parsed.windowYears === 1 ? '最新一年年度报告' : `最近 ${parsed.windowYears} 年年度报告`);
  return [
    { id: 'intent', label: '识别指令', detail: `目标：${parsed.universe} · ${parsed.sort}`, state: 'pending' },
    { id: 'universe', label: '获取股票集合', detail: `仅拉取 ${parsed.universe} 成分及市值字段`, state: 'pending' },
    { id: 'reports', label: '按需获取披露', detail: `为每家公司补充${windowLabel}索引`, state: 'pending' },
    { id: 'extract', label: '抽取业务事实', detail: `分析范围：${windowLabel}`, state: 'pending' },
    { id: 'result', label: '整理研究结果', detail: '生成可追溯的公司卡片和缺失数据提示', state: 'pending' }
  ];
}

const AI_SYSTEM_PROMPT = `你是A股上市公司研究助手。用户要求"分析业务"时，默认基于上市公司**最近一个会计年度**的年度报告；若用户明确要求"近十年/多年/某一具体年度"，则按用户指定的年度范围执行。你需尽力还原目标公司在该报告期的主营业务与产品线，并完整输出，而不是只给一句话摘要。

重要规则：
1. 只返回你在训练数据中确信存在的公司
2. 对于不确定的信息，明确标注 confidence 为"低"
3. 输出格式必须是严格的JSON数组，不要包含其他文字
4. 每个公司必须包含以下字段：
   - code: 股票代码（6位数字字符串，如"688981"）
   - name: 公司名称
   - marketCap: 总市值（亿元，数字，不确定时填0）
   - sector: 所属行业
   - match: 与用户查询最相关的主营业务概括（1-2句话）
   - business: 主营业务详细描述（2-4句话，涵盖指定报告期的产品线与业务概况）
   - products: 主要产品/业务/技术方向数组（字符串列表，至少3项）
   - facts: 目标报告期的业务事实数组，每条为 {year: "年报所属年度如2024", product: "产品/业务名称", description: "当年披露的具体业务说明", source: "如2024年年度报告", confidence: "高/中/低"}，至少输出3条，年度范围与用户指定的报告期一致
   - source: 主要信息来源披露文件，例如"2025年年度报告"
   - evidence: 你判断的依据来源说明
   - confidence: "高" / "中" / "低"
   - status: "ready" 或 "partial"

输出示例：
[{"code":"688981","name":"中芯国际","marketCap":6421,"sector":"半导体","match":"集成电路晶圆代工，先进制程与成熟制程并重","business":"公司主营集成电路晶圆代工及配套测试服务，近十年持续推进FinFET先进制程与成熟特色工艺量产，产能从2016年的300K约当八英寸晶圆/月扩展到2024年逾700K/月。","products":["集成电路晶圆代工","先进制程（FinFET/3D NAND配套）","特色工艺（BCD/高压/射频/嵌入式存储）","封装测试配套服务"],"facts":[{"year":"2024","product":"先进制程","description":"FinFET工艺收入占比提升至约60%，新建12英寸产能投产","source":"2024年年度报告","confidence":"高"},{"year":"2019","product":"特色工艺","description":"成熟制程逐步向BCD、功率器件等特色工艺转型","source":"2019年年度报告","confidence":"中"},{"year":"2016","product":"晶圆代工","description":"提供0.35um至28nm晶圆代工服务，客户覆盖全球","source":"2016年年度报告","confidence":"中"}],"source":"2025年年度报告","evidence":"公司业务概要章节","confidence":"高","status":"ready"}]`;

const REAL_REPORT_PROMPT = `你是A股上市公司年报分析员。根据下方提供的公司年报章节摘录（含页码，可能为最近一财年、若干年度或指定年度），直接输出该公司的业务摘要与对应年度的逐年业务事实。

重要规则：
1. 只依据提供的年报文本，不要捏造文本中未出现的信息
2. facts 的 source 必须填入对应年度的报告标题（如"2023年年度报告"），page 填该条事实对应摘录中的页码（如"第21页"），quote 从原文中选取一句最能代表该产品/事实的原话（保留原文标点）
3. 输出严格 JSON 数组（仅一个元素），字段：code, name, marketCap（未提及填0）, sector, match（与查询最相关的主营概括）, business（2-4句）, products（至少3项）, facts（逐年数组，含 year/product/description/source/page/quote/confidence），source, evidence, confidence, status
4. 若某年份摘录缺失或未提及该产品，不要编造该年度事实`;

function filterFactsByWindow(facts, parsed) {
  if (!Array.isArray(facts) || !facts.length) return facts;
  if (parsed.specificYear) return facts.filter((f) => Number(f.year) === parsed.specificYear);
  if (parsed.windowYears >= 10) return facts;
  const years = [...new Set(facts.map((f) => Number(f.year)).filter(Boolean))].sort((a, b) => b - a);
  const keep = new Set(years.slice(0, parsed.windowYears));
  return facts.filter((f) => keep.has(Number(f.year)));
}

function isStaleEntry(entry) {
  if (!entry || !entry.code) return false;
  return !Array.isArray(entry.facts) || entry.facts.length === 0 || !entry.business;
}

function canReuse(result, parsed) {
  const cached = researchCache[result.code];
  if (!cached || isStaleEntry(cached)) return false;
  const scopes = cached.analysisScopes || (cached.analysisScope ? [cached.analysisScope] : ['基础信息']);
  return parsed.analysisScope === '基础信息' || scopes.includes('业务与财报');
}

function getCachedResults(results) {
  return results.map((result) => {
    const cached = researchCache[result.code];
    return cached ? { ...cached, rank: result.rank, cacheStatus: 'reused' } : result;
  });
}

function saveResultToCache(result, analysisScope) {
  const previous = researchCache[result.code];
  const previousScopes = previous?.analysisScopes || (previous?.analysisScope ? [previous.analysisScope] : []);
  researchCache[result.code] = {
    cacheVersion: 3,
    ...previous,
    ...result,
    analysisScope,
    analysisScopes: [...new Set([...previousScopes, analysisScope])],
    cacheStatus: 'fresh',
    cachedAt: new Date().toISOString()
  };
  saveResearchCache();
}

function tryParseAIResults(text) {
  const cleaned = String(text || '').replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const start = cleaned.indexOf('[');
  if (start === -1) throw new Error('AI 返回内容中未找到 JSON 数组');
  const candidate = cleaned.slice(start);
  let parsed = null;
  let lastError = null;
  for (let idx = 0; idx < candidate.length; idx++) {
    if (candidate[idx] === ']') {
      try {
        parsed = JSON.parse(candidate.slice(0, idx + 1));
        break;
      } catch (e) {
        lastError = e;
      }
    }
  }
  if (parsed === null || !Array.isArray(parsed)) {
    throw new Error(`AI 返回内容不是有效 JSON 数组（${lastError ? lastError.message : '无可用内容'}）`);
  }
  return parsed.map((item, i) => {
    const source = String(item.source || item.reports || (item.evidence ? '来源待确认' : 'AI 训练数据'));
    const facts = Array.isArray(item.facts)
      ? item.facts
          .map((f) => ({
            year: String((f && f.year) || ''),
            product: String((f && f.product) || ''),
            description: String((f && f.description) || ''),
            source: String((f && f.source) || source),
            confidence: String((f && f.confidence) || '中')
          }))
          .filter((f) => f.product)
      : [];
    return {
      code: String(item.code || ''),
      name: String(item.name || '未知'),
      marketCap: Number(item.marketCap) || 0,
      sector: String(item.sector || '未知'),
      match: String(item.match || ''),
      business: String(item.business || item.match || ''),
      products: Array.isArray(item.products) ? item.products.map(String).filter(Boolean) : [],
      facts,
      source,
      reports: source,
      evidence: String(item.evidence || '基于AI训练数据'),
      reason: String(item.reason || ''),
      confidence: String(item.confidence || '中'),
      status: item.status === 'partial' ? 'partial' : 'ready'
    };
  });
}

function frontOf(results, fallback) {
  const first = (Array.isArray(results) && results[0]) || {};
  if (!first.code && fallback) first.code = fallback.code;
  return first;
}

function cachedUniverse() {
  return Object.values(researchCache).filter((c) => c && c.code).map((c) => ({ ...c }));
}

const AI_QUERY_STOPWORDS = ['请','获取','查找','找到','筛选','分析','研究','包含','涉及','有关','相关','属于','当中','里面','之中','之内','已经','股票','上市','公司','企业','业务','主营','信息','以及','尽量','根据'];
const AI_SINGLE_STOP = new Set('在我的中里和与并先后其家个最按以为');

function extractQueryTerms(command) {
  const words = new Set();
  const s = String(command || '');
  const asciiWords = s.match(/[a-zA-Z0-9]{2,}/g) || [];
  asciiWords.forEach((w) => words.add(w.toLowerCase()));
  let cjk = s.replace(/[a-zA-Z0-9：:，。、！？；\s“”"（）()【】《》.\-/\\]/g, '');
  for (const w of AI_QUERY_STOPWORDS) cjk = cjk.split(w).join('');
  const grams = [];
  for (let i = 0; i < cjk.length; i += 1) {
    const g2 = cjk.substr(i, 2);
    const g3 = cjk.substr(i, 3);
    if (g3.length === 3) grams.push(g3);
    if (g2.length === 2) grams.push(g2);
  }
  [...new Set(grams)].filter((g) => ![...g].every((ch) => AI_SINGLE_STOP.has(ch))).sort((a, b) => b.length - a.length).slice(0, 30).forEach((g) => words.add(g));
  return [...words].sort((a, b) => b.length - a.length).slice(0, 40);
}

function stockSearchText(stock) {
  return [
    stock.name, stock.sector,
    stock.match, stock.business,
    (stock.products || []).join(' '),
    (stock.facts || []).map((f) => `${f.product} ${f.description} ${f.quote || ''} ${f.source}`).join(' ')
  ].join(' ').toLowerCase().replace(/\s+/g, ' ');
}

function findEvidence(stock, terms) {
  const segments = [];
  if (stock.match) segments.push({ text: stock.match, source: stock.source || '业务摘要' });
  if (stock.business) segments.push({ text: stock.business, source: stock.source || '业务描述' });
  (stock.products || []).forEach((p) => segments.push({ text: p, source: '主要产品' }));
  (stock.facts || []).forEach((f) => {
    if (f.quote) segments.push({ text: f.quote, source: `${f.source || '年报'}${f.page ? ` ${f.page}` : ''}`, via: f.product });
  });
  (stock.facts || []).forEach((f) => {
    if (f.product) segments.push({ text: f.product, source: `${f.source || '年报'}${f.page ? ` ${f.page}` : ''}` });
    if (f.description) segments.push({ text: f.description, source: `${f.source || '年报'}${f.page ? ` ${f.page}` : ''}`, via: f.product });
  });
  const evidence = [];
  const lower = segments.map((s) => ({ ...s, lower: s.text.toLowerCase() }));
  [...new Set(terms)].forEach((t) => {
    if (t.length < 2) return;
    for (const seg of lower) {
      const idx = seg.lower.indexOf(t);
      if (idx >= 0) {
        const from = Math.max(0, idx - 10);
        const to = Math.min(seg.text.length, idx + t.length + 20);
        evidence.push({
          term: t,
          snippet: (from > 0 ? '…' : '') + seg.text.slice(from, to) + (to < seg.text.length ? '…' : ''),
          source: seg.source,
          via: seg.via || ''
        });
        break;
      }
    }
  });
  return evidence;
}

function filterPoolByTerms(pool, terms, count) {
  if (!terms.length) return (pool || []).slice(0, count);
  const scored = (pool || [])
    .map((stock) => {
      const hay = stockSearchText(stock);
      const hits = terms.filter((t) => hay.includes(t));
      return { stock, hits, score: hits.length };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, count).map((x, i) => ({ ...x.stock, rank: i + 1, hits: x.hits, score: x.score, relevance: findEvidence(x.stock, x.hits) }));
}

const demoUniverse = [
  { code: '688981', name: '中芯国际', marketCap: 6421, change: 2.14, sector: '半导体', match: '集成电路晶圆代工，先进制程与成熟制程并重', business: '主营集成电路晶圆代工及配套测试服务，近十年从28nm逐步推进FinFET先进制程量产，并持续扩大成熟特色工艺产能。', products: ['集成电路晶圆代工', 'FinFET先进制程', 'BCD高压/射频特色工艺', '5G基带/射频芯片代工', '封装测试服务'], facts: [{ year: '2024', product: '先进制程', description: 'FinFET工艺收入占比提升，新建12英寸产能投产', source: '2024年年度报告', confidence: '高' }, { year: '2019', product: '5G射频工艺', description: '承接5G基带与射频前端芯片代工需求', source: '2019年年度报告', confidence: '中' }, { year: '2016', product: '晶圆代工', description: '提供0.35um至28nm晶圆代工服务，全球客户覆盖，支撑4G/5G设备芯片', source: '2016年年度报告', confidence: '中' }] },
  { code: '688012', name: '中微公司', marketCap: 1698, change: 1.82, sector: '半导体设备', match: '刻蚀设备与薄膜沉积设备', business: '主营高端半导体刻蚀设备与薄膜沉积（MOCVD）设备，近十年实现从65nm到7nm及以下制程的覆盖，国产化替代核心标的。', products: ['等离子体刻蚀机', 'MOCVD设备', 'VOC废气处理设备'], facts: [{ year: '2023', product: '等离子体刻蚀机', description: '介质刻蚀进入5nm以下先进制程产线', source: '2023年年度报告', confidence: '高' }, { year: '2019', product: 'MOCVD', description: 'LED MOCVD设备全球市场占有率领先', source: '2019年年度报告', confidence: '中' }, { year: '2016', product: '刻蚀设备', description: '刻蚀设备量产销售，进入国内主流产线', source: '2016年年度报告', confidence: '中' }] },
  { code: '688111', name: '金山办公', marketCap: 1542, change: -0.38, sector: '软件服务', match: '办公软件与云服务', business: '主营WPS Office办公软件及金山文档云协作服务，近十年完成个人工具到云与AI办公的转型。', products: ['WPS Office', '金山文档', 'WPS AI', '企业云办公套件'], facts: [{ year: '2024', product: 'WPS AI', description: '推出AI写作、表格、演示等AI办公功能', source: '2024年年度报告', confidence: '高' }, { year: '2019', product: '金山文档', description: '在线协作文档用户快速增长', source: '2019年年度报告', confidence: '中' }, { year: '2016', product: 'WPS Office', description: '国产办公软件，政企市场根基深厚', source: '2016年年度报告', confidence: '中' }] },
  { code: '688041', name: '海光信息', marketCap: 1467, change: 3.64, sector: '半导体', match: '高端处理器与加速器', business: '主营高端通用处理器（CPU）与协处理器（DCU），近十年围绕x86兼容自主可控路线，覆盖服务器、工作站与AI算力场景。', products: ['服务器CPU', 'AI加速卡DCU', '工作站处理器'], facts: [{ year: '2024', product: 'AI加速器DCU', description: '深算系列支持大模型训练与推理集群', source: '2024年年度报告', confidence: '高' }, { year: '2020', product: '服务器CPU', description: '7系列服务器CPU规模化商用', source: '2020年年度报告', confidence: '中' }, { year: '2016', product: '处理器研发', description: '启动高端处理器研发，走x86兼容路线', source: '2016年年度报告', confidence: '中' }] },
  { code: '688036', name: '传音控股', marketCap: 1054, change: 0.72, sector: '消费电子', match: '智能终端与移动互联', business: '主营非洲及新兴市场智能手机与移动互联网服务，近十年在非洲市场持续保持领先份额，并向南亚、东南亚扩张。', products: ['5G智能手机', '功能手机', '数码配件', '传音移动互联网平台'], facts: [{ year: '2024', product: '5G智能手机', description: '5G手机在非洲与南亚市场出货放量，同时拓展中东与拉美', source: '2024年年度报告', confidence: '高' }, { year: '2019', product: '功能手机', description: '全球功能手机领导者，深耕新兴市场', source: '2019年年度报告', confidence: '中' }, { year: '2016', product: '智能终端', description: '以性价比智能机切入新兴市场', source: '2016年年度报告', confidence: '中' }] },
  { code: '688256', name: '寒武纪', marketCap: 1018, change: 5.11, sector: '半导体', match: '人工智能芯片', business: '主营云、边、端人工智能芯片与训练器产品，近年围绕大模型AI训练与推理场景推出高算力产品线。', products: ['云端智能芯片', '边缘智能芯片', '训练整机', '推理加速卡'], facts: [{ year: '2024', product: '云端训练芯片', description: '训练整机集群面向千亿参数大模型优化', source: '2024年年度报告', confidence: '高' }, { year: '2020', product: '思元系列', description: '云边端芯片架构统一，软硬件协同', source: '2020年年度报告', confidence: '中' }, { year: '2017', product: 'AI芯片原型', description: '发布首款AI芯片原型产品', source: '2017年年度报告', confidence: '中' }] },
  { code: '688008', name: '澜起科技', marketCap: 1003, change: 2.93, sector: '半导体', match: '内存接口芯片', business: '主营内存接口及模组配套芯片，近十年深度参与DDR4/DDR5国际标准制定，全球市场份额领先。', products: ['内存接口芯片', 'DDR5芯片套片', '时钟芯片（寄存时钟驱动器）', 'PCIe Retimer', '津逮服务器CPU平台'], facts: [{ year: '2024', product: 'DDR5套片', description: 'DDR5通道数持续扩容，配套芯片放量', source: '2024年年度报告', confidence: '高' }, { year: '2019', product: '内存接口芯片', description: '全球三大内存接口芯片供应商之一', source: '2019年年度报告', confidence: '中' }, { year: '2016', product: '寄存时钟驱动器', description: '寄存器时钟驱动器（RCD）等时钟芯片进入全球主流内存模组，保障高速信号时序', source: '2016年年度报告', confidence: '中' }] },
  { code: '688169', name: '石头科技', marketCap: 821, change: -1.06, sector: '智能硬件', match: '智能清洁机器人', business: '主营智能扫地机器人及家用清洁电器，近十年自研激光导航与机械臂整合技术，出海全球多国市场。', products: ['智能扫地机器人', '洗地机', '商用清洁机器人'], facts: [{ year: '2024', product: '扫地机器人', description: '自清洁基站与机械臂扫拖一体产品放量', source: '2024年年度报告', confidence: '高' }, { year: '2019', product: '扫地机器人', description: '自研激光导航产品，海内外双增长', source: '2019年年度报告', confidence: '中' }, { year: '2017', product: '米家扫地机', description: '推出米家扫地机器人并自建品牌', source: '2017年年度报告', confidence: '中' }] },
  { code: '688599', name: '天合光能', marketCap: 794, change: 0.18, sector: '新能源', match: '光伏组件与智慧能源', business: '主营光伏组件、支架与智慧能源整体解决方案，近十年位列全球组件出货第一梯队，并布局N型TOPCon技术。', products: ['光伏组件', '跟踪支架', '储能系统', '智慧能源解决方案'], facts: [{ year: '2024', product: 'N型TOPCon组件', description: 'TOPCon组件出货占比大幅提升', source: '2024年年度报告', confidence: '高' }, { year: '2019', product: '光伏组件', description: '组件出货量位居全球第一梯队', source: '2019年年度报告', confidence: '中' }, { year: '2016', product: '智慧能源', description: '布局电站开发与智慧能源管理', source: '2016年年度报告', confidence: '中' }] },
  { code: '688363', name: '华熙生物', marketCap: 612, change: -0.44, sector: '生物医药', match: '生物活性材料与医疗终端', business: '主营透明质酸等生物活性材料原料、医疗终端产品与功能性护肤品，近十年构建从原料到终端全产业链。', products: ['透明质酸原料', '医美医疗终端', '功能性护肤', '食品级原料'], facts: [{ year: '2024', product: '功能性护肤品', description: '自有品牌矩阵持续迭代，原料+终端协同', source: '2024年年度报告', confidence: '高' }, { year: '2019', product: '透明质酸原料', description: '全球透明质酸原料占有率领先', source: '2019年年度报告', confidence: '中' }, { year: '2016', product: '医疗终端', description: '医美终端产品开始放量', source: '2016年年度报告', confidence: '中' }] }
];

function enrichFromCache(result) {
  const cached = researchCache[result.code];
  if (!cached) return result;
  return { ...cached, ...result, cacheStatus: 'reused' };
}

function markAllDone(stages) {
  for (const s of stages) if (s.state !== 'failed') s.state = 'done';
}

async function runResearch(command, send) {
  const parsed = parseCommand(command);
  const scope = parsed.scopeHint || config.research?.scope || 'all';
  if (scope === 'cached' && !parsed.intent.match(/已分析|已经分析|已缓存|现有|存量|已有/)) parsed.universe = '已分析股票库';
  const aiConfigured = !!(config.ai.baseUrl && config.ai.apiKey && config.ai.model);
  const mode = aiConfigured ? (scope === 'cached' ? 'AI筛选' : 'AI分析') : '演示数据';
  const pool = cachedUniverse();
  let refreshedCount = 0;

  const stages = makeStages(parsed);
  stages[1].detail = scope === 'cached'
    ? `仅从 ${pool.length} 家已分析股票中筛选`
    : `获取 ${parsed.universe} 股票集合（含未分析）`;
  stages[2].detail = scope === 'cached'
    ? '范围限于本地已分析缓存，不获取新股票'
    : (aiConfigured ? 'AI 已连接，将基于大模型分析' : '未配置 AI，使用本地演示数据');

  send('research:started', { parsed: { ...parsed, scope }, stages, mode, cache: { reused: 0, fresh: 0, file: cacheFile() } });

  if (aiConfigured) {
    const prevTask = [...taskHistory].reverse().find((t) => t.command === command && (t.parsed?.scope || 'all') === scope && Array.isArray(t.results) && t.results.length);
    if (prevTask) {
      let allCurrent = true;
      for (const r of prevTask.results) {
        if (!r.code) continue;
        try {
          const newer = await cninfo.checkNewYears(r.name, r.code);
          if (newer != null && !cninfo.hasReport(r.code, newer)) { allCurrent = false; break; }
        } catch { allCurrent = false; break; }
      }
      if (allCurrent) {
        stages.forEach((s) => { s.state = 'done'; });
        const results = prevTask.results.map((r) => ({
          ...r,
          cacheStatus: researchCache[r.code] && canReuse({ code: r.code, ...r }, parsed) ? 'reused' : r.cacheStatus,
          facts: filterFactsByWindow(r.facts, parsed)
        }));
        markAllDone(stages);
        send('research:stage', { stage: stages[stages.length - 1], stages });
        send('research:completed', {
          parsed: { ...parsed, scope }, stages, results, mode,
          cache: { reused: results.length, fresh: 0, file: cacheFile() },
          dataNotice: `本次为重复指令，直接复用 ${prevTask.timestamp ? new Date(prevTask.timestamp).toLocaleString('zh-CN') : ''} 已保存的结果（${results.length} 家），未重新分析。`
        });
        return;
      }
    }
  }

  for (const stage of stages) {
    stage.state = 'running';
    send('research:stage', { stage: { ...stage }, stages });

    if (stage.id === 'extract' && aiConfigured) {
      try {
        if (scope === 'cached' && pool.length) {
          const stale = pool.filter((c) => isStaleEntry(c));
          if (stale.length) {
            stage.detail = `检测到 ${stale.length} 家旧格式缓存，正在自动补全业务事实…`;
            send('research:stage', { stage: { ...stage }, stages });
            const refreshed = [];
            for (const c of stale) {
              try {
                const enrichResp = await ai.callAI([
                  { role: 'system', content: AI_SYSTEM_PROMPT },
                  { role: 'user', content: `请对上市公司「${c.name}（${c.code}）」做详细业务分析：基于其最新会计年度报告的公开披露内容，返回该公司的业务信息。仅返回 JSON 数组，包含该公司一条记录。` }
                ]);
                const enriched = frontOf(tryParseAIResults(typeof enrichResp === 'string' ? enrichResp : enrichResp.text), c);
                saveResultToCache({ ...c, ...enriched }, '业务与财报');
                refreshed.push(enriched.code || c.code);
              } catch (innerError) {
                throw new Error(innerError.message || `补全 ${c.name} 业务事实失败`);
              }
            }
            pool.length = 0;
            pool.push(...cachedUniverse());
            stage.detail = `已补全 ${refreshed.length} 家旧缓存，继续抓取关键词…`;
            send('research:stage', { stage: { ...stage }, stages });
            refreshedCount += refreshed.length;
          }

          const poolByCode = new Map(pool.map((c) => [c.code, c]));
          const libraryText = pool.map((c, idx) => `${idx + 1}. ${c.code} ${c.name}（行业：${c.sector}）\n   主营摘要：${c.match || '—'}\n   业务描述：${c.business || '—'}\n   主要产品：${(c.products || []).join('、') || '—'}\n   逐年业务事实：${(c.facts || []).map((f) => `${f.year}年 ${f.product}：${f.description}（${f.source}）`).join('；') || '—'}`).join('\n');
          const userContent = `以下是从「已分析股票信息库」中取出的全部入库内容（严格禁止超出这个范围，禁止引用库外股票）：\n\n${libraryText}\n\n用户查询：${command}\n\n请在以上信息库范围内“抓取”与查询关键词相关的公司，按相关度从高到低输出前 ${parsed.count} 家。只返回 JSON 数组，每个元素包含 code、name、match（该公司的相关业务）、reason（必须引用信息库中该股票的某一条逐年业务事实或主营描述原文，说明为什么它与查询相关）、source（用信息库中该股票已有的来源）、confidence、status。`;

          const aiResponse = await ai.callAI([
            { role: 'system', content: AI_SYSTEM_PROMPT },
            { role: 'user', content: userContent }
          ]);
          stage.detail = 'AI 正在信息库内抓取关键词…';
          send('research:stage', { stage: { ...stage }, stages });
          await sleep(200);

          const aiResults = tryParseAIResults(typeof aiResponse === 'string' ? aiResponse : aiResponse.text);
          const searchTerms = extractQueryTerms(command);
          const byCode = new Map(pool.map((c) => [c.code, c]));
          const results = aiResults
            .filter((r) => poolByCode.has(r.code))
            .slice(0, parsed.count)
            .map((r, i) => {
              const base = byCode.get(r.code);
              const hits = searchTerms.filter((t) => stockSearchText(base).includes(t));
              return { ...base, ...r, rank: i + 1, cacheStatus: 'reused', score: hits.length, hits, relevance: findEvidence(base, hits), reason: r.reason || '' };
            });

          const taskRecord = { id: Date.now(), command, parsed: { ...parsed, scope }, results, mode, timestamp: new Date().toISOString() };
          taskHistory.unshift(taskRecord);
          if (taskHistory.length > 200) taskHistory = taskHistory.slice(0, 200);
          saveTaskHistory();

          stage.state = 'done';
          send('research:stage', { stage: { ...stage }, stages });
          markAllDone(stages);
          send('research:completed', {
            parsed: { ...parsed, scope }, stages, results, mode,
            cache: { reused: results.length, fresh: 0, file: cacheFile() },
            dataNotice: results.length
              ? `${refreshedCount ? `已自动补全 ${refreshedCount} 家旧格式缓存的业务事实；` : ''}AI 已在 ${pool.length} 家已分析股票的信息库内按「${command.replace(/[在已经分析的股票当中查找筛选包含业务]/g, '').trim() || '关键词'}」抓取，命中 ${results.length} 家，全部来自入库数据。`
              : `${refreshedCount ? `已自动补全 ${refreshedCount} 家旧格式缓存，但` : ''}AI 在信息库（${pool.length} 家）内未找到与查询相关的公司，请调整关键词或先分析更多股票。`
          });
          return;
        }

        if (scope === 'cached') {
          stage.detail = '已分析库为空，跳转到提示';
          send('research:stage', { stage: { ...stage }, stages });
          await sleep(200);
          stage.state = 'done';
          send('research:stage', { stage: { ...stage }, stages });
          break;
        }

        const userContent = `请分析以下A股研究指令，返回相关公司信息：\n\n${command}\n\n请返回最多 ${parsed.count} 家公司，按相关度排序。`;

        const aiResponse = await ai.callAI([
          { role: 'system', content: AI_SYSTEM_PROMPT },
          { role: 'user', content: userContent }
        ]);
        stage.detail = 'AI 分析完成，正在解析结果…';
        send('research:stage', { stage: { ...stage }, stages });
        await sleep(200);

        const aiResults = tryParseAIResults(typeof aiResponse === 'string' ? aiResponse : aiResponse.text);

        let enrichedResults = aiResults;
        const enrichedFresh = new Set();
        const usingRealReports = config.research.realData !== false && aiResults.length > 0;
        if (usingRealReports) {
          await sleep(300);
          const windowLabel = parsed.specificYear ? `${parsed.specificYear}年` : (parsed.windowYears === 1 ? '最新一年' : `近 ${parsed.windowYears} 年`);
          stage.detail = `正在核对并解析${windowLabel}年报（巨潮）…`;
          send('research:stage', { stage: { ...stage }, stages });
          enrichedResults = [];
          for (const target of aiResults.slice(0, parsed.count)) {
            const cachedResp = researchCache[target.code];
            const cacheUsable = cachedResp && canReuse({ code: target.code, ...target }, parsed) && Array.isArray(cachedResp.facts) && cachedResp.facts.length > 0;
            if (cacheUsable) {
              let newerYear = null;
              try { newerYear = await cninfo.checkNewYears(target.name, target.code); } catch { /* 校验失败时照常复用 */ }
              let reportOnDisk = false;
              if (newerYear != null) { try { reportOnDisk = cninfo.hasReport(target.code, newerYear); } catch { reportOnDisk = false; } }
              const knownYears = new Set([
                ...((cachedResp.reportYears) || []).map(String),
                ...cachedResp.facts.map((f) => String(Number(f.year))).filter((y) => y !== 'NaN' && y !== '0')
              ]);
              const upToDate = newerYear == null || reportOnDisk || knownYears.has(String(newerYear));
              const windowedFacts = filterFactsByWindow(cachedResp.facts, parsed);
              if (upToDate && (windowedFacts.length || !parsed.specificYear)) {
                stage.detail = `${target.name} 已有最新缓存，跳过重复分析`;
                send('research:stage', { stage: { ...stage }, stages });
                enrichedResults.push({ ...target, ...cachedResp, facts: windowedFacts.length ? windowedFacts : cachedResp.facts });
                continue;
              }
            }
            try {
              const texts = await cninfo.fetchReportTexts(target.name, target.code, {
                limitYears: parsed.windowYears,
                specificYear: parsed.specificYear || undefined,
                onProgress: (msg) => {
                  stage.detail = msg;
                  send('research:stage', { stage: { ...stage }, stages });
                }
              });
              if (!texts.length) { enrichedResults.push({ ...target }); continue; }
              const combined = texts.map((t) => `${t.year}年年度报告（${t.title}）\n${t.snippet}`).join('\n\n');
              stage.detail = `已解析 ${target.name} ${texts.length} 份年报，抽取业务事实…`;
              send('research:stage', { stage: { ...stage }, stages });
              const realRes = await ai.callAI([{ role: 'system', content: REAL_REPORT_PROMPT }, { role: 'user', content: `查询意图：${command}\n\n${combined}` }]);
              const parsedReal = tryParseAIResults(typeof realRes === 'string' ? realRes : realRes.text);
              const enr = parsedReal[0];
              if (enr && enr.code) {
                enrichedResults.push({ ...enr, marketCap: enr.marketCap || target.marketCap, sector: enr.sector || target.sector, code: enr.code, name: enr.name || target.name, facts: filterFactsByWindow(enr.facts, parsed), reportYears: texts.map((t) => t.year) });
                enrichedFresh.add(enr.code);
              } else {
                enrichedResults.push({ ...target });
              }
            } catch {
              enrichedResults.push({ ...target });
            }
          }
        }

        const reuseableResults = enrichedResults.map((r, i) => {
          const rank = i + 1;
          if (enrichedFresh.has(r.code)) return { ...r, rank, cacheStatus: 'fresh' };
          const cached = researchCache[r.code];
          if (canReuse({ code: r.code, ...r, rank }, parsed)) {
            return { ...r, ...cached, rank, cacheStatus: 'reused' };
          }
          return { ...r, rank, cacheStatus: 'fresh' };
        });

        const results = reuseableResults.slice(0, parsed.count).map((r) => ({ ...r, facts: filterFactsByWindow(r.facts, parsed) }));
        const reusedCount = results.filter((r) => r.cacheStatus === 'reused').length;
        const freshCount = results.filter((r) => r.cacheStatus === 'fresh').length;
        results.filter((r) => r.cacheStatus === 'fresh').forEach((result) => saveResultToCache(result, parsed.analysisScope));

        const taskRecord = { id: Date.now(), command, parsed: { ...parsed, scope }, results, mode, timestamp: new Date().toISOString() };
        taskHistory.unshift(taskRecord);
        if (taskHistory.length > 200) taskHistory = taskHistory.slice(0, 200);
        saveTaskHistory();

        stage.state = 'done';
        send('research:stage', { stage: { ...stage }, stages });
        markAllDone(stages);
        send('research:completed', {
          parsed: { ...parsed, scope }, stages, results, mode,
          cache: { reused: reusedCount, fresh: freshCount, file: cacheFile() },
          dataNotice: reusedCount > 0
            ? `${usingRealReports ? '已接入巨潮真实年报。' : ''}本次复用 ${reusedCount} 家已分析缓存，新增分析 ${freshCount} 家。已分析过的股票直接使用缓存，不会重复调用 AI。`
            : `${usingRealReports ? `已下载并解析巨潮${parsed.specificYear ? ` ${parsed.specificYear} 年` : (parsed.windowYears === 1 ? '最新一年' : `近 ${parsed.windowYears} 年`)}年报全文，业务事实与引文均来自真实披露文件。` : ''}AI 分析完成，共找到 ${results.length} 家相关公司。所有结果（含逐年业务事实）已保存至本地缓存。`
        });
        return;
      } catch (error) {
        stage.state = 'failed';
        stage.detail = `AI 调用失败：${error.message}`;
        send('research:stage', { stage: { ...stage }, stages });
        await sleep(300);
        send('research:error', {
          message: `AI 调用失败，本次分析/筛选已取消：${error.message}${scope === 'cached' ? '\n（已分析范围内的筛选同样依赖 AI，未产生任何结果。）' : ''}`,
          parsed: { ...parsed, scope }, stages, mode, stage
        });
        return;
      }
    } else {
      await sleep(stage.id === 'extract' ? 120 : 380);
    }
    stage.state = 'done';
    send('research:stage', { stage: { ...stage }, stages });
  }

  // 本地路径：演示数据 或 已分析缓存（均尊重搜索范围）
  let base;
  let staleLocal = 0;
  if (scope === 'cached') {
    staleLocal = pool.filter((c) => isStaleEntry(c)).length;
    const terms = extractQueryTerms(command);
    base = filterPoolByTerms(pool, terms, parsed.count);
  } else {
    base = demoUniverse.slice(0, parsed.count).map((stock, index) => ({
      ...stock,
      rank: index + 1,
      source: index === 3 ? '2025年半年报·公司业务概要（部分）' : '2025年年度报告·公司业务概要',
      evidence: index === 3 ? '2020 年以前的部分历史报告未完成解析' : '2025年年度报告 公司业务概要 第 18 页',
      confidence: index === 3 ? '待复核' : '高',
      status: index === 3 ? 'partial' : 'ready'
    }));
  }

  const cachedResults = base.filter((result) => canReuse(result, parsed));
  const newResults = base.filter((result) => !canReuse(result, parsed));
  if (scope !== 'cached') newResults.forEach((result) => saveResultToCache(result, parsed.analysisScope));

  const results = (scope === 'cached'
    ? base.map((r) => enrichFromCache(r))
    : getCachedResults(base).map((result) => (
        newResults.some((item) => item.code === result.code) ? { ...result, cacheStatus: 'fresh' } : result
      ))
  ).map((r) => ({ ...r, facts: filterFactsByWindow(r.facts, parsed) }));

  const taskRecord = { id: Date.now(), command, parsed: { ...parsed, scope }, results, mode, timestamp: new Date().toISOString() };
  taskHistory.unshift(taskRecord);
  if (taskHistory.length > 200) taskHistory = taskHistory.slice(0, 200);
  saveTaskHistory();

  markAllDone(stages);
  send('research:completed', {
    parsed: { ...parsed, scope }, stages, results, mode,
    cache: { reused: cachedResults.length, fresh: newResults.length, file: cacheFile() },
    dataNotice: scope === 'cached'
      ? (pool.length
          ? (base.length
              ? `范围：仅已分析股票（共 ${pool.length} 家）。已在本库存储的业务事实中逐条比对关键词${base[0].hits ? `「${base[0].hits.join('、')}」等` : ''}，命中 ${results.length} 家。${staleLocal ? `（另有 ${staleLocal} 家旧格式缓存缺少业务事实，建议先切到「全部股票」模式重跑一次以补全）` : ''}`
              : `${staleLocal ? `本库 ${staleLocal} 家旧格式缓存缺少业务事实。` : ''}在本库的业务事实中未找到匹配公司，请更换关键词或先分析更多股票。`)
          : '目前没有任何已分析股票，请先在「全部股票」模式执行一次分析。')
      : (aiConfigured
          ? `本次复用 ${cachedResults.length} 家缓存，新增分析 ${newResults.length} 家。已分析结果（含逐年业务事实）全部写入本地信息库；筛选任务将只在该库内比对。`
          : `当前为演示数据，尚未配置 AI。本次复用 ${cachedResults.length} 家缓存，新增 ${newResults.length} 家，详细业务事实已写入本地信息库。`)
  });
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440, height: 920, minWidth: 1080, minHeight: 720,
    backgroundColor: '#f5f6f8',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  window.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  loadConfig();
  loadResearchCache();
  loadTaskHistory();
  createWindow();

  ipcMain.handle('settings:get', () => config);
  ipcMain.handle('settings:save', (_event, newConfig) => {
    config = { ...config, ...newConfig };
    saveConfig();
    return { ok: true };
  });
  ipcMain.handle('settings:test', async (_event, params) => {
    try {
      const reply = await ai.callAI([{ role: 'user', content: '请回复：连接成功' }], params);
      const text = typeof reply === 'string' ? reply : reply.text;
      return {
        ok: true,
        message: text.slice(0, 200),
        model: typeof reply === 'object' ? reply.model : undefined,
        reasoning: typeof reply === 'object' ? !!reply.reasoning : undefined,
        usage: typeof reply === 'object' ? reply.usage : undefined
      };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  ipcMain.handle('models:list', async (_event, params) => {
    try {
      const list = await ai.listModels(params);
      return { ok: true, models: list };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  ipcMain.on('research:run', (event, command) => {
    runResearch(String(command || ''), (channel, payload) => event.sender.send(channel, payload));
  });

  ipcMain.handle('history:get', () => taskHistory);
  ipcMain.handle('history:clear', () => { taskHistory = []; saveTaskHistory(); return true; });
  ipcMain.handle('cache:get', () => researchCache);
  ipcMain.handle('cache:clear', () => { researchCache = {}; saveResearchCache(); return true; });

  ipcMain.on('external:open', (_event, url) => {
    if (typeof url === 'string' && /^https:\/\//.test(url)) shell.openExternal(url);
  });

  async function runDailyIncrement(send) {
  if (config.research.realData === false || !ai.isConfigured()) return;
  const manifest = cninfo.loadManifest();
  const today = new Date().toISOString().slice(0, 10);
  if (manifest._dailyCheck === today) return;
  manifest._dailyCheck = today;
  cninfo.saveManifest(manifest);
  const cachedEntries = Object.values(researchCache).filter((c) => c && c.code && Array.isArray(c.facts) && c.facts.length && c.name);
  if (!cachedEntries.length) return;
  let updated = 0;
  let failed = 0;
  for (const ent of cachedEntries) {
    try {
      const newYear = await cninfo.checkNewYears(ent.name, ent.code);
      if (!newYear) continue;
      const texts = await cninfo.fetchReportTexts(ent.name, ent.code, { limitYears: 1 });
      const y = texts.find((t) => t.year === newYear);
      if (!y) continue;
      const res = await ai.callAI([{ role: 'system', content: REAL_REPORT_PROMPT }, { role: 'user', content: `更新以下公司业务事实，仅输出JSON数组：\n\n${ent.name} ${ent.code}\n${y.snippet}` }]);
      const parsed = tryParseAIResults(typeof res === 'string' ? res : res.text);
      const top = parsed[0];
      const newFacts = (Array.isArray(top && top.facts) ? top.facts : []).filter((f) => Number(f.year) === newYear);
      const cur = ent.facts.filter((f) => Number(f.year) !== newYear);
      const fresh = newFacts.length ? newFacts[0] : { year: String(newYear), product: y.title.replace(/(\d{4})年年度报告.*/, '最新年度报告') || String(newYear), description: '见年报', source: y.title, page: y.pages && y.pages[0] ? `第${y.pages[0].page}页` : '' };
      ent.facts = [...cur, fresh].sort((a, b) => (Number(b.year) || 0) - (Number(a.year) || 0));
      if (top && top.business) ent.business = top.business;
      if (top && Array.isArray(top.products) && top.products.length) ent.products = top.products;
      ent.updatedDaily = today;
      updated += 1;
    } catch {
      failed += 1;
    }
  }
  if (updated) {
    saveResearchCache();
    if (send) send('research:notice', { message: `已自动补更 ${updated} 家公司的 ${new Date().getFullYear()} 年年报业务事实${failed ? `（${failed} 家更新失败，详见控制台）` : ''}。` });
  }
}

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  setTimeout(() => {
    runDailyIncrement((channel, payload) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    });
  }, 8000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
