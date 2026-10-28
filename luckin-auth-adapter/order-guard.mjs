// Only the authenticated client can answer the server's confirmation request.
// A model-provided boolean or quoted user message never authorizes a purchase.
export function createOrderGuard({ seal, unseal, hash, random, now, boot, providerTag, upstream, Failure }) {
  const used = new Map();
  const locks = new Map();
  const fail = (ok, code, text) => { if (!ok) throw new Failure(409, code, text); };
  const canonical = value => JSON.stringify(value);
  const cents = value => {
    fail(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10000, 'invalid_preview', '预览金额无效，不能创建订单。');
    const result = Math.round(value * 100);
    fail(Math.abs(value * 100 - result) < 0.00001, 'invalid_preview', '预览金额精度无效。');
    return result;
  };
  function data(result) {
    fail(!result?.isError, 'invalid_preview', '瑞幸未返回成功的订单预览。');
    const text = result?.content?.find(c => c.type === 'text')?.text;
    let value;
    try { value = JSON.parse(text); } catch { /* fail below */ }
    fail(value?.success === true && value.code === 0 && value.data, 'invalid_preview', '瑞幸未返回成功的订单预览。');
    return value.data;
  }
  function snapshot(result, args) {
    const d = data(result), shop = d.shopInfo;
    fail(Number.isSafeInteger(args?.deptId) && args.deptId > 0 && shop?.deptId === args.deptId, 'invalid_preview', '预览门店不匹配。');
    fail(typeof shop.deptName === 'string' && shop.deptName && typeof shop.address === 'string' && shop.address, 'invalid_preview', '预览缺少门店名称或地址。');
    fail(Number.isFinite(shop.longitude) && Math.abs(shop.longitude) <= 180 && Number.isFinite(shop.latitude) && Math.abs(shop.latitude) <= 90, 'invalid_preview', '预览缺少门店坐标。');
    fail(Array.isArray(args.productList) && args.productList.length > 0 && args.productList.length <= 5 && Array.isArray(d.productInfoList) && d.productInfoList.length === args.productList.length, 'invalid_preview', '预览商品不完整。');
    const products = d.productInfoList.map(p => {
      fail(Number.isSafeInteger(p.productId) && typeof p.skuCode === 'string' && p.skuCode.length <= 100 && Number.isSafeInteger(p.amount) && p.amount > 0 && p.amount <= 10 && typeof p.name === 'string' && p.name && typeof p.additionDesc === 'string' && p.additionDesc, 'invalid_preview', '预览缺少明确的商品、规格或数量。');
      return { productId: p.productId, skuCode: p.skuCode, amount: p.amount, name: p.name, specification: p.additionDesc };
    }).sort((a, b) => canonical(a).localeCompare(canonical(b)));
    const selection = list => list.map(p => ({ productId: p.productId, skuCode: p.skuCode, amount: p.amount })).sort((a, b) => canonical(a).localeCompare(canonical(b)));
    fail(canonical(selection(products)) === canonical(selection(args.productList)), 'invalid_preview', '预览与请求的商品或数量不一致。');
    fail(Array.isArray(d.couponCodeList) && d.couponCodeList.every(c => typeof c === 'string' && c.length < 200), 'invalid_preview', '预览缺少可核对的优惠信息。');
    return {
      shop: { deptId: shop.deptId, name: shop.deptName, address: shop.address, longitude: shop.longitude, latitude: shop.latitude },
      products, total: cents(d.discountPrice), original: cents(d.totalInitialPrice), discount: cents(d.privilegeMoney),
      coupons: [...d.couponCodeList].sort(),
    };
  }
  const argsFor = s => ({ deptId: s.shop.deptId, productList: s.products.map(({ productId, skuCode, amount }) => ({ productId, skuCode, amount })) });
  const summaryFor = s => `门店自取：${s.shop.name}\n地址：${s.shop.address}\n${s.products.map(p => `${p.name} × ${p.amount}，${p.specification}`).join('\n')}\n原价 ¥${(s.original / 100).toFixed(2)}，优惠 ¥${(s.discount / 100).toFixed(2)}，合计 ¥${(s.total / 100).toFixed(2)}。\n确认后会创建真实订单；付款仍由你自己完成。`;
  function capture(result, args, principal) {
    const s = snapshot(result, args);
    const previewReceipt = seal('order_preview', { snapshot: s, owner: hash(principal.client_id), providerTag, boot, nonce: random(), exp: now() + 600 });
    fail(previewReceipt.length <= 12000, 'invalid_preview', '预览内容过长，不能生成确认凭据。');
    return { previewReceipt, confirmationSummary: summaryFor(s), expiresInSeconds: 600 };
  }
  function read(receipt, principal) {
    let p;
    try { p = unseal(receipt, 'order_preview'); } catch { throw new Failure(409, 'preview_expired', '订单预览已失效，请重新预览并确认。'); }
    fail(p.boot === boot && p.providerTag === providerTag && p.owner === hash(principal.client_id), 'preview_expired', '订单预览不属于当前连接或服务已重启，请重新预览并确认。');
    return p;
  }
  async function create(receipt, principal, session, elicit) {
    const p = read(receipt, principal), receiptId = hash(receipt), fingerprint = hash(canonical(argsFor(p.snapshot)));
    for (const map of [used, locks]) for (const [id, record] of map) if (record.exp <= now()) map.delete(id);
    fail(!used.has(receiptId), 'confirmation_used', '这份确认已使用，禁止重复提交；先查询已有订单。');
    fail(!locks.has(fingerprint), 'duplicate_order_blocked', '相同订单已有提交或结果待核对，请先核对瑞幸订单，不能重复创建。');
    fail(used.size < 1000 && locks.size < 1000, 'order_limit', '当前订单保护记录已满，暂不创建订单。');
    // Reserve before any await so concurrent calls cannot duplicate an order.
    used.set(receiptId, { exp: p.exp });
    let attempted = false;
    const verify = async () => {
      const checked = await upstream({ jsonrpc: '2.0', id: `price-${random()}`, method: 'tools/call', params: { name: 'previewOrder', arguments: argsFor(p.snapshot) } }, session);
      fail(!checked.message.error && canonical(snapshot(checked.message.result, argsFor(p.snapshot))) === canonical(p.snapshot), 'preview_changed', '门店、商品、优惠或金额已变化，请重新预览并取得确认。');
    };
    try {
      await verify();
      const answer = await elicit(summaryFor(p.snapshot));
      if (answer?.action !== 'accept' || answer.content?.confirmed !== true) {
        return { content: [{ type: 'text', text: '未收到用户明确确认，本次没有创建订单。' }], structuredContent: { status: 'not_confirmed', orderCreated: false } };
      }
      read(receipt, principal);
      await verify();
      fail(!locks.has(fingerprint), 'duplicate_order_blocked', '相同订单已有提交或结果待核对，禁止重复创建。');
      locks.set(fingerprint, { exp: now() + 86400 });
      attempted = true;
      const s = p.snapshot;
      const response = await upstream({ jsonrpc: '2.0', id: `create-${random()}`, method: 'tools/call', params: { name: 'createOrder', arguments: {
        ...argsFor(s), longitude: s.shop.longitude, latitude: s.shop.latitude, couponCodeList: s.coupons,
      } } }, session);
      // Even a merchant error is never automatically retried: creation may
      // have reached the merchant. Pass its actual response to the owner.
      if (response.message.error) throw new Failure(409, 'order_outcome_unknown', '瑞幸下单返回错误，结果待核对；本次没有自动重试。请先在瑞幸查看是否已生成订单。');
      let outcome;
      try { outcome = data(response.message.result); } catch { /* ambiguous */ }
      if (!outcome?.orderIdStr) throw new Failure(409, 'order_outcome_unknown', '瑞幸下单结果未能明确核对；请先在瑞幸查看是否已生成订单，禁止直接重试。');
      locks.set(fingerprint, { exp: now() + 600 });
      return response.message.result;
    } catch (e) {
      if (attempted) throw new Failure(409, 'order_outcome_unknown', '订单提交结果待核对；本次没有自动重试。请先在瑞幸查看是否已生成订单，禁止重复创建。');
      throw e;
    }
  }
  return { capture, create };
}
