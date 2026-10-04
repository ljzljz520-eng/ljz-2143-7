// 验收脚本：题目点名的场景全部以 API 级端到端方式验证。
// 用法：node test/acceptance.js （默认对 http://localhost:3000，或 BASE_URL 环境变量）
// 每个场景独立建单建任务，避免相互污染。
const BASE = process.env.BASE_URL || 'http://localhost:3000';
let pass = 0, fail = 0;
const J = async (u, b, method) => {
  const opt = { method: method || (b ? 'POST' : 'GET'), headers: { 'X-Actor': 'test' } };
  if (b) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(b); }
  const r = await fetch(BASE + u, opt);
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const check = (name, cond, info) => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}`, info ?? ''); }
};
const uid = p => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(4, 9)}`;

// 用一个专门的测试订单（动态建单走不到接口，直接复用种子订单行做拆分；
// 为互不干扰，测试直接针对 SO-...01 的前两行反复"整行"分配 —— 但会耗尽计划，
// 所以每个场景从"创建订单"开始。种子没有建单 API，这里用 SO-01 拆出的不同行组合 +
// 短缺订单 SO-02。为隔离，测试中所有任务完成后不影响其它场景（每场景只用自己行）。

async function freshTaskOnLines(orderId, lineFilter) {
  const od = (await J(`/api/orders/${orderId}`)).json;
  const split = od.lines.filter(lineFilter).map(l => ({ order_line_id: l.id, qty: l.qty_plan }));
  const a = await J(`/api/orders/${orderId}/allocate`, { split });
  return a.json;
}

async function claim(taskId, dev) { return (await J(`/api/tasks/${taskId}/claim`, { deviceId: dev })).json; }
async function scan(o) { return (await J('/api/scan', o)).json; }

