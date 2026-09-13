const https = require('https');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const CNINFO_QUERY = 'https://www.cninfo.com.cn/new/hisAnnouncement/query';
const REPORT_RE = /(\d{4})年.*年度报[^摘]/;
const BUSINESS_MARKERS = ['管理层讨论与分析', '经营情况讨论与分析', '公司业务概要', '主营业务分行业', '分产品情况', '主营业务分析', '业务讨论与分析', '经营情况回顾'];
const NOW = new Date();

function codeToColumn(code = '') {
  if (/^([67][0567][0-9])/i.test(code)) return 'sse';
  if (/^(00[0-9]|30[0-9])/i.test(code)) return 'szse';
  if (/^(43|8[237])/i.test(code)) return 'nse';
  return 'sse';
}

function reportsDir(code) {
  return path.join(app.getPath('userData'), 'reports', code);
}

function manifestPath() {
  return path.join(app.getPath('userData'), 'reports', 'manifest.json');
}

function loadManifest() {
  try { return JSON.parse(fs.readFileSync(manifestPath(), 'utf8')); }
  catch (err) {
    console.error(`巨潮清单读取失败：${err.message}`);
    try {
      const bak = `${manifestPath()}.corrupt-${Date.now()}`;
      fs.copyFileSync(manifestPath(), bak);
      console.error(`已备份损坏清单：${bak}`);
    } catch { /* 备份失败不阻断 */ }
    return {};
  }
}

function saveManifest(manifest) {
  fs.mkdirSync(path.dirname(manifestPath()), { recursive: true });
  fs.writeFileSync(manifestPath(), JSON.stringify(manifest, null, 2), 'utf8');
}

function entryFor(manifest, code) {
  manifest[code] = manifest[code] || { years: [], lastUpdate: null };
  return manifest[code];
}

function hasReport(code, year) {
  return fs.existsSync(path.join(reportsDir(code), `${year}年度报告.pdf`));
}

function post(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0 (A-Share Research Desk)' }
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function downloadFile(url, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  return new Promise((resolve, reject) => {
    const finish = () => {
      const file = fs.createWriteStream(dest);
      const get = (u) => https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0 (A-Share Research Desk)' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { return get(res.headers.location); }
        if (res.statusCode !== 200 && res.statusCode !== 206) return reject(new Error(`HTTP ${res.statusCode} ${url}`));
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      });
      get(url);
    };
    finish();
  });
}

async function listAnnualReports(name, code) {
  const params = new URLSearchParams({
    pageNum: 1, pageSize: 60, tabName: 'fulltext', plate: '',
    column: codeToColumn(code), searchkey: name,
    category: 'category_ndbg_szsh', isHLtitle: 'true'
  });
  const data = await post(CNINFO_QUERY, params.toString());
  const out = [];
  const seen = new Set();
  for (const a of data.announcements || []) {
    const title = (a.announcementTitle || '').replace(/<[^>]+>/g, '');
    const m = title.match(/(\d{4})年.*年度报/);
    if (!m || title.includes('摘要') || /英文|日文|韩文/.test(title)) continue;
    const year = Number(m[1]);
    if (year < 2016 || year > NOW.getFullYear() || seen.has(year)) continue;
    seen.add(year);
    out.push({ year, title: title.trim(), url: 'https://static.cninfo.com.cn/' + a.adjunctUrl });
  }
  return out.sort((a, b) => b.year - a.year).slice(0, 20);
}

async function downloadReports(name, code, opts = {}) {
  const { limitYears = 10, specificYear = null, onProgress } = opts;
  const manifest = loadManifest();
  const ent = entryFor(manifest, code);
  let reports = await listAnnualReports(name, code);
  if (specificYear) reports = reports.filter((r) => r.year === specificYear);
  else reports = reports.slice(0, Math.max(1, Math.min(limitYears, 20)));
  const dir = reportsDir(code);
  const downloaded = [];
  for (const r of reports) {
    const dest = path.join(dir, `${r.year}年度报告.pdf`);
    if (fs.existsSync(dest)) { downloaded.push({ ...r, local: dest }); continue; }
    try {
      if (onProgress) onProgress(`下载 ${code} ${r.year} 年报…`);
      await downloadFile(r.url, dest);
      downloaded.push({ ...r, local: dest });
    } catch { /* skip download errors silently */ }
  }
  ent.years = [...new Set([...ent.years, ...downloaded.map((d) => d.year)])].sort((a, b) => b - a);
  ent.lastUpdate = NOW.toISOString();
  saveManifest(manifest);
  return downloaded;
}

async function extractTextFromPdf(pdfPath) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)), verbosity: 0 }).promise;
  const pages = [];
  for (let i = 1; i <= Math.min(doc.numPages, 150); i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    pages.push({ page: i, text: tc.items.map((it) => it.str).join(' ') });
  }
  return pages;
}

function pickBusinessPages(pages) {
  const set = new Set();
  pages.forEach((p, idx) => {
    if (BUSINESS_MARKERS.some((m) => p.text.includes(m))) {
      for (let j = Math.max(0, idx - 1); j <= Math.min(pages.length - 1, idx + 3); j++) set.add(j);
    }
  });
  if (set.size === 0) { for (let j = 0; j < Math.min(6, pages.length); j++) set.add(j); }
  return [...set].sort((a, b) => a - b).slice(0, 14).map((i) => pages[i]);
}

function buildReportSnippet(pages) {
  return pages.map((p) => `[第${p.page}页] ${p.text.replace(/\s+/g, ' ').slice(0, 3000)}`).join('\n\n');
}

async function fetchReportTexts(name, code, opts = {}) {
  const downloaded = await downloadReports(name, code, opts);
  const texts = [];
  for (const d of downloaded) {
    try {
      if (opts.onProgress) opts.onProgress(`解析 ${code} ${d.year} 年报…`);
      const pages = await extractTextFromPdf(d.local);
      const business = pickBusinessPages(pages);
      texts.push({ year: d.year, title: d.title, local: d.local, pages: business, snippet: buildReportSnippet(business) });
    } catch { /* skip parse errors */ }
  }
  return texts.sort((a, b) => b.year - a.year);
}

async function checkNewYears(name, code) {
  const manifest = loadManifest();
  const ent = entryFor(manifest, code);
  const latestReportYears = await listAnnualReports(name, code);
  const newestReportYear = Math.max(...latestReportYears.map((r) => r.year), 0);
  const latestCached = Math.max(...(ent.years || [0]), 0);
  return newestReportYear > latestCached ? newestReportYear : null;
}

module.exports = { listAnnualReports, downloadReports, fetchReportTexts, checkNewYears, hasReport, loadManifest, saveManifest, entryFor, codeToColumn };
