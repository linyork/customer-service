/**
 * Logger
 * @description 統一日誌門面，寫進 console.log 分頁；寫不進去時退回 GAS 執行紀錄
 */
var Logger = (() => {
  // 例外的 message / stack 是不可列舉屬性，直接 JSON.stringify 只會得到 {}
  var _detail = (d) => {
    if (d === undefined || d === null) return '';
    if (typeof d !== 'object') return String(d);
    if (typeof d.message === 'string' && (typeof d.stack === 'string' || d instanceof Error)) {
      return JSON.stringify({
        name:    String(d.name || 'Error'),
        message: String(d.message),
        stack:   String(d.stack || '').split('\n').slice(0, 4).join(' | ')
      });
    }
    var s = JSON.stringify(d);
    return (s === '{}' && String(d) !== '[object Object]') ? String(d) : s;
  };

  var log = (level, tag, message, details) => {
    var detail = '';
    try {
      detail = _detail(details);
      if (detail.length > 2000) detail = detail.slice(0, 2000) + '…';
      DB.appendRow('console.log', [Utils.now(), level, tag, String(message), detail]);
    } catch (e) {
      // 日誌本身不能炸掉主流程
      try { console.log('[log 寫入失敗] ' + level + ' ' + tag + ' ' + message + ' ' + detail); } catch (e2) {}
    }
  };

  return {
    info:    (tag, message, details) => log('INFO',    tag, message, details),
    warning: (tag, message, details) => log('WARNING', tag, message, details),
    error:   (tag, message, details) => log('ERROR',   tag, message, details),
    ai:      (tag, message, details) => { if (Config.DEBUG_MODE) log('AI', tag, message, details); }
  };
})();
