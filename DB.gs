/**
 * DB
 * @description Google Sheet 資料存取層 — 每個分頁當一張表，第一列是欄位名稱
 *
 * 分頁結構集中定義在 SCHEMA：DevTools.setupSheets() 依此建表，讀寫也依此對欄位。
 * 業務層（Store / Chat）只透過這裡讀寫，不直接碰 SpreadsheetApp。
 */
var DB = (() => {
  var db = {};

  db.SCHEMA = {
    'products':    ['id', 'title', 'author', 'category', 'price', 'stock', 'description', 'color', 'active'],
    'orders':      ['order_id', 'created_at', 'channel', 'session_id', 'customer_name', 'phone', 'address',
                    'payment', 'subtotal', 'shipping', 'total', 'status', 'note', 'updated_at'],
    'order_items': ['order_id', 'product_id', 'title', 'price', 'qty', 'amount'],
    'sessions':    ['session_id', 'channel', 'display_name', 'mode', 'created_at', 'last_message_at', 'unread'],
    'chat':        ['timestamp', 'session_id', 'role', 'content'],
    'faq':         ['question', 'answer'],
    'console.log': ['timestamp', 'level', 'tag', 'message', 'detail']
  };

  // 訂單狀態流轉（後台下拉選單與工具共用）
  db.ORDER_STATUS = ['待付款', '待出貨', '已出貨', '已完成', '已取消'];

  var _ss = null;
  db.open = () => {
    if (_ss) return _ss;
    if (!Config.SHEET_ID) throw new Error('尚未設定 Script Property SHEET_ID，請先執行 DevTools 的 setupSheets()');
    _ss = SpreadsheetApp.openById(Config.SHEET_ID);
    return _ss;
  };

  db.sheet = (name) => {
    var sh = db.open().getSheetByName(name);
    if (!sh) throw new Error('找不到分頁「' + name + '」，請執行 DevTools 的 setupSheets()');
    return sh;
  };

  /** 讀整張表 → 物件陣列，每筆帶 _row（試算表列號，更新時用） */
  db.all = (name) => {
    var sh = db.sheet(name);
    var last = sh.getLastRow();
    if (last < 2) return [];
    var cols = db.SCHEMA[name];
    var values = sh.getRange(2, 1, last - 1, cols.length).getValues();
    return values.map((r, i) => {
      var o = { _row: i + 2 };
      cols.forEach((c, j) => { o[c] = r[j]; });
      return o;
    });
  };

  /** 只讀最後 n 列（chat / log 這種只增不減的表用，避免整張讀） */
  db.tail = (name, n) => {
    var sh = db.sheet(name);
    var last = sh.getLastRow();
    if (last < 2) return [];
    var start = Math.max(2, last - n + 1);
    var cols = db.SCHEMA[name];
    var values = sh.getRange(start, 1, last - start + 1, cols.length).getValues();
    return values.map((r, i) => {
      var o = { _row: start + i };
      cols.forEach((c, j) => { o[c] = r[j]; });
      return o;
    });
  };

  db.find = (name, predicate) => db.all(name).filter(predicate);
  db.first = (name, predicate) => db.all(name).find(predicate) || null;

  /** 新增一列（物件 → 依 SCHEMA 欄位順序） */
  db.insert = (name, obj) => {
    var cols = db.SCHEMA[name];
    db.sheet(name).appendRow(cols.map(c => obj[c] === undefined ? '' : obj[c]));
  };

  /** 批次新增多列（一次 API 呼叫） */
  db.insertMany = (name, objs) => {
    if (!objs.length) return;
    var cols = db.SCHEMA[name];
    var sh = db.sheet(name);
    var rows = objs.map(o => cols.map(c => o[c] === undefined ? '' : o[c]));
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, cols.length).setValues(rows);
  };

  /** 給 Logger 用的原始寫入，不經 SCHEMA */
  db.appendRow = (name, row) => {
    var sh = db.open().getSheetByName(name);
    if (!sh) return false;
    sh.appendRow(row);
    return true;
  };

  /** 更新某列的部分欄位（record 必須帶 _row） */
  db.update = (name, record, changes) => {
    var cols = db.SCHEMA[name];
    var sh = db.sheet(name);
    var row = cols.map(c => changes.hasOwnProperty(c) ? changes[c] : record[c]);
    sh.getRange(record._row, 1, 1, cols.length).setValues([row]);
    Object.keys(changes).forEach(k => { record[k] = changes[k]; });
    return record;
  };

  /** 刪除時間欄早於 cutoff 的列（只增不減的表，過期列一定在開頭連續一段） */
  db.purgeBefore = (name, col, cutoff) => {
    var rows = db.all(name);
    var n = 0;
    for (var i = 0; i < rows.length; i++) {
      var t = new Date(String(rows[i][col]).replace(/\//g, '-').replace(' ', 'T') + '+08:00');
      if (isNaN(t.getTime()) || t >= cutoff) break;
      n++;
    }
    if (n > 0) db.sheet(name).deleteRows(2, n);
    return n;
  };

  /** 以 LockService 包住「讀 → 改 → 寫」，避免兩張訂單同時扣同一本書的庫存 */
  db.withLock = (fn) => {
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try { return fn(); } finally { lock.releaseLock(); }
  };

  return db;
})();
