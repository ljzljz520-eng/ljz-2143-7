// 核心业务服务：所有写操作都在 better-sqlite3 同步事务内，保证
//  "判断可用量 + 扣减 + 写实绩" 原子提交，杜绝并发超拣。
const crypto = require('crypto');

const LEASE_MS = Number(process.env.LEASE_MS || 120_000); // 租约 2 分钟，可配置
const now = () => new Date();
const iso = d => d.toISOString().replace('T', ' ').slice(0, 19);
const uid = p => `${p}_${crypto.randomBytes(6).toString('hex')}`;

class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status; this.code = code; this.extra = extra;
  }
}

function createServices(db) {
  // ---------- 工具 ----------
  const log = (actor, action, detail) =>
    db.prepare('INSERT INTO op_log(actor,action,detail) VALUES(?,?,?)')
      .run(actor || null, action, detail ? JSON.stringify(detail) : null);
  const exc = (taskId, deviceId, kind, detail) =>
    db.prepare('INSERT INTO exception_log(task_id,device_id,kind,detail) VALUES(?,?,?,?)')
      .run(taskId || null, deviceId || null, kind, detail ? JSON.stringify(detail) : null);

  function getTask(id) {
    const t = db.prepare('SELECT * FROM pick_task WHERE id=?').get(id);
    if (!t) throw new ApiError(404, 'TASK_NOT_FOUND', '任务不存在');
    return t;
  }
  function leaseAlive(task, at = now()) {
    return task.lease_until && iso(at) < task.lease_until;
  }

  // ---------- 地图：发布 / 校验图文一致 ----------
  // 关键：箭头角度 arrow_dir 在发布时已与 shelf 坐标、动线 seq 同源计算并入库；
  // 客户端只渲染同一行的 (文字code, x,y, arrow)，服务端再做一致性校验，
  // 任何"文字坐标正确但箭头指向错误"的草稿都拒绝发布，避免投放到执行端。
  function publishMap(versionId, actor) {
    const map = db.prepare('SELECT * FROM map_version WHERE id=?').get(versionId);
    if (!map) throw new ApiError(404, 'MAP_NOT_FOUND', '地图版本不存在');
    const shelves = db.prepare(
      'SELECT * FROM map_shelf WHERE map_id=? ORDER BY id').all(versionId);
    if (shelves.length < 2) throw new ApiError(400, 'MAP_INVALID', '至少需要两个货架');

    const tx = db.transaction(() => {
      // 重算每个箭头并与库内 arrow_dir 比对，不一致则拒绝（防止人工改坏箭头）
      const bySeq = new Map(shelves.map(s => [s.shelf_code, s]));
      for (let i = 0; i < shelves.length; i += 1) {
        const cur = shelves[i];
        const nxt = shelves[i + 1];
        let expect = null;
        if (nxt) {
          let deg = Math.atan2(nxt.y - cur.y, nxt.x - cur.x) * 180 / Math.PI;
          if (deg < 0) deg += 360;
          expect = Math.round(deg);
        }
        if (expect !== null && cur.arrow_dir !== expect) {
          throw new ApiError(409, 'ARROW_MISMATCH',
            `货架 ${cur.shelf_code} 箭头角度 ${cur.arrow_dir} 与坐标推算 ${expect} 不一致，禁止发布`);
        }
        if (cur.x < 0 || cur.x > 100 || cur.y < 0 || cur.y > 100) {
          throw new ApiError(400, 'MAP_INVALID', `货架 ${cur.shelf_code} 坐标越界`);
        }
      }
      db.prepare("UPDATE map_version SET status='retired' WHERE zone_code=? AND status='active'")
        .run(map.zone_code);
      db.prepare("UPDATE map_version SET status='active' WHERE id=?").run(versionId);
      log(actor, 'map_publish', { version: map.version });
    });
    tx();
    return { ok: true, version: map.version };
  }

  function getMapForVersion(version) {
    const map = db.prepare('SELECT * FROM map_version WHERE version=?').get(version);
    if (!map) throw new ApiError(404, 'MAP_NOT_FOUND', `地图版本 ${version} 不存在`);
    const shelves = db.prepare(
      'SELECT shelf_code code,x,y,arrow_dir,arrow_from FROM map_shelf WHERE map_id=? ORDER BY id')
      .all(map.id);
    return { ...map, shelves };
  }
  function activeVersion(zone = 'A') {
    const m = db.prepare("SELECT * FROM map_version WHERE zone_code=? AND status='active' ORDER BY version DESC LIMIT 1").get(zone);
    if (!m) throw new ApiError(409, 'NO_ACTIVE_MAP', '该分区没有已发布地图');
    return m;
  }

  // ---------- 调度：订单拆单、占用库存、分配到任务（可跨设备）----------
  function allocateOrder(orderId, splitSpec, actor) {
    const order = db.prepare('SELECT * FROM biz_order WHERE id=?').get(orderId);
    if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', '订单不存在');
    if (order.status === 'cancelled') throw new ApiError(409, 'ORDER_CANCELLED', '订单已取消');

    const lines = db.prepare('SELECT * FROM order_line WHERE order_id=?').all(orderId);
    const spec = splitSpec && splitSpec.length
      ? splitSpec
      : lines.map(l => ({ order_line_id: l.id, qty: l.qty_plan })); // 不拆 => 整单一个任务

    const active = activeVersion();
    const taskNo = uid('TASK');
    const result = { taskNo, mapVersion: active.version, rows: [] };

    const tx = db.transaction(() => {
      // 校验每个拆分行：数量合法且不超订单行、不重复分配超计划
      for (const s of spec) {
        const ol = lines.find(l => l.id === s.order_line_id);
        if (!ol) throw new ApiError(400, 'BAD_SPLIT', `订单行 ${s.order_line_id} 不属于该订单`);
        if (!Number.isInteger(s.qty) || s.qty <= 0)
          throw new ApiError(400, 'BAD_SPLIT', '拆分量必须为正整数');
        const already = db.prepare(
          'SELECT COALESCE(SUM(qty_alloc),0) a FROM task_line tl JOIN pick_task t ON t.id=tl.task_id WHERE tl.order_line_id=? AND t.status<>\'cancelled\'')
          .get(ol.id).a;
        if (already + s.qty > ol.qty_plan)
          throw new ApiError(409, 'OVER_ALLOC', `订单行 ${ol.sku} 计划 ${ol.qty_plan}，已分配 ${already}，不能再分 ${s.qty}`);

        // 库存占用：available 原子扣减；不足则整单回滚
        const inv = db.prepare('SELECT * FROM inventory WHERE shelf=? AND sku=?').get(ol.shelf, ol.sku);
        const have = inv ? inv.available : 0;
        if (have < s.qty)
          throw new ApiError(409, 'INSUFFICIENT_STOCK',
            `${ol.shelf}/${ol.sku} 可用 ${have}，不足以占用 ${s.qty}`, { available: have, need: s.qty });
        const r = db.prepare('UPDATE inventory SET available=available-? WHERE shelf=? AND sku=? AND available>=?')
          .run(s.qty, ol.shelf, ol.sku, s.qty);
        if (r.changes !== 1) throw new ApiError(409, 'INSUFFICIENT_STOCK', '并发占用冲突');
        result.rows.push({ orderLineId: ol.id, shelf: ol.shelf, sku: ol.sku, qty: s.qty });
      }
      const taskId = db.prepare(
        'INSERT INTO pick_task(task_no,order_id,status,lease_epoch) VALUES(?,?,\'queued\',0)')
        .run(taskNo, orderId).lastInsertRowid;
      const insTL = db.prepare(
        'INSERT INTO task_line(task_id,order_line_id,sku,shelf,qty_alloc,map_version,seq) VALUES(?,?,?,?,?,?,?)');
      // 动线 seq：按该地图版本货架顺序
      const shelves = db.prepare('SELECT shelf_code FROM map_shelf WHERE map_id=? ORDER BY id').all(active.id)
        .map(s => s.shelf_code);
      result.rows.forEach((row, i) => {
        const seq = shelves.indexOf(row.shelf) + 1;
        insTL.run(taskId, row.orderLineId, row.sku, row.shelf, row.qty, active.version, seq || i + 1);
      });
      db.prepare("UPDATE biz_order SET status='picking' WHERE id=? AND status='open'").run(orderId);
      log(actor, 'allocate', { taskNo, orderNo: order.order_no, rows: result.rows });
      result.taskId = taskId;
    });
    tx();
    return result;
  }

  // ---------- 租约：领取 / 心跳续租 / 调度调走 ----------
  function claimTask(taskId, deviceId, actor) {
    const task = getTask(taskId);
    return db.transaction(() => {
      if (task.device_id && task.device_id !== deviceId && leaseAlive(task))
        throw new ApiError(409, 'TASK_BUSY', `任务正被 ${task.device_id} 持有且租约有效`);
      const epoch = task.lease_epoch + 1;
      const until = new Date(now().getTime() + LEASE_MS);
      db.prepare('UPDATE pick_task SET device_id=?,status=\'leased\',lease_until=?,lease_epoch=? WHERE id=?')
        .run(deviceId, iso(until), epoch, taskId);
      log(actor || deviceId, 'claim', { taskId, epoch });
      return { taskId, deviceId, leaseEpoch: epoch, leaseUntil: iso(until), leaseMs: LEASE_MS };
    })();
  }

  function heartbeat(taskId, deviceId) {
    const task = getTask(taskId);
    if (task.device_id !== deviceId) throw new ApiError(403, 'NOT_OWNER', '任务不属于该设备');
    const until = new Date(now().getTime() + LEASE_MS);
    db.prepare('UPDATE pick_task SET lease_until=?,status= CASE WHEN status=\'queued\' THEN \'leased\' ELSE status END WHERE id=?')
      .run(iso(until), taskId);
    return { taskId, leaseUntil: iso(until), leaseEpoch: task.lease_epoch, leaseMs: LEASE_MS, alive: true };
  }

  // 调度主动调走：租约立即失效（epoch 前进），但已 accepted/late_kept 实绩原样保留
  function revokeLease(taskId, reason, actor) {
    const task = getTask(taskId);
    return db.transaction(() => {
      const epoch = task.lease_epoch + 1;
      db.prepare('UPDATE pick_task SET device_id=NULL,lease_until=NULL,lease_epoch=?,status=\'queued\' WHERE id=?')
        .run(epoch, taskId);
      exc(taskId, null, 'lease_expired', { reason: reason || 'dispatcher_reassigned', oldDevice: task.device_id });
      log(actor, 'lease_revoke', { taskId, oldEpoch: task.lease_epoch, newEpoch: epoch });
      return { taskId, leaseEpoch: epoch, reassigned: true };
    })();
  }

  // ---------- 单条扫码（逐扫确认模式）----------
  // client_uid 幂等；连扣带写在一个事务内；租约失效不抹已拣：新到的扫标 late_*。
  function submitScan(payload, actor) {
    const { taskId, taskLineId, deviceId, scanCode, scanType, qty = 1, clientUid, batchId = null } = payload;
    if (!taskId || !taskLineId || !deviceId || !scanCode || !scanType || !clientUid)
      throw new ApiError(400, 'BAD_REQUEST', '缺少必填扫码字段');

    // 幂等：扫描枪连发 / 重试 / 断电重传，同一 client_uid 直接回放原结果
    const dup = db.prepare('SELECT * FROM pick_actual WHERE client_uid=?').get(clientUid);
    if (dup) {
      return { idempotent: true, result: dup.result, qtyEffective: dup.qty_effective,
        state: dup.state, reason: dup.reject_reason || null };
    }

    return db.transaction(() => {
      const task = getTask(taskId);
      const line = db.prepare('SELECT * FROM task_line WHERE id=? AND task_id=?').get(taskLineId, taskId);
      if (!line) throw new ApiError(404, 'LINE_NOT_FOUND', '任务行不存在');

      const alive = leaseAlive(task) && task.device_id === deviceId;
      const epochAtScan = task.lease_epoch;

      const insertActual = (result, reason, qtyEff, state = 'picked') =>
        db.prepare(`INSERT INTO pick_actual
          (task_id,task_line_id,device_id,lease_epoch,scan_code,scan_type,qty,client_uid,batch_id,result,reject_reason,qty_effective,state)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(taskId, taskLineId, deviceId, epochAtScan, scanCode, scanType, qty,
               clientUid, batchId, result, reason, qtyEff, state).lastInsertRowid;

      // 1) 扫的是货架码：必须与任务行货架一致
      if (scanType === 'shelf') {
        if (scanCode !== line.shelf) {
          insertActual('rejected', 'wrong_shelf', 0, 'picked');
          exc(taskId, deviceId, 'wrong_shelf', { expect: line.shelf, got: scanCode, lineId: taskLineId });
          return { result: 'rejected', reason: 'wrong_shelf', expectShelf: line.shelf };
        }
        return { result: 'accepted', kind: 'shelf_confirm', qtyEffective: 0 };
      }

      // 2) SKU 扫码：先过租约，再校验防超拣（已拣有效量 + 本次 <= 分配量；available 也要够）
      if (!alive) {
        // 租约失效：任务被调走/过期。关键业务判断——
        // 若实物确实已拣且本行仍未被其它设备拣满（系统可用量还够），保留为 late_kept，
        // 不抹实物；若已被别的租约拣走/分配量已满，则 late_rejected 交异常处理。
        const picked = db.prepare(
          "SELECT COALESCE(SUM(qty_effective),0) n FROM pick_actual WHERE task_line_id=? AND result IN ('accepted','late_kept') AND state<>'revoked'")
          .get(taskLineId).n;
        const stillRoom = picked + qty <= line.qty_alloc;
        const inv = db.prepare('SELECT on_hand FROM inventory WHERE shelf=? AND sku=?').get(line.shelf, line.sku);
        const stockOk = inv && inv.on_hand >= qty;
        if (stillRoom && stockOk) {
          // 实物确实拣出：on_hand 减少；该量在分配时已占用，available 不变
          db.prepare('UPDATE inventory SET on_hand=on_hand-? WHERE shelf=? AND sku=? AND on_hand>=?')
            .run(qty, line.shelf, line.sku, qty);
          insertActual('late_kept', 'lease_expired_at_scan', qty);
          exc(taskId, deviceId, 'late_scan', { clientUid, lineId: taskLineId, qty, decision: 'kept' });
          return { result: 'late_kept', reason: 'lease_expired_at_scan', qtyEffective: qty,
            warning: '租约已失效；本扫实物保留为待核对，请与调度确认' };
        }
        insertActual('late_rejected', 'lease_expired_no_room', 0);
        exc(taskId, deviceId, 'late_scan', { clientUid, lineId: taskLineId, qty, decision: 'rejected' });
        return { result: 'late_rejected', reason: 'lease_expired_no_room',
          warning: '租约失效且该位已拣满/被调走，物料请暂挂异常区待核对' };
      }

      if (scanCode !== line.sku) {
        insertActual('rejected', 'wrong_sku', 0);
        return { result: 'rejected', reason: 'wrong_sku', expectSku: line.sku };
      }

      const picked = db.prepare(
        "SELECT COALESCE(SUM(qty_effective),0) n FROM pick_actual WHERE task_line_id=? AND result IN ('accepted','late_kept') AND state<>'revoked'")
        .get(taskLineId).n;
      if (picked + qty > line.qty_alloc) {
        insertActual('rejected', 'overpick', 0);
        exc(taskId, deviceId, 'overpick', { lineId: taskLineId, alloc: line.qty_alloc, picked, qty });
        return { result: 'rejected', reason: 'overpick', alloc: line.qty_alloc, picked };
      }
      const upd = db.prepare('UPDATE inventory SET on_hand=on_hand-? WHERE shelf=? AND sku=? AND on_hand>=?')
        .run(qty, line.shelf, line.sku, qty);
      if (upd.changes !== 1) {
        insertActual('rejected', 'out_of_stock', 0);
        exc(taskId, deviceId, 'shortage', { lineId: taskLineId, qty });
        return { result: 'rejected', reason: 'out_of_stock' };
      }
      const id = insertActual('accepted', null, qty);
      if (task.status === 'leased')
        db.prepare("UPDATE pick_task SET status='picking' WHERE id=?").run(taskId);
      return { result: 'accepted', actualId: id, qtyEffective: qty, pickedAfter: picked + qty, alloc: line.qty_alloc };
    })();
  }

  // ---------- 本地短批提交（离线攒批，恢复后一批上传）----------
  // 终端在离线时只按"分配量"本地计数防超拣（见前端），上线后整批提交；
  // 服务端逐行在同一事务复核：任何一行超分配/超可用量 => 整批拒绝(回滚)，
  // 与逐扫相比恢复成本：一批要么全进要么全不进，冲突时需要人工决定整批去向。
  function submitBatch(payload, actor) {
    const { taskId, deviceId, batchId, scans } = payload;
    if (!taskId || !deviceId || !batchId || !Array.isArray(scans) || !scans.length)
      throw new ApiError(400, 'BAD_REQUEST', '批次字段不完整');
    // 整批幂等：batch_id 下已有任一记录 => 回放
    const existed = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(qty_effective),0) q FROM pick_actual WHERE batch_id=?').get(batchId);
    if (existed.c > 0) return { idempotent: true, batchId, acceptedRows: existed.c, qtyEffective: existed.q };

    return db.transaction(() => {
      const task = getTask(taskId);
      const alive = leaseAlive(task) && task.device_id === deviceId;
      // 批次内按行累加
      const perLine = new Map();
      for (const s of scans) {
        if (s.scanType !== 'sku' || !s.taskLineId)
          throw new ApiError(400, 'BAD_BATCH', '批次仅接受含任务行的 SKU 扫描');
        const k = s.taskLineId;
        perLine.set(k, (perLine.get(k) || 0) + (s.qty || 1));
      }
      const lineStmt = db.prepare('SELECT * FROM task_line WHERE id=? AND task_id=?');
      const pickedStmt = db.prepare(
        "SELECT COALESCE(SUM(qty_effective),0) n FROM pick_actual WHERE task_line_id=? AND result IN ('accepted','late_kept') AND state<>'revoked'");

      // 预检：全部行通过才写入（原子）
      for (const [lineId, batchQty] of perLine) {
        const line = lineStmt.get(lineId, taskId);
        if (!line) throw new ApiError(404, 'LINE_NOT_FOUND', `任务行 ${lineId} 不存在`);
        const already = pickedStmt.get(lineId).n;
        if (already + batchQty > line.qty_alloc)
          throw new ApiError(409, 'BATCH_OVERPICK',
            `行 ${lineId} 分配 ${line.qty_alloc}，已拣 ${already}，本批 ${batchQty} 超拣`,
            { lineId, alloc: line.qty_alloc, already, batchQty });
        const inv = db.prepare('SELECT on_hand FROM inventory WHERE shelf=? AND sku=?').get(line.shelf, line.sku);
        if (!inv || inv.on_hand < batchQty)
          throw new ApiError(409, 'BATCH_SHORTAGE',
            `行 ${lineId} 实物库存不足`, { lineId, onHand: inv ? inv.on_hand : 0, batchQty });
      }

      let kept = 0; let effective = 0;
      const ins = db.prepare(`INSERT INTO pick_actual
        (task_id,task_line_id,device_id,lease_epoch,scan_code,scan_type,qty,client_uid,batch_id,result,reject_reason,qty_effective,state)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const s of scans) {
        if (db.prepare('SELECT 1 FROM pick_actual WHERE client_uid=?').get(s.clientUid)) continue; // 单条幂等
        const line = lineStmt.get(s.taskLineId, taskId);
        const qty = s.qty || 1;
        // 离线期间租约可能正好过期：沿用 late_kept 规则（预检已保证有位有货）
        const result = alive ? 'accepted' : 'late_kept';
        const reason = alive ? null : 'lease_expired_at_batch';
        if (result === 'late_kept') exc(taskId, deviceId, 'late_scan', { batchId, decision: 'batch_kept' });
        db.prepare('UPDATE inventory SET on_hand=on_hand-? WHERE shelf=? AND sku=? AND on_hand>=?')
          .run(qty, line.shelf, line.sku, qty);
        ins.run(taskId, s.taskLineId, deviceId, task.lease_epoch,
          s.scanCode, 'sku', qty, s.clientUid, batchId, result, reason, qty, 'picked');
        kept += 1; effective += qty;
      }
      if (!alive) exc(taskId, deviceId, 'power_loss_recovered', { batchId, note: '离线批次在租约失效后送达，已按待核对保留' });
      log(deviceId, 'batch_submit', { batchId, rows: kept });
      return { batchId, acceptedRows: kept, qtyEffective: effective, leaseAlive: alive };
    })();
  }

  // ---------- 部分短缺上报 ----------
  function reportShortage(payload, actor) {
    const { taskId, taskLineId, deviceId, foundQty, note } = payload;
    const task = getTask(taskId);
    return db.transaction(() => {
      const line = db.prepare('SELECT * FROM task_line WHERE id=? AND task_id=?').get(taskLineId, taskId);
      if (!line) throw new ApiError(404, 'LINE_NOT_FOUND', '任务行不存在');
      const picked = db.prepare(
        "SELECT COALESCE(SUM(qty_effective),0) n FROM pick_actual WHERE task_line_id=? AND result IN ('accepted','late_kept') AND state<>'revoked'")
        .get(taskLineId).n;
      const missing = line.qty_alloc - picked;
      // 释放"找不到"那部分的占用：available 加回（on_hand 不动，留给盘点）
      if (missing > 0) {
        // 实物找不到：解除占用（available 回补，on_hand 留给盘点调账）
        db.prepare('UPDATE inventory SET available=available+? WHERE shelf=? AND sku=?')
          .run(missing, line.shelf, line.sku);
      }
      const id = exc(taskId, deviceId || task.device_id, 'shortage',
        { lineId: taskLineId, alloc: line.qty_alloc, picked, foundQty: foundQty ?? picked, missing, note });
      return { exceptionId: Number(id), alloc: line.qty_alloc, picked, missing, released: Math.max(missing, 0) };
    })();
  }

  // ---------- 撤销：必须引用原实绩 ----------
  function revokeActual(payload, actor) {
    const { refClientUid, reason, operator } = payload;
    if (!refClientUid || !reason) throw new ApiError(400, 'BAD_REQUEST', '撤销必须引用原实绩 client_uid 且填写原因');
    return db.transaction(() => {
      const a = db.prepare('SELECT * FROM pick_actual WHERE client_uid=?').get(refClientUid);
      if (!a) throw new ApiError(404, 'ACTUAL_NOT_FOUND', '被引用的原实绩不存在');
      if (a.state === 'revoked') throw new ApiError(409, 'ALREADY_REVOKED', '该实绩已撤销，不能重复撤销');
      if (a.state === 'verified') throw new ApiError(409, 'ALREADY_VERIFIED', '已核对实绩不能直接撤销，先走差异处理');
      // 唯一凭证约束保证一条实绩只能被撤销一次；重复提交不会再次加回 available
      db.prepare("UPDATE pick_actual SET state='revoked' WHERE id=?").run(a.id);
      db.prepare('INSERT INTO revoke_voucher(actual_id,ref_actual_uid,reason,operator,qty_returned) VALUES(?,?,?,?,?)')
        .run(a.id, refClientUid, reason, operator || actor || null, a.qty_effective);
      if (a.qty_effective > 0)
        // 错扫撤销 = 实物回架；任务行未变，占用仍在 => on_hand 回补，available 不动
        db.prepare('UPDATE inventory SET on_hand=on_hand+? WHERE shelf=(SELECT shelf FROM task_line WHERE id=?) AND sku=(SELECT sku FROM task_line WHERE id=?)')
          .run(a.qty_effective, a.task_line_id, a.task_line_id);
      log(operator || actor, 'revoke', { refClientUid, qty: a.qty_effective, reason });
      return { revoked: refClientUid, qtyReturned: a.qty_effective };
    })();
  }

  // ---------- 管理：待核对 -> 已核对（实物核对）----------
  function verifyActual(actualId, actor) {
    return db.transaction(() => {
      const a = db.prepare('SELECT * FROM pick_actual WHERE id=?').get(actualId);
      if (!a) throw new ApiError(404, 'ACTUAL_NOT_FOUND', '实绩不存在');
      if (a.state === 'revoked') throw new ApiError(409, 'REVOKED', '已撤销记录不能核对');
      if (a.state === 'verified') return { idempotent: true, actualId };
      db.prepare("UPDATE pick_actual SET state='verified' WHERE id=?").run(actualId);
      log(actor, 'verify', { actualId });
      return { actualId, state: 'verified' };
    })();
  }

  // ---------- 管理页：计划 / 已拣 / 已核对 差异 + 完成门控 ----------
  function taskProgress(taskId) {
    const task = getTask(taskId);
    const lines = db.prepare('SELECT * FROM task_line WHERE task_id=? ORDER BY seq,id').all(taskId);
    const agg = db.prepare(`SELECT
        COALESCE(SUM(CASE WHEN state<>'revoked' AND result IN ('accepted','late_kept') THEN qty_effective END),0) picked,
        COALESCE(SUM(CASE WHEN state='verified' THEN qty_effective END),0) verified,
        COALESCE(SUM(CASE WHEN state<>'revoked' AND result IN ('rejected','late_rejected') THEN 1 ELSE 0 END),0) rejects
      FROM pick_actual WHERE task_id=?`).get(taskId);
    const openShort = db.prepare(
      "SELECT COUNT(*) c FROM exception_log WHERE task_id=? AND kind='shortage' AND resolved=0").get(taskId).c;
    const plan = lines.reduce((s, l) => s + l.qty_alloc, 0);
    const picked = agg.picked;
    const verified = agg.verified;
    const pending = picked - verified;          // ★ 实物待核对
    const variance = picked - plan;            // 负=短缺 正=超（超拣应已在扫码处拒绝，late_kept 例外）
    const allVerified = pending === 0 && lines.length > 0;
    const fullyPicked = picked >= plan;
    // 短缺行：该行已拣件数全部核对，且存在已闭环的短缺异常 => 视为业务接受差异
    const shortageOk = db.prepare(
      "SELECT COUNT(*) c FROM exception_log WHERE task_id=? AND kind='shortage' AND resolved=1").get(taskId).c;
    const shortageClosed = plan > picked && shortageOk > 0 && pending === 0;
    // 完成按钮业务条件：每行实物已核对，且（拣足计划 或 短缺已经异常闭环），且无未处理异常
    const lineDetails = lines.map(l => {
      const la = db.prepare(`SELECT
          COALESCE(SUM(CASE WHEN state<>'revoked' AND result IN ('accepted','late_kept') THEN qty_effective END),0) picked,
          COALESCE(SUM(CASE WHEN state='verified' THEN qty_effective END),0) verified
        FROM pick_actual WHERE task_line_id=?`).get(l.id);
      return { lineId: l.id, shelf: l.shelf, sku: l.sku, mapVersion: l.map_version,
        plan: l.qty_alloc, picked: la.picked, verified: la.verified,
        pendingPhysical: la.picked - la.verified, shortage: Math.max(l.qty_alloc - la.picked, 0) };
    });
    const canComplete = allVerified && (fullyPicked || shortageClosed) && openShort === 0;
    return {
      taskId, taskNo: task.task_no, status: task.status, deviceId: task.device_id,
      mapVersions: [...new Set(lines.map(l => l.map_version))],
      plan, picked, verified, pending, variance, openShortageExceptions: openShort,
      canComplete, lines: lineDetails,
      gateReasons: canComplete ? [] : [
        ...(pending > 0 ? [`还有 ${pending} 件实物待核对`] : []),
        ...(!fullyPicked && !shortageClosed ? [`已拣 ${picked}/计划 ${plan}，存在短缺未闭环`] : []),
        ...(openShort > 0 ? [`${openShort} 条短缺异常未处理`] : []),
      ],
    };
  }

  function completeTask(taskId, actor) {
    return db.transaction(() => {
      const p = taskProgress(taskId);
      if (!p.canComplete) throw new ApiError(409, 'GATE_FAILED', '完成条件不满足', { reasons: p.gateReasons });
      db.prepare("UPDATE pick_task SET status='verified' WHERE id=?").run(taskId);
      // 若订单下所有任务都完成，则订单 done
      const orderId = getTask(taskId).order_id;
      const openTasks = db.prepare("SELECT COUNT(*) c FROM pick_task WHERE order_id=? AND status NOT IN ('verified','cancelled')").get(orderId).c;
      if (openTasks === 0) db.prepare("UPDATE biz_order SET status='done' WHERE id=?").run(orderId);
      log(actor, 'task_complete', { taskId });
      return { taskId, status: 'verified' };
    })();
  }

  function resolveException(exceptionId, actor) {
    const r = db.prepare('UPDATE exception_log SET resolved=1 WHERE id=?').run(exceptionId);
    if (r.changes !== 1) throw new ApiError(404, 'EXC_NOT_FOUND', '异常不存在');
    log(actor, 'exception_resolve', { exceptionId });
    return { exceptionId, resolved: true };
  }

  // ---------- 查询集合（给前端用）----------
  function listOrders() {
    return db.prepare(`SELECT o.*,
        (SELECT COUNT(*) FROM order_line WHERE order_id=o.id) lineCount,
        (SELECT COUNT(*) FROM pick_task t WHERE t.order_id=o.id) taskCount
      FROM biz_order o ORDER BY o.id`).all();
  }
  function orderDetail(orderId) {
    const order = db.prepare('SELECT * FROM biz_order WHERE id=?').get(orderId);
    if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', '订单不存在');
    const lines = db.prepare('SELECT * FROM order_line WHERE order_id=?').all(orderId);
    return { order, lines };
  }
  function listTasks() {
    const rows = db.prepare(`SELECT t.*, o.order_no,
        (SELECT COALESCE(SUM(qty_alloc),0) FROM task_line WHERE task_id=t.id) qtyAlloc
      FROM pick_task t JOIN biz_order o ON o.id=t.order_id ORDER BY t.id DESC`).all();
    return rows.map(t => ({ ...t, leaseAlive: leaseAlive(t) }));
  }
  function taskDetail(taskId) {
    const task = getTask(taskId);
    const lines = db.prepare(`SELECT tl.*,
        (SELECT COALESCE(SUM(CASE WHEN state<>'revoked' AND result IN ('accepted','late_kept') THEN qty_effective END),0)
         FROM pick_actual WHERE task_line_id=tl.id) pickedQty
      FROM task_line tl WHERE tl.task_id=? ORDER BY tl.seq,tl.id`).all(taskId);
    const actuals = db.prepare('SELECT * FROM pick_actual WHERE task_id=? ORDER BY id DESC LIMIT 200').all(taskId);
    return { task, leaseAlive: leaseAlive(task), lines, actuals };
  }
  function pool() {
    // 调度端任务池
    return listTasks();
  }
  // C 触屏主动拉取池中一个可领取任务（queued 或租约已过期），原子领取
  function pullNext(deviceId) {
    return db.transaction(() => {
      const candidate = db.prepare(`SELECT * FROM pick_task
        WHERE status IN ('queued','leased','picking')
          AND (device_id IS NULL OR lease_until IS NULL OR lease_until <= datetime('now'))
        ORDER BY id LIMIT 1`).get();
      if (!candidate) return { pulled: false };
      const epoch = candidate.lease_epoch + 1;
      const until = new Date(now().getTime() + LEASE_MS);
      db.prepare("UPDATE pick_task SET device_id=?,status='leased',lease_until=?,lease_epoch=? WHERE id=?")
        .run(deviceId, iso(until), epoch, candidate.id);
      log(deviceId, 'pull', { taskId: candidate.id, epoch });
      return { pulled: true, taskId: candidate.id, taskNo: candidate.task_no, leaseEpoch: epoch,
        leaseUntil: iso(until), leaseMs: LEASE_MS };
    })();
  }
  function deviceView(deviceId) {
    const tasks = db.prepare(`SELECT t.* FROM pick_task t
      WHERE t.device_id=? ORDER BY CASE t.status WHEN 'leased' THEN 0 WHEN 'picking' THEN 1 ELSE 2 END, t.id`)
      .all(deviceId);
    return tasks.map(t => ({ ...t, leaseAlive: leaseAlive(t) }));
  }
  function exceptions(showResolved = false) {
    return db.prepare('SELECT * FROM exception_log WHERE resolved=? ORDER BY id DESC').all(showResolved ? 1 : 0);
  }
  function maps() {
    return db.prepare('SELECT * FROM map_version ORDER BY version').all();
  }

  return {
    LEASE_MS, ApiError,
    publishMap, getMapForVersion, activeVersion, maps,
    allocateOrder, claimTask, heartbeat, revokeLease,
    submitScan, submitBatch, reportShortage, revokeActual,
    verifyActual, taskProgress, completeTask, resolveException,
    listOrders, orderDetail, listTasks, taskDetail, pool, pullNext, deviceView, exceptions, log,
  };
}

module.exports = { createServices, ApiError, LEASE_MS };
