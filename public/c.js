/* C 触屏逻辑：
 * - 每个任务行都带有自己的 map_version；渲染前先拉取该版本的地图，
 *   货架"文字标签 + 坐标 + 箭头"全部来自同一版本接口，杜绝文字对/箭头错。
 * - 底图加载失败 => 阻断开工（允许刷新重试），避免凭文字猜方位。
 * - 逐扫：每扫立即请求 /api/scan；短批：离线在 localStorage 攒批，
 *   本地按分配量计数防超拣，恢复后整批提交，client_uid 保证幂等。
 * - 断电恢复：页面加载时重放 localStorage 未确认队列。
 */
const $ = s => document.querySelector(s);
const api = async (url, body) => {
  const opt = { method: body ? 'POST' : 'GET', headers: { 'X-Actor': 'device' } };
  if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(url, opt);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.message || r.statusText), { status: r.status, body: j });
  return j;
};
const uid = () => 'C_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
const LS_PENDING = 'pick_pending_batch_v1';

const state = {
  tasks: [], task: null, lines: [], actuals: [], mode: 'single',
  curLineId: null, map: null, bgReady: false,
  online: !navigator.onLine ? false : true,
  pending: JSON.parse(localStorage.getItem(LS_PENDING) || '{}'), // taskId -> {batchId, scans[]}
  leasePct: 0, leaseEnd: 0, leaseTimer: null, hbTimer: null,
  claimedEpoch: null,
};

