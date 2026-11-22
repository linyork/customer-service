/**
 * ChatBot
 * @description 客服對話主流程 — 與通路無關（Telegram 與網頁對話框共用）
 *
 * handle(sessionId, text, displayName) 是唯一入口，回傳要送給客人的文字（null 代表不回）：
 *   1. 斜線指令（/start /books /orders /human /ai）直接處理，不花 LLM 配額
 *   2. 真人模式：只記錄、通知店家，AI 不回
 *   3. AI 模式：ReAct 迴圈（模型 → 工具 → 模型 …），最後一輪不帶工具逼它收斂成文字
 */
var ChatBot = (() => {
  var bot = {};

  var FALLBACK_REPLY = '不好意思，系統忙碌中，請稍後再試一次 🙏 或輸入 /human 轉接真人客服。';
  var TURN_RESERVE_MS = 60000; // 剩不到 60 秒就不再開新一輪（要留時間給備援與回覆）

  /** 斜線指令；不是指令回 null */
  bot.command = (sessionId, text) => {
    var cmd = String(text || '').trim().split(/\s+/)[0].toLowerCase().replace(/@.*$/, '');
    switch (cmd) {
      case '/start':
        return '您好，歡迎光臨' + Config.SHOP_NAME + ' 📚\n我是 AI 客服小拾，可以幫您：\n' +
          '・找書、推薦、查價格庫存\n・直接在這裡下單\n・查詢或取消訂單\n\n' +
          '直接打字問我就可以囉！也可以逛逛網路商店：' + Config.WEB_APP_URL;
      case '/books': {
        var list = Store.listProducts(false);
        return '目前在售書籍：\n' + list.map(p =>
          p.id + '《' + p.title + '》' + p.author + '　' + Utils.money(p.price) + (p.stock > 0 ? '' : '（缺貨）')
        ).join('\n') + '\n\n想了解哪一本，直接告訴我書名或編號～';
      }
      case '/orders': {
        var orders = Store.listOrdersBySession(sessionId);
        if (!orders.length) return '這個聊天室還沒有訂單喔。若是在網頁下的單，請提供訂單編號與電話，我幫您查。';
        return orders.slice(0, 5).map(Store.formatOrder).join('\n\n');
      }
      case '/human':
        Conversation.setMode(sessionId, 'human');
        Notify.handoff(sessionId, (Conversation.getSession(sessionId) || {}).display_name, '客人輸入 /human');
        return '已為您轉接真人客服 🙋 店員會在服務時間（週一至週五 10:00–18:00）盡快回覆。\n想改回 AI 客服請輸入 /ai';
      case '/ai':
        Conversation.setMode(sessionId, 'ai');
        return '已切換回 AI 客服小拾，有什麼可以幫您的嗎？';
      default:
        return null;
    }
  };

  /**
   * 處理一則客人訊息（指令、真人模式、AI 回覆都在這裡分流）
   * @returns {string|null} 要回給客人的文字
   */
  bot.handle = (sessionId, text, displayName) => {
    text = String(text || '').trim();
    if (!text) return null;
    var session = Conversation.ensureSession(sessionId, displayName);

    if (!Utils.rateLimitOk(sessionId)) {
      Logger.warning('ChatBot', '觸發頻率限制', sessionId);
      return '訊息有點多，請稍等幾分鐘再試 🙏';
    }

    Conversation.append(sessionId, 'user', text);

    var cmdReply = bot.command(sessionId, text);
    if (cmdReply !== null) {
      Conversation.append(sessionId, 'system', cmdReply);
      return cmdReply;
    }

    if (String(session.mode) === 'human') {
      Notify.humanMessage(sessionId, session.display_name, text);
      return null;
    }

    var r = bot.run(sessionId, text, session.display_name);
    Conversation.append(sessionId, 'assistant', r.text, r.traceId);
    return r.text;
  };

  /** 只要回覆文字（DevTools.testChat 用）；一樣會留 AI 追蹤紀錄 */
  bot.reply = (sessionId, text, displayName) => bot.run(sessionId, text, displayName).text;

  /**
   * ReAct 迴圈（不寫 chat，只負責產生回覆），每一步都記進 AiTrace
   * @returns {{text:string, traceId:string}}
   */
  bot.run = (sessionId, text, displayName) => {
    var ctx = { sessionId: sessionId, channel: Conversation.channelOf(sessionId), displayName: displayName || '' };
    var trace = AiTrace.start(ctx, text);
    var done = (out, status) => ({ text: out, traceId: AiTrace.finish(trace, out, status) });

    var history = Conversation.historyForLLM(sessionId);
    // handle() 已經把這則 user 訊息寫進 chat；歷史最後一則若就是它，不要重複
    var last = history[history.length - 1];
    if (last && last.role === 'user' && last.content === text) history.pop();

    var systemPrompt = Prompt.system(ctx.channel);
    var messages = [{ role: 'system', content: systemPrompt }]
      .concat(history)
      .concat([{ role: 'user', content: text }]);

    var toolDefs = Tools.definitions();
    AiTrace.input(trace, { systemPrompt: systemPrompt, history: history, toolNames: toolDefs.map(t => t.function.name) });

    for (var turn = 1; turn <= Config.TOOL_MAX_ITERATIONS; turn++) {
      if (Utils.execTimeLeftMs() < TURN_RESERVE_MS) {
        Logger.warning('ChatBot', '時間預算不足，停止第 ' + turn + ' 輪');
        AiTrace.note(trace, '執行時間預算不足，第 ' + turn + ' 輪前停止');
        break;
      }
      var isLast = turn === Config.TOOL_MAX_ITERATIONS;
      var attempts = [];
      var t0 = Date.now();
      var opts = isLast ? {} : { tools: toolDefs };
      opts.trace = attempts;
      var res = NvidiaService.chat(messages, opts);
      AiTrace.llm(trace, turn, !isLast, attempts, res, Date.now() - t0);
      if (!res) break;

      var msg = res.message;
      var calls = msg.tool_calls || [];

      if (!calls.length) {
        var out = Utils.stripMarkdown(msg.content || '');
        return out ? done(out, 'ok') : done(FALLBACK_REPLY, 'fallback');
      }

      messages.push({ role: 'assistant', content: msg.content || null, tool_calls: calls });
      calls.forEach(call => {
        var args = Utils.parseJson(call.function && call.function.arguments) || {};
        var name = call.function && call.function.name;
        var t1 = Date.now();
        var result = Tools.execute(name, args, ctx);
        AiTrace.tool(trace, name, args, result, Date.now() - t1);
        Logger.info('ChatBot.tool', name, { args: args, ok: result.ok });
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      });
    }

    Logger.error('ChatBot', '無法產生回覆', sessionId);
    return done(FALLBACK_REPLY, 'fallback');
  };

  return bot;
})();
