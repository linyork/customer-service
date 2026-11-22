/**
 * Store
 * @description 電商業務邏輯 — 商品查詢、下單、查單、取消
 *
 * 網頁結帳、AI 客服工具、後台三條路都呼叫這裡，規則只寫一份：
 * 庫存檢查、運費計算、訂單可否取消，不會因為從哪裡進來而不同。
 * 回傳一律是 { ok, error?, ... }，不丟例外給呼叫端。
 */
var Store = (() => {
  var store = {};

  var toProduct = (p) => ({
    id:          String(p.id),
    title:       String(p.title),
    author:      String(p.author),
    category:    String(p.category),
    price:       Number(p.price),
    stock:       Number(p.stock),
    description: String(p.description),
    color:       String(p.color || '#8b5e3c'),
    active:      p.active === true || String(p.active).toUpperCase() === 'TRUE'
  });

  store.listProducts = (includeInactive) =>
    DB.all('products').map(toProduct).filter(p => includeInactive || p.active);

  store.getProduct = (id) => {
    var p = DB.first('products', r => String(r.id) === String(id));
    return p ? toProduct(p) : null;
  };

  /**
   * 搜尋商品：書名／作者／分類／簡介任一包含關鍵字即命中。
   * 中文關鍵字常含空白分隔的多個詞，全部命中才算（AND）。
   */
  store.searchProducts = (keyword, category) => {
    var terms = String(keyword || '').toLowerCase().split(/\s+/).filter(t => t);
    return store.listProducts(false).filter(p => {
      if (category && p.category !== category) return false;
      var hay = (p.title + ' ' + p.author + ' ' + p.category + ' ' + p.description).toLowerCase();
      return terms.every(t => hay.indexOf(t) >= 0);
    });
  };

  store.categories = () => {
    var seen = {};
    store.listProducts(false).forEach(p => { seen[p.category] = true; });
    return Object.keys(seen);
  };

  store.shippingFor = (subtotal) =>
    subtotal >= Config.FREE_SHIPPING_THRESHOLD ? 0 : Config.SHIPPING_FEE;

  /**
   * 建立訂單
   * @param {object} input
   *   items: [{ product_id, qty }]
   *   customer_name, phone, address, payment('轉帳'|'貨到付款'), note
   *   channel('web'|'telegram'|'webchat'), session_id
   * @returns {{ok:boolean, error?:string, order?:object}}
   */
  store.createOrder = (input) => {
    input = input || {};
    var items = Array.isArray(input.items) ? input.items : [];
    var name = String(input.customer_name || '').trim();
    var phone = Utils.normalizePhone(input.phone);
    var address = String(input.address || '').trim();
    var payment = String(input.payment || '').trim();

    if (!items.length) return { ok: false, error: '購物車是空的' };
    if (!name) return { ok: false, error: '缺少收件人姓名' };
    if (phone.length < 8 || phone.length > 12) return { ok: false, error: '電話格式不正確' };
    if (!address) return { ok: false, error: '缺少收件地址' };
    if (['轉帳', '貨到付款'].indexOf(payment) < 0) return { ok: false, error: '付款方式只能是「轉帳」或「貨到付款」' };

    return DB.withLock(() => {
      var rows = DB.all('products');
      var lines = [];
      var merged = {};
      items.forEach(it => {
        var id = String(it.product_id || '').trim();
        var qty = Math.floor(Number(it.qty));
        merged[id] = (merged[id] || 0) + qty;
      });

      for (var id in merged) {
        var qty = merged[id];
        var row = rows.find(r => String(r.id) === id);
        if (!row || !toProduct(row).active) return { ok: false, error: '找不到商品 ' + id };
        if (!(qty >= 1 && qty <= 99)) return { ok: false, error: '《' + row.title + '》數量不正確' };
        if (Number(row.stock) < qty) {
          return { ok: false, error: '《' + row.title + '》庫存不足（剩 ' + Number(row.stock) + ' 本）' };
        }
        lines.push({ row: row, qty: qty });
      }

      var orderId = Utils.newOrderId();
      while (DB.first('orders', o => String(o.order_id) === orderId)) orderId = Utils.newOrderId();

      var subtotal = lines.reduce((s, l) => s + Number(l.row.price) * l.qty, 0);
      var shipping = store.shippingFor(subtotal);
      var now = Utils.now();

      // 先扣庫存再寫訂單：中途失敗時寧可庫存少算（店家看得到），不要超賣
      lines.forEach(l => DB.update('products', l.row, { stock: Number(l.row.stock) - l.qty }));

      var order = {
        order_id: orderId, created_at: now,
        channel: input.channel || 'web', session_id: input.session_id || '',
        customer_name: name, phone: phone, address: address, payment: payment,
        subtotal: subtotal, shipping: shipping, total: subtotal + shipping,
        status: payment === '轉帳' ? '待付款' : '待出貨',
        note: String(input.note || ''), updated_at: now
      };
      DB.insert('orders', order);
      DB.insertMany('order_items', lines.map(l => ({
        order_id: orderId, product_id: String(l.row.id), title: l.row.title,
        price: Number(l.row.price), qty: l.qty, amount: Number(l.row.price) * l.qty
      })));

      Logger.info('Store.createOrder', '新訂單 ' + orderId, { total: order.total, channel: order.channel });
      var result = store.getOrder(orderId);
      Notify.newOrder(result);
      return { ok: true, order: result };
    });
  };

  /** 取得訂單（含明細），不驗身分 —— 只給後台與內部用 */
  store.getOrder = (orderId) => {
    var o = DB.first('orders', r => String(r.order_id) === String(orderId).trim().toUpperCase());
    if (!o) return null;
    var items = DB.find('order_items', r => String(r.order_id) === String(o.order_id)).map(i => ({
      product_id: String(i.product_id), title: String(i.title),
      price: Number(i.price), qty: Number(i.qty), amount: Number(i.amount)
    }));
    var out = {};
    DB.SCHEMA.orders.forEach(c => { out[c] = o[c]; });
    out.phone = String(o.phone);
    out.items = items;
    return out;
  };

  /**
   * 客人查單：訂單編號 + 電話都對才給看。
   * 同一個 session 下的單（自己在這個聊天室下的）免填電話。
   */
  store.lookupOrder = (orderId, phone, sessionId) => {
    var order = store.getOrder(orderId);
    if (!order) return { ok: false, error: '查無此訂單編號' };
    var sameSession = sessionId && String(order.session_id) === String(sessionId);
    var phoneOk = phone && Utils.normalizePhone(phone) === Utils.normalizePhone(order.phone);
    if (!sameSession && !phoneOk) return { ok: false, error: '訂單編號與電話不符' };
    return { ok: true, order: order };
  };

  store.listOrdersBySession = (sessionId) =>
    DB.find('orders', o => sessionId && String(o.session_id) === String(sessionId))
      .map(o => store.getOrder(o.order_id))
      .reverse();

  /** 客人取消：只有「待付款／待出貨」可以取消，取消後回補庫存 */
  store.cancelOrder = (orderId, phone, sessionId) => {
    var found = store.lookupOrder(orderId, phone, sessionId);
    if (!found.ok) return found;
    if (['待付款', '待出貨'].indexOf(found.order.status) < 0) {
      return { ok: false, error: '訂單目前狀態為「' + found.order.status + '」，無法取消，請聯絡真人客服' };
    }
    return store.setOrderStatus(found.order.order_id, '已取消');
  };

  /** 改訂單狀態（後台與取消共用）；改成「已取消」時回補庫存，從已取消改回來則重新扣 */
  store.setOrderStatus = (orderId, status) => {
    if (DB.ORDER_STATUS.indexOf(status) < 0) return { ok: false, error: '不合法的狀態：' + status };
    return DB.withLock(() => {
      var o = DB.first('orders', r => String(r.order_id) === String(orderId));
      if (!o) return { ok: false, error: '查無此訂單' };
      var prev = String(o.status);
      if (prev === status) return { ok: true, order: store.getOrder(orderId) };

      var sign = 0;
      if (status === '已取消' && prev !== '已取消') sign = +1;
      if (prev === '已取消' && status !== '已取消') sign = -1;
      if (sign !== 0) {
        var products = DB.all('products');
        var items = DB.find('order_items', r => String(r.order_id) === String(orderId));
        if (sign < 0) {
          for (var i = 0; i < items.length; i++) {
            var p0 = products.find(p => String(p.id) === String(items[i].product_id));
            if (p0 && Number(p0.stock) < Number(items[i].qty)) {
              return { ok: false, error: '《' + p0.title + '》庫存不足，無法恢復訂單' };
            }
          }
        }
        items.forEach(it => {
          var p = products.find(pp => String(pp.id) === String(it.product_id));
          if (p) DB.update('products', p, { stock: Number(p.stock) + sign * Number(it.qty) });
        });
      }

      DB.update('orders', o, { status: status, updated_at: Utils.now() });
      Logger.info('Store.setOrderStatus', orderId + '：' + prev + ' → ' + status);
      return { ok: true, order: store.getOrder(orderId) };
    });
  };

  /** 後台改商品（價格、庫存、上下架） */
  store.updateProduct = (id, changes) => {
    var allowed = ['title', 'author', 'category', 'price', 'stock', 'description', 'color', 'active'];
    var clean = {};
    allowed.forEach(k => { if (changes && changes.hasOwnProperty(k)) clean[k] = changes[k]; });
    if (clean.hasOwnProperty('price') && !(Number(clean.price) >= 0)) return { ok: false, error: '價格不正確' };
    if (clean.hasOwnProperty('stock') && !(Number(clean.stock) >= 0 && Number(clean.stock) % 1 === 0)) {
      return { ok: false, error: '庫存必須是 0 以上的整數' };
    }
    if (clean.hasOwnProperty('price')) clean.price = Number(clean.price);
    if (clean.hasOwnProperty('stock')) clean.stock = Number(clean.stock);
    if (clean.hasOwnProperty('active')) clean.active = clean.active === true || String(clean.active).toUpperCase() === 'TRUE';
    return DB.withLock(() => {
      var row = DB.first('products', r => String(r.id) === String(id));
      if (!row) return { ok: false, error: '查無此商品' };
      DB.update('products', row, clean);
      return { ok: true, product: toProduct(row) };
    });
  };

  /** 把訂單整理成給客人看的純文字（Telegram 與網頁對話框共用） */
  store.formatOrder = (o) => {
    var lines = [
      '訂單編號：' + o.order_id,
      '狀態：' + o.status,
      '下單時間：' + o.created_at
    ];
    o.items.forEach(i => lines.push('・《' + i.title + '》x' + i.qty + '　' + Utils.money(i.amount)));
    lines.push('運費：' + Utils.money(o.shipping));
    lines.push('合計：' + Utils.money(o.total) + '（' + o.payment + '）');
    return lines.join('\n');
  };

  return store;
})();