const app = {
  async init() {
    $('#btnClaim').onclick = () => this.claim();
    $('#btnPull').onclick = () => this.pullNext();
    $('#btnRefresh').onclick = () => this.loadTasks();
    $('#btnOffline').onclick = () => this.toggleOffline();
    $('#scanInput').addEventListener('keydown', e => { if (e.key === 'Enter') this.fireScan(); });
    window.addEventListener('online', () => this.setNet(true));
    window.addEventListener('offline', () => this.setNet(false));
    $('#taskSel').onchange = e => this.selectTask(Number(e.target.value));
    setInterval(() => this.loadTasks().catch(() => {}), 5000);
    // 断电恢复：上次有未提交短批 => 提示
    const pendingCount = Object.values(state.pending).reduce((s, b) => s + b.scans.length, 0);
    if (pendingCount) this.feed(`⚡ 检测到断电/断网前遗留 ${pendingCount} 条未提交短扫，已恢复，待联网提交`, 'warn');
    this.updateFlushBtn();
    this.setNet(navigator.onLine);
    await this.loadTasks();
  },

  setMode(m) {
    state.mode = m;
    $('#modeSingle').classList.toggle('on', m === 'single');
    $('#modeBatch').classList.toggle('on', m === 'batch');
    this.feed(m === 'single' ? '模式：逐扫确认（每扫即时占库）' : '模式：本地短批（离线攒批，本地按分配量封顶防超拣）', '');
  },

  setNet(on) {
    state.online = on;
    $('#netDot').style.background = on ? '#3ddc84' : '#ff5252';
    $('#netTxt').textContent = on ? '在线' : '离线';
    $('#btnOffline').textContent = on ? '切到离线' : '切回在线';
    $('#btnOffline').classList.toggle('offline', !on);
    if (on) this.recoverPending();
  },
  toggleOffline() {
    // 模拟断网：直接切换 UI 状态（fetch 仍会走到服务端，因此离线时本地逻辑根本不发请求）
    this.setNet(!state.online);
    if (!state.online) this.feed('已进入离线模拟：扫码只写本地，不扣服务端库存', 'warn');
  },

  async loadTasks() {
    const deviceId = $('#deviceId').value.trim();
    state.tasks = await api(`/api/devices/${encodeURIComponent(deviceId)}/tasks`);
    const sel = $('#taskSel');
    const cur = sel.value;
    sel.innerHTML = state.tasks.length
      ? state.tasks.map(t => `<option value="${t.id}">${t.task_no} [${t.status}]${t.lease_alive ? ' ·持有' : ''}</option>`).join('')
      : '<option value="">(该设备无任务)</option>';
    if (cur && state.tasks.some(t => String(t.id) === cur)) sel.value = cur;
    if (state.task) await this.selectTask(state.task.task.id);
  },

  async pullNext() {
    const deviceId = $('#deviceId').value.trim();
    try {
      const r = await api('/api/tasks/pull', { deviceId });
      if (!r.pulled) { this.feed('任务池暂无可领取任务', 'warn'); return; }
      state.leaseEnd = Date.now() + r.leaseMs;
      state.claimedEpoch = r.leaseEpoch;
      this.feed(`✔ 拉取到 ${r.taskNo}（epoch ${r.leaseEpoch}）`, 'ok');
      await this.loadTasks();
      $('#taskSel').value = r.taskId;
      await this.selectTask(r.taskId);
      this.startHeartbeat(r.taskId);
    } catch (e) { this.feed('✗ 拉取失败：' + e.message, 'bad'); }
  },

  async selectTask(id) {
    if (!id) { state.task = null; return; }
    state.task = await api(`/api/tasks/${id}`);
    state.lines = state.task.lines;
    state.actuals = state.task.actuals;
    state.curLineId = (state.lines.find(l => l.pickedQty < l.qty_alloc) || state.lines[0] || {}).id;
    // 该任务 pin 的地图版本（同一任务内所有行同版本；这里防御性取第一行）
    const v = state.lines[0]?.map_version;
    state.claimedEpoch = state.task.task.lease_epoch;
    await this.renderMap(v);
    this.renderTask();
    this.startLeaseUi();
  },

  async claim() {
    const id = Number($('#taskSel').value);
    if (!id) return;
    try {
      const r = await api(`/api/tasks/${id}/claim`, { deviceId: $('#deviceId').value.trim() });
      state.leaseEnd = Date.now() + r.leaseMs;
      state.claimedEpoch = r.leaseEpoch;
      this.feed(`✔ 领取成功，租约至 ${r.leaseUntil}（epoch ${r.leaseEpoch}）`, 'ok');
      await this.loadTasks();
      await this.selectTask(id);
      this.startHeartbeat(id);
    } catch (e) { this.feed('✗ 领取失败：' + e.message, 'bad'); }
  },

  startHeartbeat(id) {
    clearInterval(state.hbTimer);
    state.hbTimer = setInterval(async () => {
      if (!state.task || state.online === false) return;
      try {
        const r = await api(`/api/tasks/${id}/heartbeat`, { deviceId: $('#deviceId').value.trim() });
        state.leaseEnd = Date.now() + (r.leaseMs || 120000); // 心跳成功，按服务端租约时长续条
        if (r.leaseEpoch !== state.claimedEpoch) {
          this.feed('⚠ 任务已被调度调走（租约 epoch 变化）！最后一扫仍会如实上传保留', 'bad');
          state.claimedEpoch = r.leaseEpoch;
        }
      } catch (e) {
        // 403 NOT_OWNER：租约过期后任务已被别的设备接走
        if (e.body && e.body.error === 'NOT_OWNER') {
          this.feed('⛔ 本任务已被其他设备领取（租约过期/被调走）。已拣扫不会丢；后续扫将按"迟到扫"处理', 'bad');
          state.claimedEpoch = (state.claimedEpoch || 0) + 1;
          this.loadTasks().catch(() => {});
        }
        /* 其它网络抖动下一拍再试 */
      }
    }, 15000);
  },

  startLeaseUi() {
    clearInterval(state.leaseTimer);
    state.leaseTimer = setInterval(() => {
      const t = state.task?.task;
      if (!t?.lease_until) { $('#leaseBar').style.width = '0%'; return; }
      // sqlite 存 UTC（'YYYY-MM-DD HH:MM:SS'），补 Z 按 UTC 解析
      const end = new Date(t.lease_until.replace(' ', 'T') + 'Z').getTime();
      const remain = Math.max(0, end - Date.now());
      const pct = Math.min(100, Math.round((remain / 120000) * 100));
      $('#leaseBar').style.width = pct + '%';
      if (remain === 0 && t.status !== 'verified')
        this.feed('⏰ 租约已到期：任务可被他人领取，但你已拣的实绩不会被删除', 'warn');
    }, 1000);
  },

  // ---------- 地图渲染：版本 pin + 图文同源 + 底图失败阻断 ----------
  async renderMap(version) {
    const layer = $('#shelfLayer'); layer.innerHTML = '';
    $('#bgFail').style.display = 'none';
    state.bgReady = false;
    try {
      state.map = await api(`/api/maps/version/${version}`);
    } catch (e) {
      this.blockBg(`地图版本 ${version} 数据缺失：${e.message}`);
      return;
    }
    $('#verBadge').textContent = `${state.map.zone_code} 区 · 地图 v${state.map.version}（任务锁定版本）`;
    const img = $('#bg');
    const done = new Promise(res => {
      img.onload = () => res(true);
      img.onerror = () => res(false);
    });
    img.src = state.map.bg_image_url + '?t=' + Date.now();
    const ok = await done;
    if (!ok) { this.blockBg(`底图 ${state.map.bg_image_url} 加载失败（HTTP/网络错误）`); return; }
    state.bgReady = true;
    // 等一帧拿到容器尺寸（坐标是百分比，直接用 % 定位）
    const byCode = Object.fromEntries(state.map.shelves.map(s => [s.code, s]));
    const pickedByShelf = {};
    const planByShelf = {};
    state.lines.forEach(l => {
      pickedByShelf[l.shelf] = (pickedByShelf[l.shelf] || 0) + l.pickedQty;
      planByShelf[l.shelf] = (planByShelf[l.shelf] || 0) + l.qty_alloc;
    });
    // 先画箭头（与货架同源，角度直接用发布时快照值 arrow_dir）
    state.map.shelves.forEach((s, i) => {
      const nxt = state.map.shelves[i + 1];
      if (!nxt || s.arrow_dir == null) return;
      // 箭头长度以"横向百分比"为单位（mapWrap 近似方形），再按发布时同源角度旋转；
      // 终点用 nxt 位置，缩短 8% 避免压住下一个货架圆点。
      const dx = nxt.x - s.x, dy = nxt.y - s.y;
      const len = Math.max(0, Math.hypot(dx, dy) - 8);
      const a = document.createElement('div');
      a.className = 'arrow';
      a.style.left = s.x + '%'; a.style.top = s.y + '%';
      a.style.width = len + '%';
      a.style.transform = `rotate(${s.arrow_dir}deg)`;
      layer.appendChild(a);
    });
    state.map.shelves.forEach(s => {
      const plan = planByShelf[s.code] || 0;
      const picked = pickedByShelf[s.code] || 0;
      const el = document.createElement('div');
      el.className = 'shelf' + (plan === 0 ? ' zero' : picked >= plan && plan > 0 ? ' done' : '')
        + (state.curLineId && state.lines.find(l => l.id === state.curLineId)?.shelf === s.code ? ' active' : '');
      el.style.left = s.x + '%'; el.style.top = s.y + '%';
      el.innerHTML = `<div class="code">${s.code}</div>
        <div class="meta">${plan ? `拣 <b>${picked}/${plan}</b>` : '本任务无行'}</div>
        <div class="meta" style="color:#e0583b">${s.arrow_dir != null ? '➤ ' + s.arrow_dir + '°' : '终点'}</div>`;
      el.onclick = () => {
        const line = state.lines.find(l => l.shelf === s.code);
        if (line) { state.curLineId = line.id; this.renderTask(); }
      };
      layer.appendChild(el);
    });
  },
  blockBg(info) {
    state.bgReady = false;
    $('#bgFailInfo').textContent = info;
    $('#bgFail').style.display = 'flex';
  },
  reloadBg() { this.renderMap(state.map?.version || state.lines[0]?.map_version); },

  // ---------- 任务/行渲染 ----------
  renderTask() {
    if (!state.task) return;
    const t = state.task.task;
    $('#taskInfo').innerHTML = `<span class="pill">${t.task_no}</span>
      <span class="pill">状态 ${t.status}</span>
      <span class="pill">设备 ${t.device_id || '-'}</span>
      <span class="pill">地图 v${state.lines[0]?.map_version}</span>`;
    const cur = state.lines.find(l => l.id === state.curLineId);
    $('#curLine').innerHTML = cur
      ? `当前货位 <b>${cur.shelf}</b>，SKU <b>${cur.sku}</b>，应拣 <b>${cur.qty_alloc}</b>，已拣 <b>${cur.pickedQty}</b>`
      : '无可拣行';
    $('#lines').innerHTML = state.lines.map(l => `
      <div class="line ${l.id === state.curLineId ? 'cur' : ''} ${l.pickedQty >= l.qty_alloc ? 'done' : ''}">
        <div class="r"><b>${l.shelf}</b><span class="pill">v${l.map_version}</span></div>
        <div class="r"><span>${l.sku}</span><span class="qty">${l.pickedQty}/${l.qty_alloc}</span></div>
      </div>`).join('');
  },

  feed(msg, cls) {
    const d = document.createElement('div');
    d.className = cls || '';
    d.textContent = new Date().toLocaleTimeString() + ' ' + msg;
    $('#feed').prepend(d);
  },

  // 扫码输入：以 SHELF: 前缀模拟货架码，否则当 SKU 码（演示方便可直接打字）
  parseScan(raw) {
    if (raw.startsWith('SHELF:')) return { scanType: 'shelf', code: raw.slice(6) };
    if (/^A-0\d$/.test(raw)) return { scanType: 'shelf', code: raw };
    return { scanType: 'sku', code: raw };
  },

  async fireScan(qty = 1) {
    const raw = $('#scanInput').value.trim();
    $('#scanInput').value = '';
    $('#scanInput').focus();
    if (!raw || !state.task) return;
    if (!state.bgReady) { this.feed('✗ 底图未就绪，禁止扫码作业', 'bad'); return; }
    const line = state.lines.find(l => l.id === state.curLineId);
    if (!line) return;
    const { scanType, code } = this.parseScan(raw);
    const scan = {
      taskId: state.task.task.id, taskLineId: line.id,
      deviceId: $('#deviceId').value.trim(), scanCode: code, scanType, qty,
      clientUid: uid(),
    };

    if (state.mode === 'batch' || !state.online) {
      // 本地防超拣：仅按"分配量 - 本地累计（含本批）"判断；在线时这只是第一道闸，
      // 服务端提交时还会按真实 available 复核。离线无法感知跨设备占用，这是固有限制。
      const localBatch = state.pending[state.task.task.id];
      const localQty = (localBatch?.scans.filter(s => s.scanType === 'sku' && s.taskLineId === line.id)
        .reduce((s, x) => s + x.qty, 0)) || 0;
      if (scanType === 'sku' && line.pickedQty + localQty + qty > line.qty_alloc) {
        this.feed(`✗ 本地防超拣：${line.shelf}/${line.sku} 分配 ${line.qty_alloc}（本地已留 ${line.pickedQty + localQty}），拒绝`, 'bad');
        return;
      }
      this.enqueue(scan);
      this.feed(`📥 本地留存 ${scanType === 'shelf' ? '货架确认' : code} ×${qty}（未扣服务端库存）`, 'warn');
      return;
    }

    // 逐扫在线：立即提交
    try {
      const r = await api('/api/scan', scan);
      this.handleScanResult(r, scan);
    } catch (e) {
      this.feed('✗ 提交异常：' + e.message + '（已转入本地队列，待恢复重放）', 'bad');
      this.enqueue(scan);
    }
  },

  enqueue(scan) {
    const tid = scan.taskId;
    if (!state.pending[tid]) state.pending[tid] = { batchId: uid('B'), scans: [] };
    state.pending[tid].scans.push(scan);
    localStorage.setItem(LS_PENDING, JSON.stringify(state.pending));
    this.updateFlushBtn();
  },
  updateFlushBtn() {
    const n = Object.values(state.pending).reduce((s, b) => s + b.scans.length, 0);
    $('#btnFlush').textContent = `提交短批(${n})`;
    $('#btnFlush').disabled = n === 0 || !state.online;
  },

  async flushBatch() {
    if (!state.online) { this.feed('离线中不能提交短批', 'bad'); return; }
    for (const tid of Object.keys(state.pending)) {
      const b = state.pending[tid];
      // 短批只提交 SKU 扫；货架确认在离线没有业务意义，直接剔除
      const skuScans = b.scans.filter(s => s.scanType === 'sku');
      try {
        const r = await api('/api/scan/batch', {
          taskId: Number(tid), deviceId: $('#deviceId').value.trim(),
          batchId: b.batchId, scans: skuScans,
        });
        this.feed(r.idempotent ? `♻ 批次 ${b.batchId} 曾提交，服务端幂等回放（未重复扣库存）`
          : `✔ 批次 ${b.batchId} 入库 ${r.acceptedRows} 扫 / ${r.qtyEffective} 件${r.leaseAlive === false ? '（租约已失效，按待核对保留）' : ''}`, r.leaseAlive === false ? 'warn' : 'ok');
        delete state.pending[tid];
      } catch (e) {
        if (e.body?.error === 'BATCH_OVERPICK' || e.body?.error === 'BATCH_SHORTAGE') {
          this.feed(`✗ 整批被拒（原子回滚，未扣库存）：${e.message}。需人工逐件核对后拆分重提`, 'bad');
        } else this.feed('✗ 批次提交失败：' + e.message, 'bad');
      }
    }
    localStorage.setItem(LS_PENDING, JSON.stringify(state.pending));
    this.updateFlushBtn();
    await this.selectTask(state.task.task.id);
  },

  // 启动时/恢复在线时自动重放
  async recoverPending() {
    this.updateFlushBtn();
    const n = Object.values(state.pending).reduce((s, b) => s + b.scans.length, 0);
    if (n) { this.feed('网络恢复，自动提交本地短批…', ''); await this.flushBatch(); }
  },

  handleScanResult(r, scan) {
    if (r.idempotent) { this.feed(`♻ 重复扫（${scan.clientUid.slice(-6)}）已幂等忽略，库存未重复扣减；结果=${r.result}`, 'warn'); return; }
    if (r.kind === 'shelf_confirm') { this.feed(`✔ 货架确认 ${scan.scanCode}，请扫 SKU`, 'ok'); return; }
    if (r.result === 'accepted') this.feed(`✔ 拣 ${scan.scanCode} ×${scan.qty} 成功（${r.pickedAfter}/${r.alloc}）→ 实物待核对`, 'ok');
    else if (r.result === 'late_kept') this.feed('⏳ ' + r.warning, 'warn');
    else if (r.result === 'late_rejected') this.feed('⛔ ' + r.warning, 'bad');
    else if (r.reason === 'overpick') this.feed(`✗ 防超拣：已拣 ${r.picked} 达分配 ${r.alloc}`, 'bad');
    else if (r.reason === 'wrong_shelf') this.feed(`✗ 扫错货架！应在 ${r.expectShelf}`, 'bad');
    else if (r.reason === 'wrong_sku') this.feed(`✗ SKU 不符，应为 ${r.expectSku}`, 'bad');
    else if (r.reason === 'out_of_stock') this.feed('✗ 库存不足，请上报部分短缺', 'bad');
    else this.feed('结果：' + r.result + ' ' + (r.reason || ''), 'bad');
    if (state.task) this.selectTask(state.task.task.id);
  },

  // 扫描枪连发：5 个 Enter 事件几乎同时到达，同 SKU；幂等键不同（真实同码连发场景），
  // 靠服务端"已拣量"判定：只有前 N 件 accepted，其余 overpick 拒绝。
  burst() {
    let i = 0;
    const tick = () => { if (i++ < 5) { this.fireScan(1); setTimeout(tick, 60); } };
    tick();
  },

  async shortage() {
    const line = state.lines.find(l => l.id === state.curLineId);
    if (!line) return;
    const found = prompt(`上报部分短缺：${line.shelf}/${line.sku}，应拣 ${line.qty_alloc}，实际找到数量？`, line.pickedQty);
    if (found == null) return;
    try {
      const r = await api('/api/shortage', {
        taskId: state.task.task.id, taskLineId: line.id,
        deviceId: $('#deviceId').value.trim(), foundQty: Number(found), note: '终端上报',
      });
      this.feed(`⚠ 短缺已记录：缺 ${r.missing} 件，对应占用已释放，待管理端处理异常`, 'warn');
      await this.selectTask(state.task.task.id);
    } catch (e) { this.feed('✗ ' + e.message, 'bad'); }
  },
};
window.app = app;
app.init();
