/**
 * Conversation
 * @description 客人對話的儲存層 — sessions（每位客人一列）與 chat（每則訊息一列）
 *
 * session_id 帶通路前綴，同一套邏輯服務兩個入口：
 *   TG:<chat_id>    Telegram 客人
 *   WEB:<訪客 ID>   商店頁對話框的訪客（ID 由前端產生、存在 localStorage）
 *
 * mode 決定誰回覆：
 *   ai     AI 客服自動回覆（預設）
 *   human  已轉真人：AI 不再回覆，訊息只記錄並通知店家，等後台回覆
 */
var Conversation = (() => {
  var conv = {};

  conv.channelOf = (sessionId) => String(sessionId).indexOf('TG:') === 0 ? 'telegram' : 'webchat';

  conv.getSession = (sessionId) => DB.first('sessions', s => String(s.session_id) === String(sessionId));

  /** 取得或建立 session；display_name 有新值就順手更新 */
  conv.ensureSession = (sessionId, displayName) => {
    var s = conv.getSession(sessionId);
    var now = Utils.now();
    if (!s) {
      DB.insert('sessions', {
        session_id: sessionId, channel: conv.channelOf(sessionId),
        display_name: displayName || '', mode: 'ai',
        created_at: now, last_message_at: now, unread: 0
      });
      return conv.getSession(sessionId);
    }
    if (displayName && displayName !== s.display_name) DB.update('sessions', s, { display_name: displayName });
    return s;
  };

  conv.setMode = (sessionId, mode) => {
    var s = conv.getSession(sessionId);
    if (!s) return { ok: false, error: '查無此對話' };
    DB.update('sessions', s, { mode: mode === 'human' ? 'human' : 'ai' });
    return { ok: true };
  };

  /**
   * 寫入一則訊息
   * @param {string} role - user | assistant | staff | system
   */
  conv.append = (sessionId, role, content, traceId) => {
    var now = Utils.now();
    DB.insert('chat', { timestamp: now, session_id: sessionId, role: role, content: String(content), trace_id: traceId || '' });
    var s = conv.getSession(sessionId);
    if (s) {
      var changes = { last_message_at: now };
      if (role === 'user') changes.unread = Number(s.unread || 0) + 1;
      DB.update('sessions', s, changes);
    }
  };

  conv.markRead = (sessionId) => {
    var s = conv.getSession(sessionId);
    if (s && Number(s.unread) !== 0) DB.update('sessions', s, { unread: 0 });
  };

  /**
   * 取得某位客人的訊息（舊 → 新）。
   * 先只讀 chat 最後 2000 列再過濾：chat 只增不減，整張讀會越來越慢。
   */
  conv.messages = (sessionId, limit) => {
    var rows = DB.tail('chat', 2000).filter(r => String(r.session_id) === String(sessionId));
    if (limit) rows = rows.slice(-limit);
    return rows.map(r => ({ timestamp: String(r.timestamp), role: String(r.role), content: String(r.content), trace_id: String(r.trace_id || '') }));
  };

  /** 給 LLM 的歷史：只取 user / assistant / staff，staff 以 assistant 身分出現 */
  conv.historyForLLM = (sessionId) =>
    conv.messages(sessionId, Config.CHAT_HISTORY_TURNS)
      .filter(m => m.role === 'user' || m.role === 'assistant' || m.role === 'staff')
      .map(m => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.role === 'staff' ? '（真人客服）' + m.content : m.content
      }));

  /** 後台列表：依最後訊息時間新 → 舊 */
  conv.listSessions = () => {
    var lastMsg = {};
    DB.tail('chat', 2000).forEach(r => {
      if (r.role === 'user' || r.role === 'assistant' || r.role === 'staff') lastMsg[r.session_id] = String(r.content);
    });
    return DB.all('sessions').map(s => ({
      session_id: String(s.session_id), channel: String(s.channel),
      display_name: String(s.display_name || ''), mode: String(s.mode || 'ai'),
      last_message_at: String(s.last_message_at), unread: Number(s.unread || 0),
      preview: (lastMsg[s.session_id] || '').slice(0, 60)
    })).sort((a, b) => a.last_message_at < b.last_message_at ? 1 : -1);
  };

  return conv;
})();
