/**
 * Notify
 * @description 店家通知 — 推到 ADMIN_CHAT_ID（Telegram）
 *
 * ADMIN_CHAT_ID 沒設就安靜跳過：通知是加分項，不能因為它擋住下單或轉真人。
 * 店員在 bot 輸入「/admin <後台密碼>」即可把該聊天室綁成通知對象。
 *
 * 所有通知都以【店家通知】開頭：通知頻道也可能同時是客人的聊天室（demo 時常見），
 * 不標示的話分不出哪則是給店家看的。
 */
var Notify = (() => {
  var notify = {};
  var PREFIX = '【店家通知】';

  var push = (text) => {
    var chatId = Config.ADMIN_CHAT_ID;
    if (!chatId || !Config.TELEGRAM_API_KEY) return false;
    try { Telegram.send(chatId, PREFIX + text); return true; }
    catch (ex) { Logger.error('Notify', '通知店家失敗', ex); return false; }
  };

  /** 這位客人是不是就是通知頻道本人（自己對自己的通知沒有意義） */
  var isAdminChat = (sessionId) => !!Config.ADMIN_CHAT_ID && String(sessionId) === 'TG:' + Config.ADMIN_CHAT_ID;

  notify.newOrder = (order) => {
    if (!order) return false;
    return push('🛒 新訂單（' + order.channel + '）\n' + Store.formatOrder(order) +
      '\n收件人：' + order.customer_name + ' ' + order.phone + '\n地址：' + order.address);
  };

  notify.handoff = (sessionId, displayName, reason) =>
    push('🙋 客人要求真人客服\n客人：' + (displayName || sessionId) + '\n原因：' + (reason || '（未說明）') +
      '\n請到後台回覆：' + Config.WEB_APP_URL + '?page=admin');

  /** 真人模式下客人傳來的訊息；客人就是通知頻道本人時不轉（否則會看到自己的話被重複一次） */
  notify.humanMessage = (sessionId, displayName, text) => {
    if (isAdminChat(sessionId)) return false;
    return push('💬 ' + (displayName || sessionId) + '（真人模式）：\n' + text);
  };

  return notify;
})();