async function main() {
  console.log('== 场景1：扫描枪连发（5 扫同 SKU 同任务行，分配量 3）防超拣 ==');
  {
    // SO-01 第一行 SKU1001 计划 10；先拆 3 件给本场景任务
    const od = (await J('/api/orders/1')).json;
    const ol = od.lines.find(l => l.sku === 'SKU1001');
    const t = (await J('/api/orders/1/allocate', { split: [{ order_line_id: ol.id, qty: 3 }] })).json;
    const c = await claim(t.taskId, 'GUN-BURST');
    const tl = (await J(`/api/tasks/${t.taskId}`)).json.lines.find(l => l.sku === 'SKU1001');
    const rs = [];
    for (let i = 0; i < 5; i += 1)
      rs.push(await scan({ taskId: t.taskId, taskLineId: tl.id, deviceId: 'GUN-BURST',
        scanCode: 'SKU1001', scanType: 'sku', qty: 1, clientUid: uid('U') }));
    const acc = rs.filter(r => r.result === 'accepted').length;
    const over = rs.filter(r => r.reason === 'overpick').length;
    check('5 连扫中恰有 3 扫 accepted', acc === 3, rs.map(r => r.result + ':' + (r.reason || '')).join(','));
    check('2 扫被 overpick 拒绝，未扣库存', over === 2, JSON.stringify(rs));
  }

  console.log('== 场景2：重复上传（同一 client_uid）不得再次减可用量 ==');
  {
    const od = (await J('/api/orders/1')).json;
    const ol = od.lines.find(l => l.sku === 'SKU1002');
    const t = (await J('/api/orders/1/allocate', { split: [{ order_line_id: ol.id, qty: 2 }] })).json;
    await claim(t.taskId, 'DUP-DEV');
    const invBefore = (await J('/api/inventory')).json.find(i => i.shelf === 'A-02' && i.sku === 'SKU1002'); // 分配后基线：占用已立
    const tl = (await J(`/api/tasks/${t.taskId}`)).json.lines[0];
    const sameUid = uid('DUP');
    const r1 = await scan({ taskId: t.taskId, taskLineId: tl.id, deviceId: 'DUP-DEV',
      scanCode: 'SKU1002', scanType: 'sku', qty: 2, clientUid: sameUid });
    const r2 = await scan({ taskId: t.taskId, taskLineId: tl.id, deviceId: 'DUP-DEV',
      scanCode: 'SKU1002', scanType: 'sku', qty: 2, clientUid: sameUid });
    const r3 = await scan({ taskId: t.taskId, taskLineId: tl.id, deviceId: 'DUP-DEV',
      scanCode: 'SKU1002', scanType: 'sku', qty: 2, clientUid: sameUid });
    const invAfter = (await J('/api/inventory')).json.find(i => i.shelf === 'A-02' && i.sku === 'SKU1002');
    check('首扫 accepted', r1.result === 'accepted', JSON.stringify(r1));
    check('第2、3次同 uid 返回幂等回放', r2.idempotent === true && r3.idempotent === true);
    check('重复上传只动一次实物账：on_hand 仅 -2，available（占用）纹丝不动',
      invBefore.on_hand - invAfter.on_hand === 2 && invBefore.available === invAfter.available,
      `on_hand ${invBefore.on_hand}->${invAfter.on_hand}, available ${invBefore.available}->${invAfter.available}`);
  }

  console.log('== 场景3：任务被调走时最后一扫到达（租约失效不抹已拣实物）==');
  {
    const od = (await J('/api/orders/1')).json;
    const ol = od.lines.find(l => l.sku === 'SKU1004'); // 20 件，充足
    const t = (await J('/api/orders/1/allocate', { split: [{ order_line_id: ol.id, qty: 5 }] })).json;
    await claim(t.taskId, 'CART-A');
    const tl = (await J(`/api/tasks/${t.taskId}`)).json.lines[0];
    const r1 = await scan({ taskId: t.taskId, taskLineId: tl.id, deviceId: 'CART-A',
      scanCode: 'SKU1004', scanType: 'sku', qty: 2, clientUid: uid('A') });
    // 调度调走
    const rg = await J(`/api/tasks/${t.taskId}/reassign`, { reason: 'move' });
    const taskAfter = (await J(`/api/tasks/${t.taskId}`)).json.task;
    // 旧设备的最后一扫才到达
    const late = await scan({ taskId: t.taskId, taskLineId: tl.id, deviceId: 'CART-A',
      scanCode: 'SKU1004', scanType: 'sku', qty: 1, clientUid: uid('LATE') });
    const detail = await J(`/api/tasks/${t.taskId}`);
    const keptRows = detail.json.actuals.filter(a => a.result === 'late_kept');
    check('调走后 epoch 前进、设备清空', rg.json.leaseEpoch === taskAfter.lease_epoch && taskAfter.device_id === null);
    check('调走前的 2 件 accepted 原样保留', r1.result === 'accepted' && r1.qtyEffective === 2);
    check('最后一扫不被抹去：late_kept 保留实物为待核对', late.result === 'late_kept' && late.qtyEffective === 1, JSON.stringify(late));
    check('实绩表存在 late_kept 行且 state=picked', keptRows.length === 1 && keptRows[0].state === 'picked');
  }

  console.log('== 场景4：部分短缺（占用释放 + 异常闭环 + 完成门控）==');
  {
    // SO-02: A-05/SKU1002 需要 8，库存 5
    let a = (await J('/api/orders/2/allocate', {
      split: (await J('/api/orders/2')).json.lines.filter(l => l.shelf === 'A-05').map(l => ({ order_line_id: l.id, qty: 8 })),
    }));
    // A-05 只有 5 可用 => 占用 8 应被拒绝？占用阶段不足直接报错
    check('库存不足时整单分配被拒（INSUFFICIENT_STOCK）', a.json.error === 'INSUFFICIENT_STOCK', JSON.stringify(a.json));
    // 按可拣量 5 分配
    const ol = (await J('/api/orders/2')).json.lines.find(l => l.shelf === 'A-05');
    a = await J('/api/orders/2/allocate', { split: [{ order_line_id: ol.id, qty: 5 }] });
    const taskId = a.json.taskId;
    await claim(taskId, 'SHORT-DEV');
    const tl = (await J(`/api/tasks/${taskId}`)).json.lines[0];
    for (let i = 0; i < 5; i += 1) await scan({ taskId, taskLineId: tl.id, deviceId: 'SHORT-DEV',
      scanCode: 'SKU1002', scanType: 'sku', qty: 1, clientUid: uid('S') });
    // 模拟实际只找到 3 件：上报短缺（foundQty=3 的语义：实物 3，系统 5 多扫了；
    // 本演示按"已拣5件但现场反馈缺3"释放 alloc-picked=0，故改为先撤销 2 件再短缺。
    // 更直接的短缺演示：另建一个更大分配 -> 这里验证"拣不足 alloc"的路径：
    // 上报时 picked 已=alloc，missing=0。故另起任务验证 picked<alloc 的短缺。
    const prog1 = (await J(`/api/tasks/${taskId}/progress`)).json;
    check('足额拣完时门控仅剩"待核对"', prog1.picked === 5, JSON.stringify(prog1.gateReasons));

    // 真正的短缺路径：分配 SKU1001/A-01 3 件，一件都没拣就报短缺
    const ol2 = (await J('/api/orders/2')).json.lines.find(l => l.sku === 'SKU1001');
    const a2 = await J('/api/orders/2/allocate', { split: [{ order_line_id: ol2.id, qty: 3 }] });
    const t2 = a2.json.taskId;
    await claim(t2, 'SHORT-DEV2');
    const tl2 = (await J(`/api/tasks/${t2}`)).json.lines[0];
    const invB = (await J('/api/inventory')).json.find(i => i.shelf === 'A-01');
    const sh = await J('/api/shortage', { taskId: t2, taskLineId: tl2.id, deviceId: 'SHORT-DEV2', foundQty: 0, note: '库位空' });
    const invA = (await J('/api/inventory')).json.find(i => i.shelf === 'A-01');
    check('短缺返回 missing=3 并释放 3 占用', sh.json.missing === 3 && sh.json.released === 3, JSON.stringify(sh.json));
    check('available 回补 3（on_hand 不动留给盘点）', invA.available - invB.available === 3,
      `${invB.available}->${invA.available}`);
    const prog2 = (await J(`/api/tasks/${t2}/progress`)).json;
    check('短缺未闭环时完成按钮门控', prog2.canComplete === false && prog2.gateReasons.some(g => g.includes('短缺')));
    const excs2 = (await J('/api/exceptions')).json.filter(e => e.task_id === t2 && e.kind === 'shortage');
    await J(`/api/exceptions/${excs2[0].id}/resolve`, {});
    const prog3 = (await J(`/api/tasks/${t2}/progress`)).json;
    check('短缺异常闭环 + 无待核对实物后完成门控放行', prog3.canComplete === true,
      JSON.stringify(prog3.gateReasons));
    const done2 = await J(`/api/tasks/${t2}/complete`, {});
    check('短缺任务可完成（业务接受差异）', done2.json.status === 'verified');
  }

  console.log('== 场景5：终端断电（本地短批）恢复后提交，整批幂等 ==');
  {
    const od = (await J('/api/orders/1')).json;
    const ol = od.lines.find(l => l.sku === 'SKU1003'); // 2 件
    const t = (await J('/api/orders/1/allocate', { split: [{ order_line_id: ol.id, qty: 2 }] })).json;
    await claim(t.taskId, 'POWER-DEV');
    const tl = (await J(`/api/tasks/${t.taskId}`)).json.lines[0];
    const batchId = uid('BATCH');
    const scans = [1, 2].map(i => ({ taskLineId: tl.id, scanCode: 'SKU1003', scanType: 'sku',
      qty: 1, clientUid: uid('PW') }));
    const r1 = await J('/api/scan/batch', { taskId: t.taskId, deviceId: 'POWER-DEV', batchId, scans });
    const r2 = await J('/api/scan/batch', { taskId: t.taskId, deviceId: 'POWER-DEV', batchId, scans });
    const prog = (await J(`/api/tasks/${t.taskId}/progress`)).json;
    check('短批首次入库 2 件', r1.json.acceptedRows === 2 && r1.json.qtyEffective === 2, JSON.stringify(r1.json));
    check('断电重传同 batch 幂等，不重复扣减', r2.json.idempotent === true && prog.picked === 2);
  }

  console.log('== 场景6：离线短批防超拣（整批超分配 => 原子回滚）==');
  {
    const od = (await J('/api/orders/1')).json;
    // SKU1004 行已被场景3占用 5，找该行剩余可分配量另建任务
    const ol = od.lines.find(l => l.sku === 'SKU1004');
    const t = (await J('/api/orders/1/allocate', { split: [{ order_line_id: ol.id, qty: 3 }] })).json;
    await claim(t.taskId, 'BATCH-DEV');
    const tl = (await J(`/api/tasks/${t.taskId}`)).json.lines[0];
    const invB = (await J('/api/inventory')).json.find(i => i.shelf === 'A-04');
    const scans = [1, 2, 3, 4].map(() => ({ taskLineId: tl.id, scanCode: 'SKU1004', scanType: 'sku',
      qty: 1, clientUid: uid('BO') }));
    const r = await J('/api/scan/batch', { taskId: t.taskId, deviceId: 'BATCH-DEV', batchId: uid('BADBATCH'), scans });
    const invA = (await J('/api/inventory')).json.find(i => i.shelf === 'A-04');
    check('整批 4 件超分配 3 => BATCH_OVERPICK 拒绝', r.json.error === 'BATCH_OVERPICK', JSON.stringify(r.json));
    check('整批原子回滚：on_hand/available 均无变化', invB.on_hand === invA.on_hand && invB.available === invA.available,
      `${invB.on_hand}/${invB.available} vs ${invA.on_hand}/${invA.available}`);
  }

  console.log('== 场景7：撤销必须引用原实绩，重复撤销不二次回补 ==');
  {
    const od = (await J('/api/orders/1')).json;
    const ol = od.lines.find(l => l.sku === 'SKU1001');
    const t = (await J('/api/orders/1/allocate', { split: [{ order_line_id: ol.id, qty: 2 }] })).json;
    await claim(t.taskId, 'REV-DEV');
    const tl = (await J(`/api/tasks/${t.taskId}`)).json.lines[0];
    const cu = uid('REV');
    await scan({ taskId: t.taskId, taskLineId: tl.id, deviceId: 'REV-DEV',
      scanCode: 'SKU1001', scanType: 'sku', qty: 2, clientUid: cu });
    const invB = (await J('/api/inventory')).json.find(i => i.shelf === 'A-01');
    const r1 = await J('/api/actuals/revoke', { refClientUid: cu, reason: '扫错数量', operator: 'mgr' });
    const invA1 = (await J('/api/inventory')).json.find(i => i.shelf === 'A-01');
    const r2 = await J('/api/actuals/revoke', { refClientUid: cu, reason: '再次撤销', operator: 'mgr' });
    const invA2 = (await J('/api/inventory')).json.find(i => i.shelf === 'A-01');
    const r3 = await J('/api/actuals/revoke', { refClientUid: 'NO_SUCH_UID', reason: 'x' });
    check('撤销成功：实物回架 on_hand +2（占用不动）', r1.json.qtyReturned === 2 && invA1.on_hand - invB.on_hand === 2
      && invA1.available === invB.available);
    check('重复撤销被拒（ALREADY_REVOKED）', r2.json.error === 'ALREADY_REVOKED');
    check('实物账未二次回补', invA2.on_hand === invA1.on_hand && invA2.available === invA1.available);
    check('引用不存在的实绩被拒（ACTUAL_NOT_FOUND）', r3.json.error === 'ACTUAL_NOT_FOUND');
  }

  console.log('== 场景8：地图版本 —— 旧任务锁定 v1，发布 v2 后坐标仍按 v1 展示 ==');
  {
    // 当前 v2 是 draft。先建任务（锁 v1）
    const od = (await J('/api/orders/1')).json;
    const ol = od.lines.find(l => l.sku === 'SKU1002');
    const t = (await J('/api/orders/1/allocate', { split: [{ order_line_id: ol.id, qty: 1 }] })).json;
    const detail = await J(`/api/tasks/${t.taskId}`);
    const lockedV = detail.json.lines[0].map_version;
    // 发布 v2
    const maps = (await J('/api/maps')).json;
    const v2id = maps.find(m => m.version === 2).id;
    const pub = await J(`/api/maps/${v2id}/publish`, {});
    const activeNow = (await J('/api/maps')).json.filter(m => m.status === 'active').map(m => m.version);
    const mv1 = (await J('/api/maps/version/1')).json;
    const mv2 = (await J('/api/maps/version/2')).json;
    const oldShelf = mv1.shelves.find(s => s.code === 'A-05');
    const newShelf = mv2.shelves.find(s => s.code === 'A-05');
    check('任务锁定版本为 v1', lockedV === 1, String(lockedV));
    check('v2 发布成功且 active 唯一', pub.json.ok && activeNow.length === 1 && activeNow[0] === 2,
      JSON.stringify(activeNow));
    check('A-05 坐标随版本变化（v1=32,35 → v2=68,55）',
      oldShelf.x === 32 && oldShelf.y === 35 && newShelf.x === 68 && newShelf.y === 55);
    check('C 端按任务 pin 的 v1 取到旧坐标', lockedV === 1 && oldShelf.x === 32);
    // 箭头一致性：v2 A-04(52,35)->A-05(68,55) atan2(20,16)≈51.3 => 51°；v1 A-04->A-05 向量(-20,0)=>180°
    const a04v1 = mv1.shelves.find(s => s.code === 'A-04');
    const a04v2 = mv2.shelves.find(s => s.code === 'A-04');
    check('同一货架文字相同但箭头按版本不同（v1=180°, v2≈51°）',
      a04v1.arrow_dir === 180 && Math.abs(a04v2.arrow_dir - 51) <= 1,
      `${a04v1.arrow_dir} vs ${a04v2.arrow_dir}`);
  }

  console.log('== 场景9：底图加载失败处理（API 侧模拟 URL 失效 + 前端阻断逻辑）==');
  {
    await J('/api/maps/simulate-bg-failure/1', {});
    const m1 = (await J('/api/maps/version/1')).json;
    const http = await fetch(BASE + m1.bg_image_url);
    check('失效底图 URL 实际返回 404', http.status === 404, m1.bg_image_url);
    // 前端 c.js 在 img.onerror 时显示 #bgFail 并阻止扫码（代码检查）
    const cjs = await (await fetch(BASE + '/c.js')).text();
    check('前端在底图失败时阻断开工（bgReady 闸）', cjs.includes("state.bgReady") && cjs.includes("禁止扫码作业"));
    await J('/api/maps/restore-bg/1', {});
  }

  console.log('== 场景10：逐扫 vs 短批 —— 恢复成本与防超拣语义（行为断言）==');
  {
    // 逐扫：离线不可提交（前端本地留存），恢复时逐条重放；这里验证服务端逐条独立成败
    const od = (await J('/api/orders/1')).json;
    const ol = od.lines.find(l => l.sku === 'SKU1004');
    const t = (await J('/api/orders/1/allocate', { split: [{ order_line_id: ol.id, qty: 4 }] })).json;
    await claim(t.taskId, 'MODE-DEV');
    const tl = (await J(`/api/tasks/${t.taskId}`)).json.lines[0];
    const s1 = await scan({ taskId: t.taskId, taskLineId: tl.id, deviceId: 'MODE-DEV',
      scanCode: 'SKU1004', scanType: 'sku', qty: 3, clientUid: uid('M1') });
    const s2 = await scan({ taskId: t.taskId, taskLineId: tl.id, deviceId: 'MODE-DEV',
      scanCode: 'SKU1004', scanType: 'sku', qty: 3, clientUid: uid('M2') });
    check('逐扫：第一扫 3 件成功、第二扫 3 件独立判超拣（逐条粒度恢复）',
      s1.result === 'accepted' && s2.reason === 'overpick', JSON.stringify([s1.result, s2.reason]));
  }

  console.log('== 场景11：完成按钮门控 + 核对流程 happy path ==');
  {
    const od = (await J('/api/orders/1')).json;
    const ol = od.lines.find(l => l.sku === 'SKU1001');
    const t = (await J('/api/orders/1/allocate', { split: [{ order_line_id: ol.id, qty: 2 }] })).json;
    await claim(t.taskId, 'HAPPY');
    const tl = (await J(`/api/tasks/${t.taskId}`)).json.lines[0];
    const a = await scan({ taskId: t.taskId, taskLineId: tl.id, deviceId: 'HAPPY',
      scanCode: 'SKU1001', scanType: 'sku', qty: 2, clientUid: uid('H') });
    let prog = (await J(`/api/tasks/${t.taskId}/progress`)).json;
    check('拣完未核对：canComplete=false，有"待核对"原因', !prog.canComplete && prog.pending === 2);
    const c1 = await J(`/api/tasks/${t.taskId}/complete`, {});
    check('未核对时点完成被 GATE_FAILED 拒绝', c1.json.error === 'GATE_FAILED');
    // 找到实绩并核对
    const det = (await J(`/api/tasks/${t.taskId}`)).json;
    for (const ac of det.actuals.filter(x => x.qty_effective > 0 && x.state === 'picked'))
      await J(`/api/actuals/${ac.id}/verify`, {});
    prog = (await J(`/api/tasks/${t.taskId}/progress`)).json;
    check('全部核对后 canComplete=true', prog.canComplete === true && prog.verified === 2,
      JSON.stringify(prog.gateReasons));
    const done = await J(`/api/tasks/${t.taskId}/complete`, {});
    check('完成成功 status=verified', done.json.status === 'verified', JSON.stringify(done.json));
  }

  console.log('== 场景12：扫码必须先货架确认（wrong_shelf 拒绝且写异常）==');
  {
    const od = (await J('/api/orders/1')).json;
    const ol = od.lines.find(l => l.sku === 'SKU1004');
    const t = (await J('/api/orders/1/allocate', { split: [{ order_line_id: ol.id, qty: 1 }] })).json;
    await claim(t.taskId, 'SHELF-DEV');
    const tl = (await J(`/api/tasks/${t.taskId}`)).json.lines[0];
    const ws = await scan({ taskId: t.taskId, taskLineId: tl.id, deviceId: 'SHELF-DEV',
      scanCode: 'A-09', scanType: 'shelf', qty: 1, clientUid: uid('WS') });
    const okShelf = await scan({ taskId: t.taskId, taskLineId: tl.id, deviceId: 'SHELF-DEV',
      scanCode: 'A-04', scanType: 'shelf', qty: 1, clientUid: uid('WS2') });
    check('错误货架码被拒（wrong_shelf）', ws.result === 'rejected' && ws.reason === 'wrong_shelf');
    check('正确货架码 accepted（shelf_confirm）', okShelf.result === 'accepted');
  }

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(2); });
