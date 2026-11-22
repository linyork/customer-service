/**
 * Telegram
 * @description Telegram Bot API 介面
 *
 * GAS 的 doPost(e) 讀不到 HTTP header，無法驗證 Telegram 的 secret token。
 * 客服 bot 本來就對所有人開放，所以這裡不做允許清單；防濫用靠 Utils.rateLimitOk。
 */
var Telegram = (() => {
  var tg = {};
  var TG_LIMIT = 4000;

  var call = (method, payload) => {
    try {
      var res = UrlFetchApp.fetch(Config.TELEGRAM_API_BASE + '/' + method, {
        method: 'post',
        contentType: 'application/json; charset=UTF-8',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
      var body = Utils.parseJson(res.getContentText()) || {};
      if (!body.ok) Logger.warning('Telegram.' + method, '呼叫失敗', res.getContentText().slice(0, 300));
      return body;
    } catch (ex) {
      Logger.error('Telegram.' + method, '呼叫例外', ex);
      return { ok: false };
    }
  };

  /** 判斷 POST 內容是不是 Telegram update（有 update_id 就是） */
  tg.isUpdate = (body) => !!(body && typeof body === 'object' && body.hasOwnProperty('update_id'));

  /**
   * Telegram update → 中立事件；不是文字訊息就回 null
   * @returns {{eventId, chatId, sessionId, displayName, text}|null}
   */
  tg.normalize = (update) => {
    var msg = update.message || update.edited_message;
    if (!msg || !msg.chat || typeof msg.text !== 'string') return null;
    var from = msg.from || {};
    var name = [from.first_name, from.last_name].filter(x => x).join(' ') || from.username || '';
    return {
      eventId:     'tg_' + update.update_id,
      chatId:      String(msg.chat.id),
      sessionId:   'TG:' + msg.chat.id,
      displayName: name,
      text:        msg.text
    };
  };

  tg.send = (chatId, text) => {
    Utils.splitText(Utils.stripMarkdown(text), TG_LIMIT).forEach(part => {
      call('sendMessage', { chat_id: chatId, text: part });
    });
  };

  tg.typing = (chatId) => call('sendChatAction', { chat_id: chatId, action: 'typing' });

  tg.setWebhook = (url) => call('setWebhook', {
    url: url,
    allowed_updates: ['message'],
    drop_pending_updates: true,
    // 一次只投遞一則，收到回應才送下一則 —— 避免併發搶去重快取
    max_connections: 1
  });

  tg.getWebhookInfo = () => call('getWebhookInfo', {});

  /**
   * Bot 的 username（商店頁 footer 的 QR code 用）。
   * 第一次呼叫 getMe 後存進 Script Property BOT_USERNAME，之後不再打 API；
   * 換 bot（換 TELEGRAM_API_KEY）時刪掉這個屬性即可重新抓。
   * @returns {string} 例如 'shiye_books_bot'；取不到回空字串
   */
  tg.botUsername = () => {
    var props = PropertiesService.getScriptProperties();
    var cached = props.getProperty('BOT_USERNAME');
    if (cached) return cached;
    if (!Config.TELEGRAM_API_KEY) return '';
    var me = call('getMe', {});
    var name = me && me.ok && me.result && me.result.username;
    if (!name) return '';
    props.setProperty('BOT_USERNAME', name);
    return name;
  };

  tg.setCommands = () => call('setMyCommands', {
    commands: [
      { command: 'start',  description: '開始使用 / 看看能做什麼' },
      { command: 'books',  description: '看看有哪些書' },
      { command: 'orders', description: '查詢我的訂單' },
      { command: 'human',  description: '轉接真人客服' },
      { command: 'ai',     description: '改回 AI 客服' }
    ]
  });

  return tg;
})();
