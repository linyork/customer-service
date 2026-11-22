/**
 * Config
 * @description 設定檔模組 — 集中管理系統參數與 API 金鑰
 *
 * 金鑰一律放 Script Properties（Apps Script → 專案設定 → 指令碼屬性），
 * 程式碼裡不放任何秘密。需要的屬性見 README 或執行 DevTools 的 checkConfig()。
 */
var Config = (() => {
  var props = PropertiesService.getScriptProperties();
  var get = (k) => props.getProperty(k);

  return {
    // ─── 部署 ─────────────────────────────────────────────────
    //
    // 固定的正式部署 ID（/exec）。pre-push hook 用同一個 ID 執行 clasp deploy -i，
    // 所以網址永遠不變。商店頁本來就是公開展示用，這個網址不是秘密。
    DEPLOYMENT_ID: 'AKfycbzqNMIcdZYNme14vxd5Glz6WKME-OxRmON1K-eqtn2X8N2mJvU9xJKfskwO8lEW-49J',
    get WEB_APP_URL() { return 'https://script.google.com/macros/s/' + this.DEPLOYMENT_ID + '/exec'; },

    // ─── 商店資訊（Prompt 與頁面共用）──────────────────────────
    SHOP_NAME:    '拾頁書店',
    SHOP_SLOGAN:  '每一本書，都是一扇窗',
    SHIPPING_FEE: 60,
    FREE_SHIPPING_THRESHOLD: 1000,

    // ─── Telegram ─────────────────────────────────────────────
    get TELEGRAM_API_KEY()  { return get('TELEGRAM_API_KEY'); },
    get TELEGRAM_API_BASE() { return 'https://api.telegram.org/bot' + this.TELEGRAM_API_KEY; },
    // 店家通知用的聊天室（新訂單、轉真人）。由店員在 bot 輸入 /admin <密碼> 自動綁定。
    get ADMIN_CHAT_ID()     { return get('ADMIN_CHAT_ID'); },

    // ─── Google Sheet（資料庫）────────────────────────────────
    get SHEET_ID() { return get('SHEET_ID'); },

    // ─── 後台 ─────────────────────────────────────────────────
    get ADMIN_PASSWORD() { return get('ADMIN_PASSWORD'); },
    ADMIN_TOKEN_TTL_SEC: 21600,

    // ─── NVIDIA NIM ───────────────────────────────────────────
    get NVIDIA_API_KEY() { return get('NVIDIA_API_KEY'); },
    NVIDIA_API_BASE: 'https://integrate.api.nvidia.com/v1',
    // 主模型：非思考、原生 Function Calling、繁中表現穩定（iris／christina 實測過）。
    // 可用 Script Property NVIDIA_MODEL 覆寫，換模型不必重新部署（先跑 DevTools.testNimCandidates）。
    get NVIDIA_MODEL() { return get('NVIDIA_MODEL') || 'google/gemma-4-31b-it'; },
    // 主模型失敗（下架、過載、重試耗盡）時改用這顆重試一次；Script Property NVIDIA_FALLBACK_MODEL 可覆寫。
    // ⚠️ 原本的 openai/gpt-oss-20b 在 2026/11/22 已不在 NIM 目錄上，暫用同家族小模型。
    get NVIDIA_FALLBACK_MODEL() { return get('NVIDIA_FALLBACK_MODEL') || 'google/gemma-3-12b-it'; },
    MAX_OUTPUT_TOKENS: 2048,
    TEMPERATURE: 0.4,

    // ─── 對話 ─────────────────────────────────────────────────
    CHAT_HISTORY_TURNS: 8,      // 帶進 LLM 的歷史訊息則數（user + assistant 各算一則）
    TOOL_MAX_ITERATIONS: 5,     // ReAct 迴圈上限（最後一輪不帶工具）
    CHAT_CLEANUP_DAYS: 60,
    LOG_CLEANUP_DAYS: 14,

    // 頻率限制：同一個客人 RATE_WINDOW_SEC 秒內最多 RATE_MAX_MSGS 則
    RATE_WINDOW_SEC: 600,
    RATE_MAX_MSGS:   20,

    // ─── Debug（Script Property DEBUG_MODE，沒設就是開）────────
    get DEBUG_MODE() {
      return String(get('DEBUG_MODE') || '').trim().toLowerCase() !== 'false';
    }
  };
})();
