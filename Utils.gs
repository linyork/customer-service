/**
 * Utils
 * @description 通用工具函式
 */
var Utils = (() => {
  var utils = {};

  // ─── 執行時間預算 ─────────────────────────────────────────────
  // GAS 單次執行上限 6 分鐘，超過直接被砍且攔不到。時間戳在檔案載入時取得，
  // 等同本次執行的起點（GAS 每次執行都會重載全部 .gs）。
  var EXEC_START = Date.now();
  utils.EXEC_LIMIT_MS  = 360000;
  utils.execElapsedMs  = () => Date.now() - EXEC_START;
  utils.execTimeLeftMs = () => utils.EXEC_LIMIT_MS - utils.execElapsedMs();

  utils.now = () => Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy/MM/dd HH:mm:ss');
  utils.today = () => Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd');

  utils.parseJson = (str) => {
    if (typeof str !== 'string') return null;
    try { return JSON.parse(str); } catch (e) { return null; }
  };

  /** 產生訂單編號：BK + 日期 + 4 碼亂數，例如 BK202611220417 */
  utils.newOrderId = () => 'BK' + utils.today() + ('0000' + Math.floor(Math.random() * 10000)).slice(-4);

  /** 產生網頁訪客 ID（前端也會自己產，這裡是後端的保底） */
  utils.newId = (prefix) => (prefix || '') + Utilities.getUuid().replace(/-/g, '').slice(0, 12);

  /** 電話正規化：只留數字，方便比對 */
  utils.normalizePhone = (s) => String(s || '').replace(/\D/g, '');

  /** 移除 Markdown 符號：Telegram 以純文字送出，** 與 # 會原樣出現 */
  utils.stripMarkdown = (str) => String(str || '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '・')
    .trim();

  /** 長訊息切段（Telegram 單則上限 4096 字） */
  utils.splitText = (str, limit) => {
    var parts = [];
    var s = String(str || '');
    while (s.length > limit) {
      var cut = s.lastIndexOf('\n', limit);
      if (cut < limit * 0.5) cut = limit;
      parts.push(s.slice(0, cut));
      s = s.slice(cut).replace(/^\n/, '');
    }
    if (s) parts.push(s);
    return parts;
  };

  utils.money = (n) => 'NT$' + Number(n || 0).toLocaleString('en-US');

  /**
   * 頻率限制：回傳 true 代表放行。用 CacheService 計數，視窗到期自動歸零。
   * @param {string} key - 客人識別（sessionId）
   */
  utils.rateLimitOk = (key) => {
    var cache = CacheService.getScriptCache();
    var k = 'rl_' + key;
    var n = Number(cache.get(k) || 0) + 1;
    cache.put(k, String(n), Config.RATE_WINDOW_SEC);
    return n <= Config.RATE_MAX_MSGS;
  };

  return utils;
})();
