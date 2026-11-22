/**
 * Tools
 * @description AI 客服可呼叫的工具（OpenAI function calling 格式）
 *
 * definitions() 與 execute() 的 switch 必須一起改。
 * 工具一律回傳 { ok, ... }：失敗時 ok=false 並附 error，讓模型分得出「查不到」與「出錯」，
 * 不會把錯誤訊息當成資料轉述給客人。
 *
 * 身分邊界：工具拿到的 ctx.sessionId 由系統注入，不是模型給的參數 ——
 * 模型無法冒用別人的 session 來查單或取消。
 */
var Tools = (() => {
  var tools = {};

  var fn = (name, description, properties, required) => ({
    type: 'function',
    function: {
      name: name,
      description: description,
      parameters: { type: 'object', properties: properties || {}, required: required || [] }
    }
  });

  tools.definitions = () => [
    fn('search_products',
      '搜尋書籍。keyword 比對書名、作者、分類、簡介；兩者都不給則列出全部在售書籍。回傳含價格與庫存。',
      {
        keyword:  { type: 'string', description: '關鍵字，例如「推理」「沈默言」「理財」' },
        category: { type: 'string', description: '分類，必須是商店既有分類之一' }
      }),
    fn('get_product',
      '取得單一本書的完整資訊（價格、庫存、簡介）。',
      { product_id: { type: 'string', description: '書籍編號，例如 B001' } },
      ['product_id']),
    fn('create_order',
      '建立訂單。⚠️ 只能在客人看過完整訂單摘要（書名、數量、金額、收件資料、付款方式）並明確回覆確認之後呼叫。',
      {
        items: {
          type: 'array',
          description: '購買的書',
          items: {
            type: 'object',
            properties: {
              product_id: { type: 'string', description: '書籍編號' },
              qty:        { type: 'integer', description: '數量' }
            },
            required: ['product_id', 'qty']
          }
        },
        customer_name: { type: 'string', description: '收件人姓名' },
        phone:         { type: 'string', description: '收件人手機' },
        address:       { type: 'string', description: '收件地址' },
        payment:       { type: 'string', enum: ['轉帳', '貨到付款'], description: '付款方式' },
        note:          { type: 'string', description: '備註（統編等），可省略' }
      },
      ['items', 'customer_name', 'phone', 'address', 'payment']),
    fn('list_my_orders',
      '列出這位客人在目前這個聊天室下過的訂單。'),
    fn('lookup_order',
      '用訂單編號查詢訂單狀態。不是在這個聊天室下的單，需要客人提供下單時的電話。',
      {
        order_id: { type: 'string', description: '訂單編號，例如 BK202611220417' },
        phone:    { type: 'string', description: '下單時填的電話（同聊天室下的單可省略）' }
      },
      ['order_id']),
    fn('cancel_order',
      '取消訂單（僅限待付款／待出貨）。⚠️ 呼叫前先跟客人確認要取消哪一張。',
      {
        order_id: { type: 'string', description: '訂單編號' },
        phone:    { type: 'string', description: '下單時填的電話（同聊天室下的單可省略）' }
      },
      ['order_id']),
    fn('request_human',
      '轉接真人客服。客人明確要求真人、抱怨、退換貨爭議、或問題超出你能處理的範圍時使用。',
      { reason: { type: 'string', description: '轉接原因，一句話摘要' } },
      ['reason'])
  ];

  var slimProduct = (p) => ({
    id: p.id, title: p.title, author: p.author, category: p.category,
    price: p.price, stock: p.stock, in_stock: p.stock > 0, description: p.description
  });

  var slimOrder = (o) => ({
    order_id: o.order_id, status: o.status, created_at: o.created_at, payment: o.payment,
    items: o.items.map(i => ({ title: i.title, qty: i.qty, amount: i.amount })),
    shipping: o.shipping, total: o.total
  });

  /**
   * 執行工具
   * @param {string} name
   * @param {object} args - 模型給的參數
   * @param {{sessionId:string, channel:string, displayName?:string}} ctx - 系統注入，模型碰不到
   * @returns {object} 一律帶 ok
   */
  tools.execute = (name, args, ctx) => {
    args = args || {};
    try {
      switch (name) {
        case 'search_products': {
          var list = Store.searchProducts(args.keyword, args.category);
          if (!list.length && args.keyword && !args.category) {
            // 模型常把分類名當關鍵字送進來，再當分類試一次
            list = Store.searchProducts('', args.keyword);
          }
          return { ok: true, count: list.length, products: list.map(slimProduct), categories: Store.categories() };
        }
        case 'get_product': {
          var p = Store.getProduct(args.product_id);
          if (!p || !p.active) return { ok: false, error: '查無此書籍編號：' + args.product_id };
          return { ok: true, product: slimProduct(p) };
        }
        case 'create_order': {
          var r = Store.createOrder({
            items: args.items, customer_name: args.customer_name, phone: args.phone,
            address: args.address, payment: args.payment, note: args.note,
            channel: ctx.channel, session_id: ctx.sessionId
          });
          if (!r.ok) return r;
          var o = slimOrder(r.order);
          if (r.order.payment === '轉帳') {
            o.next_step = '請於 3 天內轉帳至 拾頁銀行（999）0000-1234-5678，並告知訂單編號與帳號末五碼';
          }
          return { ok: true, order: o };
        }
        case 'list_my_orders': {
          var orders = Store.listOrdersBySession(ctx.sessionId);
          return { ok: true, count: orders.length, orders: orders.slice(0, 5).map(slimOrder) };
        }
        case 'lookup_order': {
          var f = Store.lookupOrder(args.order_id, args.phone, ctx.sessionId);
          return f.ok ? { ok: true, order: slimOrder(f.order) } : f;
        }
        case 'cancel_order': {
          var c = Store.cancelOrder(args.order_id, args.phone, ctx.sessionId);
          return c.ok ? { ok: true, order: slimOrder(c.order) } : c;
        }
        case 'request_human': {
          Conversation.setMode(ctx.sessionId, 'human');
          Notify.handoff(ctx.sessionId, ctx.displayName, args.reason);
          Logger.info('Tools.request_human', '轉真人', { session: ctx.sessionId, reason: args.reason });
          return { ok: true, message: '已轉接真人客服，店員會在服務時間內回覆（週一至週五 10:00–18:00）' };
        }
        default:
          return { ok: false, error: '未知的工具：' + name };
      }
    } catch (ex) {
      Logger.error('Tools.execute', name + ' 執行失敗', ex);
      return { ok: false, error: '系統暫時無法處理，請稍後再試' };
    }
  };

  return tools;
})();
