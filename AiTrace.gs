/**
 * AiTrace
 * @description AI 回覆的可查驗紀錄（後台「AI 追蹤」分頁）
 *
 * 每一次 AI 回覆客人，都留一筆 trace，寫進 ai_trace 分頁：
 *   - 模型看到什麼：帶入幾則歷史、system prompt 多長、提供了哪些工具
 *   - 每一輪 LLM：用哪個模型、花多久、token 用量、有沒有重試或改用備援、決定叫哪個工具
 *   - 每一次工具：參數、結果、成功與否、耗時
 *   - 最後回給客人的文字與狀態（ok／fallback）
 * chat 分頁的 AI 訊息帶 trace_id，後台對話可以一鍵跳到這次的推理過程。
 *
 * 紀錄本身不能影響客服：寫入失敗只記 log，不丟例外。
 */
var AiTrace = (() => {
  var tr = {};

  var MAX_STEPS_CHARS = 45000; // Sheet 單一儲存格上限 50,000 字
  var clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…（截斷）' : s; };

  /** 開始一筆 trace（ChatBot.run 一開始呼叫） */
  tr.start = (ctx, userText) => ({
    trace_id: Utils.newId('T'),
    timestamp: Utils.now(),
    session_id: ctx.sessionId,
    channel: ctx.channel,
    user_text: userText,
    started: Date.now(),
    steps: [],
    llmCalls: 0, tokensIn: 0, tokensOut: 0, tools: [], models: []
  });

  /** 記下這次送給模型的輸入概況 */
  tr.input = (trace, info) => {
    trace.steps.push({
      type: 'input',
      system_prompt_chars: info.systemPrompt.length,
      history: info.history.map(m => ({ role: m.role, content: clip(m.content, 300) })),
      tools: info.toolNames
    });
  };

  /**
   * 一輪 LLM 呼叫
   * @param {Array} attempts - NvidiaService 回報的每次 HTTP 嘗試（含重試與備援）
   * @param {object|null} res - NvidiaService.chat 的結果；null 代表這輪失敗
   */
  tr.llm = (trace, turn, withTools, attempts, res, ms) => {
    trace.llmCalls++;
    var step = { type: 'llm', turn: turn, with_tools: withTools, ms: ms, attempts: attempts || [] };
    if (res) {
      var u = res.usage || {};
      trace.tokensIn += Number(u.prompt_tokens || 0);
      trace.tokensOut += Number(u.completion_tokens || 0);
      if (trace.models.indexOf(res.model) === -1) trace.models.push(res.model);
      step.model = res.model;
      step.finish = res.finish_reason;
      step.usage = res.usage || null;
      step.content = clip(res.message.content || '', 2000);
      step.tool_calls = (res.message.tool_calls || []).map(c => ({
        name: c.function && c.function.name,
        args: clip(c.function && c.function.arguments, 1000)
      }));
    } else {
      step.failed = true;
    }
    trace.steps.push(step);
  };

  /** 一次工具執行 */
  tr.tool = (trace, name, args, result, ms) => {
    trace.tools.push(name);
    trace.steps.push({
      type: 'tool', name: name, args: args, ok: !!(result && result.ok), ms: ms,
      result: clip(JSON.stringify(result), 3000)
    });
  };

  /** 備註（例如時間預算不足提早停止） */
  tr.note = (trace, text) => { trace.steps.push({ type: 'note', text: text }); };

  /**
   * 收尾並寫入 ai_trace
   * @param {string} status - 'ok'（模型給出回覆）／'fallback'（回固定道歉訊息）
   */
  tr.finish = (trace, reply, status) => {
    trace.steps.push({ type: 'output', status: status, reply: clip(reply, 3000) });
    var steps = JSON.stringify(trace.steps);
    if (steps.length > MAX_STEPS_CHARS) {
      steps = JSON.stringify(trace.steps.map(s => {
        var c = Object.assign({}, s);
        if (c.result) c.result = clip(c.result, 400);
        if (c.history) c.history = c.history.map(m => ({ role: m.role, content: clip(m.content, 80) }));
        return c;
      })).slice(0, MAX_STEPS_CHARS);
    }
    try {
      DB.insert('ai_trace', {
        trace_id: trace.trace_id,
        timestamp: trace.timestamp,
        session_id: trace.session_id,
        channel: trace.channel,
        user_text: clip(trace.user_text, 1000),
        reply: clip(reply, 3000),
        status: status,
        llm_calls: trace.llmCalls,
        tools_used: trace.tools.join(','),
        total_ms: Date.now() - trace.started,
        tokens_in: trace.tokensIn,
        tokens_out: trace.tokensOut,
        model: trace.models.join(','),
        steps: steps
      });
    } catch (ex) {
      Logger.error('AiTrace', '寫入失敗', ex);
    }
    return trace.trace_id;
  };

  // ─── 後台查詢 ─────────────────────────────────────────────────

  var summary = (r) => ({
    trace_id: String(r.trace_id),
    timestamp: String(r.timestamp),
    session_id: String(r.session_id),
    channel: String(r.channel),
    user_text: String(r.user_text),
    reply: String(r.reply),
    status: String(r.status),
    llm_calls: Number(r.llm_calls) || 0,
    tools_used: String(r.tools_used || '').split(',').filter(x => x),
    total_ms: Number(r.total_ms) || 0,
    tokens_in: Number(r.tokens_in) || 0,
    tokens_out: Number(r.tokens_out) || 0,
    model: String(r.model || '')
  });

  /** 最近 limit 筆（新 → 舊），不含 steps */
  tr.list = (limit, sessionId) => {
    var rows = DB.tail('ai_trace', 500);
    if (sessionId) rows = rows.filter(r => String(r.session_id) === String(sessionId));
    return rows.slice(-(limit || 60)).reverse().map(summary);
  };

  /** 單筆完整紀錄（含 steps） */
  tr.get = (traceId) => {
    var r = DB.tail('ai_trace', 1000).find(x => String(x.trace_id) === String(traceId));
    if (!r) return null;
    var out = summary(r);
    out.steps = Utils.parseJson(String(r.steps)) || [];
    return out;
  };

  return tr;
})();
