/**
 * GAS 服務的記憶體模擬 — 讓 .gs 在 Node 裡跑得起來
 *
 * 只模擬本專案用到的 API。每個測試案例呼叫 createGas() 拿一套全新的環境，
 * 互不汙染。外部 HTTP（NVIDIA、Telegram）由 gas.http 的路由攔截，測試可以預先
 * 排好 NVIDIA 要回什麼，事後檢查送出了哪些 Telegram 訊息。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

// ─── Spreadsheet ────────────────────────────────────────────────
class Range {
  constructor(sheet, row, col, nr, nc) { Object.assign(this, { sheet, row, col, nr, nc }); }
  getValues() {
    const out = [];
    for (let r = 0; r < this.nr; r++) {
      const src = this.sheet.rows[this.row - 1 + r] || [];
      const line = [];
      for (let c = 0; c < this.nc; c++) {
        const v = src[this.col - 1 + c];
        line.push(v === undefined ? '' : v);
      }
      out.push(line);
    }
    return out;
  }
  setValues(values) {
    values.forEach((line, r) => {
      const idx = this.row - 1 + r;
      while (this.sheet.rows.length <= idx) this.sheet.rows.push([]);
      line.forEach((v, c) => { this.sheet.rows[idx][this.col - 1 + c] = v; });
    });
    return this;
  }
  setNumberFormat() { return this; }
  setFontWeight() { return this; }
  setBackground() { return this; }
}

class Sheet {
  constructor(name) { this.name = name; this.rows = []; }
  getName() { return this.name; }
  getLastRow() {
    for (let i = this.rows.length - 1; i >= 0; i--) {
      if ((this.rows[i] || []).some(v => v !== '' && v !== undefined && v !== null)) return i + 1;
    }
    return 0;
  }
  getRange(a, b, c, d) {
    if (typeof a === 'string') return new Range(this, 1, 1, 0, 0); // 'A:A' 這類只拿來設格式
    return new Range(this, a, b, c || 1, d || 1);
  }
  appendRow(row) { this.rows.length = this.getLastRow(); this.rows.push(row.slice()); }
  deleteRows(start, n) { this.rows.splice(start - 1, n); }
  setFrozenRows() {}
}

class Spreadsheet {
  constructor(id, name) { this.id = id; this.name = name; this.sheets = [new Sheet('工作表1')]; }
  getId() { return this.id; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id; }
  getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; }
  insertSheet(n) { const s = new Sheet(n); this.sheets.push(s); return s; }
  getSheets() { return this.sheets.slice(); }
  deleteSheet(s) { this.sheets = this.sheets.filter(x => x !== s); }
}

// ─── Utilities.formatDate（只支援本專案用到的格式）──────────────
function formatDate(date, tz, fmt) {
  const parts = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hour12: false
  }).formatToParts(date).forEach(p => { parts[p.type] = p.value; });
  if (parts.hour === '24') parts.hour = '00';
  return fmt.replace('yyyy', parts.year).replace('MM', parts.month).replace('dd', parts.day)
    .replace('HH', parts.hour).replace('mm', parts.minute).replace('ss', parts.second)
    .replace('EEE', parts.weekday);
}

function createGas(opts) {
  opts = opts || {};
  const props = Object.assign({}, opts.props || {});
  const cache = {};
  const spreadsheets = {};
  const http = { calls: [], nvidiaQueue: [], telegram: [] };
  let uuid = 0;

  const ctx = {
    console: { log: () => {}, error: () => {} },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (props.hasOwnProperty(k) ? props[k] : null),
        setProperty: (k, v) => { props[k] = String(v); }
      })
    },
    SpreadsheetApp: {
      openById: id => {
        if (!spreadsheets[id]) throw new Error('找不到試算表 ' + id);
        return spreadsheets[id];
      },
      create: name => {
        const id = 'sheet_' + Object.keys(spreadsheets).length;
        spreadsheets[id] = new Spreadsheet(id, name);
        return spreadsheets[id];
      }
    },
    CacheService: {
      getScriptCache: () => ({
        get: k => (cache.hasOwnProperty(k) ? cache[k] : null),
        put: (k, v) => { cache[k] = String(v); }
      })
    },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
    Utilities: {
      formatDate,
      getUuid: () => 'uuid-' + (++uuid) + '-0000-0000-000000000000',
      sleep: () => {}
    },
    UrlFetchApp: {
      fetch: (url, o) => {
        const payload = o && o.payload ? JSON.parse(o.payload) : null;
        http.calls.push({ url, payload });
        if (url.indexOf('integrate.api.nvidia.com') >= 0) {
          const next = http.nvidiaQueue.shift();
          if (!next) throw new Error('測試沒有預先排好 NVIDIA 回應（第 ' + http.calls.length + ' 次呼叫）');
          const r = typeof next === 'function' ? next(payload) : next;
          const code = r.code || 200;
          const body = r.body || { choices: [{ message: r.message, finish_reason: r.message && r.message.tool_calls ? 'tool_calls' : 'stop' }] };
          return { getResponseCode: () => code, getContentText: () => JSON.stringify(body) };
        }
        if (url.indexOf('api.telegram.org') >= 0) {
          const method = url.split('/').pop();
          http.telegram.push({ method, payload });
          return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: true, result: true }) };
        }
        throw new Error('未模擬的網址：' + url);
      }
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: s => ({ content: s, setMimeType() { return this; }, getContent() { return this.content; } })
    },
    HtmlService: {
      XFrameOptionsMode: { ALLOWALL: 'ALLOWALL' },
      createTemplateFromFile: file => {
        const tpl = { file };
        tpl.evaluate = () => {
          const out = { file, vars: Object.assign({}, tpl), title: '' };
          out.setTitle = t => { out.title = t; return out; };
          out.addMetaTag = () => out;
          out.setXFrameOptionsMode = () => out;
          return out;
        };
        return tpl;
      }
    },
    ScriptApp: { getProjectTriggers: () => [], deleteTrigger: () => {}, newTrigger: () => ({}) }
  };

  vm.createContext(ctx);
  // 照檔名順序載入全部 .gs（GAS 執行期是同一個全域命名空間，順序不影響 IIFE 以外的東西）
  const files = fs.readdirSync(ROOT).filter(f => f.endsWith('.gs')).sort();
  files.forEach(f => {
    let src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    vm.runInContext(src, ctx, { filename: f });
  });

  // 頂層 var 宣告在 vm context 上可直接取用
  ctx.__props = props;
  ctx.__cache = cache;
  ctx.__http = http;
  ctx.__spreadsheets = spreadsheets;
  return ctx;
}

module.exports = { createGas };
