/**
 * WebApi
 * @description 商店頁與後台的 API — doPost（fetch）與 webApi（google.script.run）共用
 *
 * 請求：{ source:'web', action, ...參數 }；後台動作另帶 token。
 * 回應：一律 { ok, ... }，例外不外洩細節。
 */
var WebApi = (() => {
  var api = {};

  var VISITOR_RE = /^[A-Za-z0-9]{8,40}$/;

  var visitorSession = (visitorId) => {
    if (!VISITOR_RE.test(String(visitorId || ''))) throw new UserError('訪客 ID 不正確');
    return 'WEB:' + visitorId;
  };

  function UserError(msg) { this.message = msg; this.isUserError = true; }

  // ─── 後台驗證 ───────────────────────────────────────────────
  api.login = (password) => {
    if (!Config.ADMIN_PASSWORD) return { ok: false, error: '尚未設定 ADMIN_PASSWORD' };
    if (String(password || '') !== Config.ADMIN_PASSWORD) {
      Logger.warning('WebApi.login', '後台登入失敗');
      Utilities.sleep(800); // 減緩暴力嘗試
      return { ok: false, error: '密碼錯誤' };
    }
    var token = Utilities.getUuid();
    CacheService.getScriptCache().put('adm_' + token, '1', Config.ADMIN_TOKEN_TTL_SEC);
    return { ok: true, token: token };
  };

  var requireAdmin = (token) => {
    if (!token || !CacheService.getScriptCache().get('adm_' + token)) throw new UserError('AUTH');
  };

  // ─── 公開動作（商店頁）──────────────────────────────────────
  var publicActions = {
    shopInfo: () => ({
      ok: true,
      shop: { name: Config.SHOP_NAME, slogan: Config.SHOP_SLOGAN,
              shippingFee: Config.SHIPPING_FEE, freeShipping: Config.FREE_SHIPPING_THRESHOLD },
      products: Store.listProducts(false),
      categories: Store.categories()
    }),

    createOrder: (b) => {
      var sessionId = b.visitorId ? visitorSession(b.visitorId) : '';
      return Store.createOrder({
        items: b.items, customer_name: b.customer_name, phone: b.phone, address: b.address,
        payment: b.payment, note: b.note, channel: 'web', session_id: sessionId
      });
    },

    lookupOrder: (b) => Store.lookupOrder(b.order_id, b.phone, b.visitorId ? visitorSession(b.visitorId) : ''),

    myOrders: (b) => ({ ok: true, orders: Store.listOrdersBySession(visitorSession(b.visitorId)) }),

    /** 網頁對話框送出訊息；回覆可能是 null（真人模式），前端改用 chatPoll 等店員回覆 */
    chat: (b) => {
      var sessionId = visitorSession(b.visitorId);
      var text = String(b.text || '').slice(0, 500);
      var reply = ChatBot.handle(sessionId, text, String(b.name || '網頁訪客').slice(0, 30));
      var s = Conversation.getSession(sessionId);
      return { ok: true, reply: reply, mode: s ? String(s.mode) : 'ai' };
    },

    /** 取得對話紀錄（開啟對話框、真人模式輪詢時用） */
    chatHistory: (b) => {
      var sessionId = visitorSession(b.visitorId);
      var s = Conversation.getSession(sessionId);
      var msgs = s ? Conversation.messages(sessionId, 50) : [];
      return { ok: true, mode: s ? String(s.mode) : 'ai', messages: msgs };
    }
  };

  // ─── 後台動作 ───────────────────────────────────────────────
  var adminActions = {
    dashboard: () => {
      var orders = DB.all('orders');
      var products = Store.listProducts(true);
      var today = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy/MM/dd');
      var todayOrders = orders.filter(o => String(o.created_at).indexOf(today) === 0 && o.status !== '已取消');
      var sessions = Conversation.listSessions();
      return {
        ok: true,
        stats: {
          todayOrders: todayOrders.length,
          todayRevenue: todayOrders.reduce((s, o) => s + Number(o.total), 0),
          pendingOrders: orders.filter(o => o.status === '待付款' || o.status === '待出貨').length,
          lowStock: products.filter(p => p.active && p.stock <= 3).length,
          humanSessions: sessions.filter(s => s.mode === 'human').length,
          unread: sessions.reduce((s, x) => s + x.unread, 0),
          totalSessions: sessions.length
        }
      };
    },

    sessions: () => ({ ok: true, sessions: Conversation.listSessions() }),

    messages: (b) => {
      Conversation.markRead(b.sessionId);
      var s = Conversation.getSession(b.sessionId);
      return {
        ok: true,
        session: s ? { session_id: String(s.session_id), display_name: String(s.display_name), mode: String(s.mode), channel: String(s.channel) } : null,
        messages: Conversation.messages(b.sessionId, 200),
        orders: Store.listOrdersBySession(b.sessionId)
      };
    },

    /** 店員回覆客人：寫進對話紀錄，Telegram 客人另外推播 */
    reply: (b) => {
      var text = String(b.text || '').trim();
      if (!text) return { ok: false, error: '訊息是空的' };
      var s = Conversation.getSession(b.sessionId);
      if (!s) return { ok: false, error: '查無此對話' };
      Conversation.append(b.sessionId, 'staff', text);
      if (String(s.channel) === 'telegram') {
        Telegram.send(String(b.sessionId).replace(/^TG:/, ''), '【真人客服】' + text);
      }
      return { ok: true };
    },

    setMode: (b) => {
      var r = Conversation.setMode(b.sessionId, b.mode);
      if (r.ok && String(b.sessionId).indexOf('TG:') === 0) {
        Telegram.send(String(b.sessionId).replace(/^TG:/, ''),
          b.mode === 'human' ? '已由真人客服接手，請稍候 🙋' : '真人客服已結束，接下來由 AI 客服小拾為您服務 📚');
      }
      if (r.ok) Conversation.append(b.sessionId, 'system', b.mode === 'human' ? '真人客服接手' : '切回 AI 客服');
      return r;
    },

    orders: () => {
      var items = DB.all('order_items');
      var byOrder = {};
      items.forEach(i => { (byOrder[i.order_id] = byOrder[i.order_id] || []).push({ title: String(i.title), qty: Number(i.qty) }); });
      return {
        ok: true,
        statuses: DB.ORDER_STATUS,
        orders: DB.all('orders').map(o => {
          var out = {};
          DB.SCHEMA.orders.forEach(c => { out[c] = String(o[c]); });
          out.total = Number(o.total);
          out.items = byOrder[o.order_id] || [];
          return out;
        }).reverse()
      };
    },

    setOrderStatus: (b) => Store.setOrderStatus(b.order_id, b.status),

    products: () => ({ ok: true, products: Store.listProducts(true) }),

    updateProduct: (b) => Store.updateProduct(b.id, b.changes || {}),

    // ─── AI 追蹤（可查驗：模型看到什麼、叫了哪些工具、花多久、用多少 token）───
    traces: (b) => ({
      ok: true,
      traces: AiTrace.list(Number(b.limit) || 60, b.sessionId || ''),
      config: {
        model: Config.NVIDIA_MODEL,
        fallbackModel: Config.NVIDIA_FALLBACK_MODEL,
        temperature: Config.TEMPERATURE,
        maxTokens: Config.MAX_OUTPUT_TOKENS,
        maxIterations: Config.TOOL_MAX_ITERATIONS,
        historyTurns: Config.CHAT_HISTORY_TURNS
      }
    }),

    trace: (b) => {
      var t = AiTrace.get(b.traceId);
      return t ? { ok: true, trace: t } : { ok: false, error: '查無此紀錄（可能已過保留期限）' };
    },

    /** 目前的 system prompt 與工具定義，讓店家知道 AI 被怎麼約束 */
    aiConfig: () => ({
      ok: true,
      prompts: { telegram: Prompt.system('telegram'), web: Prompt.system('webchat') },
      tools: Tools.definitions().map(t => ({ name: t.function.name, description: t.function.description, parameters: t.function.parameters }))
    })
  };

  /**
   * 統一處理入口
   * @param {object} body - { action, token?, ... }
   */
  // 會改資料的動作要冪等：同一個 requestId 重送時直接回第一次的結果。
  // 2026/11/22 驗收踩到：fetch 等太久報錯 → 前端改走 google.script.run 重送 → 同一則訊息寫兩次。
  // 下單若重送就是兩張訂單，所以伺服器端也要擋，不能只靠前端。
  var IDEMPOTENT = { createOrder: true, chat: true };
  var REQ_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

  api.handle = (body) => {
    var action = String(body && body.action || '');
    var cacheKey = (IDEMPOTENT[action] && REQ_ID_RE.test(String(body.requestId || ''))) ? 'req_' + body.requestId : null;
    if (cacheKey) {
      var cache = CacheService.getScriptCache();
      var lock = LockService.getScriptLock();
      lock.waitLock(20000);
      try {
        var prev = cache.get(cacheKey);
        if (prev === 'PENDING') return { ok: false, error: '上一個請求還在處理中，請稍候' };
        if (prev) return JSON.parse(prev);
        cache.put(cacheKey, 'PENDING', 600);
      } finally { lock.releaseLock(); }
      var result = api.dispatch_(action, body);
      try { cache.put(cacheKey, JSON.stringify(result), 600); } catch (e) { cache.put(cacheKey, '{"ok":false,"error":"重複的請求"}', 600); }
      return result;
    }
    return api.dispatch_(action, body);
  };

  api.dispatch_ = (action, body) => {
    try {
      if (action === 'login') return api.login(body.password);
      if (publicActions.hasOwnProperty(action)) return publicActions[action](body);
      if (adminActions.hasOwnProperty(action)) {
        requireAdmin(body.token);
        return adminActions[action](body);
      }
      return { ok: false, error: '未知的動作：' + action };
    } catch (ex) {
      if (ex && ex.isUserError) return { ok: false, error: ex.message };
      Logger.error('WebApi.' + action, '處理失敗', ex);
      return { ok: false, error: '系統暫時無法處理，請稍後再試' };
    }
  };

  return api;
})();
