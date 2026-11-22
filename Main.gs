/**
 * Main
 * @description Web App 入口 — doGet（頁面）、doPost（Telegram webhook ＋ 網頁 API）
 *
 * 一個部署、一個 /exec 網址，三種流量：
 *   GET  /exec              → 商店頁（ShopPage.html）
 *   GET  /exec?page=admin   → 後台（AdminPage.html，進去後要輸入密碼）
 *   POST /exec  body 有 update_id        → Telegram webhook
 *   POST /exec  body 有 source:'web'     → 商店頁／後台的 API（WebApi.handle）
 *
 * 網頁的 POST 用 fetch + Content-Type: text/plain 送（不觸發 CORS preflight，
 * GAS 回 302 轉到 googleusercontent 的 echo 網址，瀏覽器自動跟過去拿 JSON）。
 * 萬一瀏覽器擋了 fetch，前端會改走 google.script.run 呼叫 webApi()，兩條路進同一個 WebApi.handle。
 */

function doGet(e) {
  var page = (e && e.parameter && e.parameter.page) || 'shop';
  var file = page === 'admin' ? 'AdminPage' : 'ShopPage';
  var t = HtmlService.createTemplateFromFile(file);
  t.apiUrl = Config.WEB_APP_URL;
  t.shopName = Config.SHOP_NAME;
  t.slogan = Config.SHOP_SLOGAN;
  t.shippingFee = Config.SHIPPING_FEE;
  t.freeShipping = Config.FREE_SHIPPING_THRESHOLD;
  // footer 的 Telegram QR code；取不到 bot 名稱時頁面會隱藏那一區，不影響商店
  var bot = '';
  try { bot = page === 'admin' ? '' : Telegram.botUsername(); } catch (ex) { Logger.error('doGet', '取得 bot 名稱失敗', ex); }
  t.botUsername = bot;
  return t.evaluate()
    .setTitle(page === 'admin' ? Config.SHOP_NAME + '｜後台' : Config.SHOP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doPost(e) {
  var body = Utils.parseJson(e && e.postData && e.postData.contents);

  if (Telegram.isUpdate(body)) {
    handleTelegramUpdate_(body);
    // ⚠️ 不可回 ContentService：/exec 會把它包成 302 轉址，Telegram 不跟轉址、
    //    當成失敗一直重送（max_connections=1 時還會卡住後面所有訊息）。
    //    什麼都不回，GAS 直接給 200，Telegram 才會認定送達。（2026/11/22 實測踩到）
    return;
  }

  if (body && body.source === 'web') {
    return ContentService.createTextOutput(JSON.stringify(WebApi.handle(body)))
      .setMimeType(ContentService.MimeType.JSON);
  }

  Logger.info('doPost', '無法辨識的 POST，忽略', String(e && e.postData && e.postData.contents).slice(0, 200));
  return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'unknown request' }))
    .setMimeType(ContentService.MimeType.JSON);
}

/** google.script.run 的入口（fetch 失敗時的備援路徑） */
function webApi(body) {
  body = body || {};
  body.source = 'web';
  return WebApi.handle(body);
}

/** 處理一則 Telegram update（拆出來方便測試） */
function handleTelegramUpdate_(update) {
  try {
    var ev = Telegram.normalize(update);
    if (!ev) return;

    // 去重：GAS 回應慢時 Telegram 會重送同一則 update；CacheService 上限 6 小時
    var cache = CacheService.getScriptCache();
    if (cache.get(ev.eventId)) {
      Logger.info('doPost', '忽略重複的 update', ev.eventId);
      return;
    }
    cache.put(ev.eventId, '1', 21600);

    // /admin <密碼>：把這個聊天室綁成店家通知對象（不進客服對話紀錄）
    var m = ev.text.trim().match(/^\/admin(?:@\S+)?\s+(.+)$/);
    if (m) {
      if (Config.ADMIN_PASSWORD && m[1].trim() === Config.ADMIN_PASSWORD) {
        PropertiesService.getScriptProperties().setProperty('ADMIN_CHAT_ID', ev.chatId);
        Telegram.send(ev.chatId, '✅ 已將此聊天室設為店家通知頻道，新訂單與轉真人請求會推送到這裡。');
        Logger.info('doPost', '綁定店家通知頻道', ev.chatId);
      } else {
        Telegram.send(ev.chatId, '密碼錯誤。');
        Logger.warning('doPost', '/admin 密碼錯誤', ev.chatId);
      }
      return;
    }

    Telegram.typing(ev.chatId);
    var reply = ChatBot.handle(ev.sessionId, ev.text, ev.displayName);
    if (reply) Telegram.send(ev.chatId, reply);
  } catch (ex) {
    Logger.error('doPost', 'Telegram 處理失敗', ex);
  }
}

/** 每日清理（觸發器，DevTools.setupTriggers 安裝；名字不可改） */
function dailyCleanUp() {
  try {
    var day = 24 * 3600 * 1000;
    var chatN = DB.purgeBefore('chat', 'timestamp', new Date(Date.now() - Config.CHAT_CLEANUP_DAYS * day));
    var logN = DB.purgeBefore('console.log', 'timestamp', new Date(Date.now() - Config.LOG_CLEANUP_DAYS * day));
    var traceN = DB.purgeBefore('ai_trace', 'timestamp', new Date(Date.now() - Config.TRACE_CLEANUP_DAYS * day));
    Logger.info('dailyCleanUp', '清除 chat ' + chatN + ' 筆、log ' + logN + ' 筆、AI 追蹤 ' + traceN + ' 筆');
  } catch (ex) {
    Logger.error('dailyCleanUp', '清理失敗', ex);
  }
}
