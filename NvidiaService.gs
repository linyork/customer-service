/**
 * NvidiaService
 * @description NVIDIA NIM（OpenAI 相容格式）唯一的 LLM 出口
 *
 * 與 iris／christina 的差異：這裡只接 NVIDIA，整條路直接用 OpenAI 格式，
 * 不需要 AIServiceFactory / AIAdapter 那層 Gemini ↔ OpenAI 轉換。
 *
 * 保留的兩個保護（iris 踩過的坑）：
 *   1. 重試前先看錶：NIM gateway 逾時約 300s、GAS 上限 360s，一次慢速失敗就能吃光預算，
 *      所以「剩餘時間裝得下再一次」才重試，裝不下直接讓給備援模型。
 *   2. N-1 備援：主模型回 null（下架、過載、重試耗盡）時，改用 NVIDIA_FALLBACK_MODEL 再試一次。
 */
var NvidiaService = (() => {
  var svc = {};

  var MAX_ATTEMPTS = 3;
  var RESERVE_MS = 30000;      // 留給呼叫端收尾（寫紀錄、回覆客人）
  var FALLBACK_MIN_MS = 60000; // 剩不到這麼多時間就不開備援

  var buildPayload = (model, messages, options) => {
    var payload = {
      model: model,
      messages: messages,
      temperature: options.temperature !== undefined ? options.temperature : Config.TEMPERATURE,
      max_tokens: options.maxTokens || Config.MAX_OUTPUT_TOKENS
    };
    if (options.tools && options.tools.length) {
      payload.tools = options.tools;
      // gemma 帶 tool_choice 反而不穩（iris 實測），其他模型照 OpenAI 慣例送 auto
      if (model.indexOf('gemma') === -1) payload.tool_choice = 'auto';
    }
    // gpt-oss 沒有思考開關，只有強度，且必須放 top-level 才生效
    if (model.indexOf('openai/gpt-oss') === 0) payload.reasoning_effort = 'low';
    return payload;
  };

  /**
   * 單一模型的呼叫（含重試）。成功回 { message, finish_reason, model, usage }，失敗回 null
   * options.trace（陣列）有給的話，每次 HTTP 嘗試都記一筆，給 AiTrace 用
   */
  var callModel = (model, messages, options) => {
    var record = (o) => { if (options.trace) options.trace.push(Object.assign({ model: model }, o)); };
    var fetchOptions = {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + Config.NVIDIA_API_KEY, Accept: 'application/json' },
      payload: JSON.stringify(buildPayload(model, messages, options)),
      muteHttpExceptions: true
    };

    for (var attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      var started = Date.now();
      var reason = '';
      var code = 0;
      try {
        var res = UrlFetchApp.fetch(Config.NVIDIA_API_BASE + '/chat/completions', fetchOptions);
        code = res.getResponseCode();
        if (code === 200) {
          var body = Utils.parseJson(res.getContentText('UTF-8'));
          var choice = body && body.choices && body.choices[0];
          if (!choice || !choice.message) {
            Logger.error('NvidiaService', '回應缺少 choices', res.getContentText().slice(0, 300));
            record({ ok: false, status: 200, ms: Date.now() - started, reason: '回應缺少 choices' });
            return null;
          }
          record({ ok: true, status: 200, ms: Date.now() - started });
          Logger.ai('NvidiaService', '模型回應', {
            model: model, finish: choice.finish_reason, usage: body.usage || null,
            ms: Date.now() - started, tools: (choice.message.tool_calls || []).length
          });
          return { message: choice.message, finish_reason: choice.finish_reason, model: model, usage: body.usage || null };
        }
        // 4xx（429 除外）是請求本身的問題，重試沒用
        if (code !== 429 && code < 500) {
          record({ ok: false, status: code, ms: Date.now() - started, reason: 'HTTP ' + code + '（不重試）' });
          Logger.error('NvidiaService', 'HTTP ' + code + '（不重試）', model + ' | ' + res.getContentText().slice(0, 300));
          return null;
        }
        reason = 'HTTP ' + code;
      } catch (ex) {
        reason = '連線例外：' + ex;
      }
      record({ ok: false, status: code || 0, ms: Date.now() - started, reason: reason });

      if (attempt === MAX_ATTEMPTS) break;
      var waitMs = 2000 * Math.pow(2, attempt - 1);
      var needMs = waitMs + (Date.now() - started) + RESERVE_MS;
      if (Utils.execTimeLeftMs() < needMs) {
        Logger.warning('NvidiaService', reason + '，時間不夠再試一次，放棄', model);
        return null;
      }
      Logger.warning('NvidiaService', reason + '，第 ' + attempt + ' 次失敗，' + waitMs + 'ms 後重試', model);
      Utilities.sleep(waitMs);
    }
    Logger.error('NvidiaService', '重試耗盡', model);
    return null;
  };

  /**
   * 對話補全
   * @param {Array} messages - OpenAI 格式 [{role, content, tool_calls?, tool_call_id?}]
   * @param {object} options - { tools?, temperature?, maxTokens?, trace? }
   * @returns {{message:object, finish_reason:string, model:string}|null}
   */
  svc.chat = (messages, options) => {
    options = options || {};
    if (!Config.NVIDIA_API_KEY) {
      Logger.error('NvidiaService', '未設定 NVIDIA_API_KEY');
      return null;
    }
    var result = callModel(Config.NVIDIA_MODEL, messages, options);
    if (result) return svc.clean(result);

    if (Config.NVIDIA_FALLBACK_MODEL && Utils.execTimeLeftMs() >= FALLBACK_MIN_MS) {
      Logger.warning('NvidiaService', '主模型失敗，改用備援 ' + Config.NVIDIA_FALLBACK_MODEL);
      result = callModel(Config.NVIDIA_FALLBACK_MODEL, messages, options);
      if (result) return svc.clean(result);
    }
    return null;
  };

  /** 清掉模型偶爾混進正文的 <think>…</think> */
  svc.clean = (result) => {
    var m = result.message;
    if (typeof m.content === 'string') {
      var c = m.content.replace(/<think>[\s\S]*?<\/think>/gi, '');
      var close = c.toLowerCase().indexOf('</think>');
      if (close !== -1) c = c.slice(close + 8);
      m.content = c.trim();
    }
    return result;
  };

  return svc;
})();
