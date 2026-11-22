/**
 * DevTools
 * @description 手動執行入口 — 在 Apps Script 編輯器的函式下拉選單裡執行
 *
 * 編輯器的下拉選單是扁平的、看不出函式來自哪個檔案，所以「只給人手動執行」的
 * 函式（建表、灌資料、註冊 webhook、診斷）全部集中在這裡，保持薄薄一層去呼叫模組。
 *
 * ⚠️ 不要把這兩類函式搬來這裡（它們靠名字被呼叫，改名或搬走會靜默失效）：
 *   - Web 入口：doGet、doPost、webApi
 *   - 觸發器：dailyCleanUp
 *
 * 首次設定順序：
 *   1. setupSheets()          建立試算表與所有分頁（沒有 SHEET_ID 會自動建一份新的）
 *   2. seedSampleData()       灌入範例書籍與 FAQ（會清空 products / faq）
 *   3. 手動設定 Script Properties：TELEGRAM_API_KEY、NVIDIA_API_KEY、ADMIN_PASSWORD
 *   4. setupTelegramWebhook() 把 bot 指到這個部署
 *   5. setupTriggers()        安裝每日清理排程
 *   6. checkConfig()          確認全部到位
 */

/** 建立（或補齊）試算表與所有分頁；已存在的分頁只補表頭，不動資料 */
function setupSheets() {
  var props = PropertiesService.getScriptProperties();
  var ss;
  if (props.getProperty('SHEET_ID')) {
    ss = SpreadsheetApp.openById(props.getProperty('SHEET_ID'));
  } else {
    ss = SpreadsheetApp.create(Config.SHOP_NAME + '｜AI 客服資料庫');
    props.setProperty('SHEET_ID', ss.getId());
    console.log('已建立新試算表並寫入 SHEET_ID：' + ss.getUrl());
  }

  Object.keys(DB.SCHEMA).forEach(name => {
    var cols = DB.SCHEMA[name];
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold').setBackground('#f3ead9');
    sh.setFrozenRows(1);
  });

  // 新試算表自帶的空白「工作表1」刪掉
  ss.getSheets().forEach(sh => {
    if (!DB.SCHEMA[sh.getName()] && sh.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(sh);
  });

  // 電話與訂單編號存成文字，避免開頭的 0 被吃掉
  ss.getSheetByName('orders').getRange('A:A').setNumberFormat('@');
  ss.getSheetByName('orders').getRange('F:F').setNumberFormat('@');
  ss.getSheetByName('order_items').getRange('A:B').setNumberFormat('@');
  ss.getSheetByName('products').getRange('A:A').setNumberFormat('@');
  ss.getSheetByName('sessions').getRange('A:A').setNumberFormat('@');
  ss.getSheetByName('chat').getRange('B:B').setNumberFormat('@');

  console.log('分頁就緒：' + Object.keys(DB.SCHEMA).join(', '));
  console.log('試算表：' + ss.getUrl());
}

/** 灌入範例資料（會清空 products 與 faq 再寫入） */
function seedSampleData() {
  var data = SampleData;
  ['products', 'faq'].forEach(name => {
    var sh = DB.sheet(name);
    if (sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1);
  });
  DB.insertMany('products', data.products);
  DB.insertMany('faq', data.faq);
  console.log('已寫入 ' + data.products.length + ' 本書、' + data.faq.length + ' 則 FAQ');
}

/** 把 Telegram bot 的 webhook 指到正式部署（/exec）並註冊指令選單 */
function setupTelegramWebhook() {
  console.log('註冊 webhook → ' + Config.WEB_APP_URL);
  console.log(JSON.stringify(Telegram.setWebhook(Config.WEB_APP_URL)));
  console.log(JSON.stringify(Telegram.setCommands()));
}

/** 看 Telegram 那邊記錄的 webhook 狀態（最後一次錯誤、積壓數量） */
function checkTelegramWebhook() {
  console.log(JSON.stringify(Telegram.getWebhookInfo(), null, 2));
}

/** 安裝排程（會先清掉本專案所有觸發器再重建） */
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('dailyCleanUp').timeBased().atHour(4).everyDays(1).create();
  console.log('已安裝：dailyCleanUp 每天 04:00');
}

/** 檢查設定是否齊全 */
function checkConfig() {
  var props = PropertiesService.getScriptProperties();
  var required = ['SHEET_ID', 'TELEGRAM_API_KEY', 'NVIDIA_API_KEY', 'ADMIN_PASSWORD'];
  var optional = ['ADMIN_CHAT_ID', 'DEBUG_MODE'];
  required.forEach(k => console.log((props.getProperty(k) ? '✅ ' : '❌ ') + k));
  optional.forEach(k => console.log((props.getProperty(k) ? '✅ ' : '➖ ') + k + '（選填）'));
  console.log('部署網址：' + Config.WEB_APP_URL);
  console.log('商店頁：' + Config.WEB_APP_URL);
  console.log('後台：' + Config.WEB_APP_URL + '?page=admin');
  try {
    Object.keys(DB.SCHEMA).forEach(n => DB.sheet(n));
    console.log('✅ 所有分頁存在，商品 ' + Store.listProducts(true).length + ' 筆');
  } catch (e) {
    console.log('❌ ' + e.message);
  }
}

/** 實打一次 NVIDIA：純文字 + 帶工具各一次，確認金鑰與模型可用 */
function testNvidia() {
  var r1 = NvidiaService.chat([{ role: 'user', content: '用一句繁體中文自我介紹' }], {});
  console.log('純文字：' + JSON.stringify(r1 && r1.message));
  var r2 = NvidiaService.chat([
    { role: 'system', content: Prompt.system() },
    { role: 'user', content: '有沒有推理小說？' }
  ], { tools: Tools.definitions() });
  console.log('帶工具：' + JSON.stringify(r2 && r2.message));
}

/** 從編輯器模擬一位網頁訪客跟 AI 客服對話 */
function testChat() {
  var reply = ChatBot.reply('WEB:devtools', '你好，有推薦的散文嗎？', '開發者測試');
  console.log(reply);
}

/** 列出本專案的觸發器 */
function listTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => console.log(t.getHandlerFunction() + ' / ' + t.getEventType()));
}
