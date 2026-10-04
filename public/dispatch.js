const $ = s => document.querySelector(s);
const api = async (u, b) => {
  const opt = { headers: { 'X-Actor': 'dispatcher' } };
  if (b) { opt.method = 'POST'; opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(b); }
  const r = await fetch(u, opt); const j = await r.json().catch(() => ({}));
  if (!r.ok) { alert((j.error || '') + ' ' + (j.message || r.statusText) +
    (JSON.stringify(j).includes('reasons') ? '\n' + (j.reasons||[]).join('\n') : '')); throw new Error(j.message); }
  return j;
};
const d = {
  async load() { await Promise.all([this.orders(), this.tasks(), this.maps(), this.excs()]); },
  async orders() {
    const list = await api('/api/orders');
    $('#orders').innerHTML = (await Promise.all(list.map(async o => {
      const detail = await api(`/api/orders/${o.id}`);
      return `<div style="border:1px solid #e6edf3;border-radius:10px;padding:10px;margin-bottom:10px">
        <b>${o.order_no}</b> <span class="tag">${o.status}</span>
        <span class="muted">订单行 ${o.lineCount} · 已生成任务 ${o.taskCount}</span>
        <table><tr><th>SKU</th><th>货架</th><th>计划</th><th></th></tr>
        ${detail.lines.map(l => `<tr><td>${l.sku}</td><td>${l.shelf}</td><td>${l.qty_plan}</td>
          <td class="muted">同一行可再拆到不同设备</td></tr>`).join('')}</table>
        <div style="margin-top:7px;display:flex;gap:6px">
          <button class="p" onclick='d.openSplit(${o.id}, ${JSON.stringify(detail.lines)})'>分配新任务（可拆）</button>
          <button class="s" onclick='d.allocWhole(${o.id})'>整单建任务</button>
        </div></div>`;
    }))).join('') || '<p class="muted">无订单</p>';
  },
  openSplit(orderId, lines) {
    // 一个任务对应一台设备；同一订单建多个任务即实现"拆到多台设备"。
    // 弹窗里填写本任务每个订单行要分多少（0 表示不进本任务）。
    $('#splitBody').innerHTML = `<h3>为订单 #${orderId} 生成本次任务（拆到一台设备的量）</h3>
      <p class="muted">需要拆到多台设备时，先建本任务分配一部分，再对剩余行重复"分配新任务"。系统会校验不超计划、不超可用库存。</p>
      ${lines.map(l => `<div class="splitrow"><span style="width:150px">${l.shelf} · ${l.sku}</span>
        计划 ${l.qty_plan} → 本任务 <input data-ol="${l.id}" type="number" min="0" max="${l.qty_plan}" value="${l.qty_plan}" style="width:80px"/></div>`).join('')}
      <div class="row"><button class="s" onclick="d.closeDlg()">取消</button>
      <button class="p" onclick='d.doSplit(${orderId})'>生成任务并占用库存</button></div>`;
    $('#splitDlg').showModal();
  },
  closeDlg() { document.querySelector('dialog').close(); },
  async doSplit(orderId) {
    const split = [...document.querySelectorAll('#splitBody input[data-ol]')]
      .map(i => ({ order_line_id: Number(i.dataset.ol), qty: Number(i.value) }))
      .filter(x => x.qty > 0);
    try { const r = await api(`/api/orders/${orderId}/allocate`, { split });
      alert(`已建任务 ${r.taskNo}，锁定地图 v${r.mapVersion}，占用库存完成`);
      this.closeDlg(); await this.load();
    } catch (e) {}
  },
  async allocWhole(orderId) {
    try { const r = await api(`/api/orders/${orderId}/allocate`, {});
      alert(`整单任务 ${r.taskNo} 已生成（地图 v${r.mapVersion}）`); await this.load();
    } catch (e) {}
  },

  async tasks() {
    const list = await api('/api/tasks');
    $('#tasks').innerHTML = '<table><tr><th>任务</th><th>订单</th><th>设备/租约</th><th>状态</th><th>操作</th></tr>' +
      list.map(t => `<tr>
        <td><b>${t.task_no}</b><br><span class="muted">${t.qtyAlloc} 件</span></td>
        <td>${t.order_no}</td>
        <td>${t.device_id ? `<div>${t.device_id}</div>
            <span class="tag ${t.lease_alive ? 'live' : 'dead'}">${t.lease_alive ? '租约有效 ' + t.lease_until.slice(11) : '租约失效/到期'}</span>
            <div class="muted">epoch ${t.lease_epoch}</div>` : '<span class="muted">池内待领取</span>'}</td>
        <td><span class="tag">${t.status}</span></td>
        <td style="white-space:nowrap">
          ${t.device_id ? `<button class="o" onclick="d.reassign(${t.id})">调走（失效租约）</button>` : '<span class="muted">等待领取</span>'}
          <a href="/admin.html#task${t.id}"><button class="s">差异/核对</button></a>
        </td></tr>`).join('') + '</table>';
  },
  async reassign(id) {
    if (!confirm('立即调走该任务？当前设备租约失效（epoch+1），但它已拣出的实物实绩保留为待核对，最后一扫到达也不会被抹去。')) return;
    await api(`/api/tasks/${id}/reassign`, { reason: 'manual_dispatch' });
    await this.load();
  },

  async maps() {
    const list = await api('/api/maps');
    $('#maps').innerHTML = list.map(m => `
      <div style="border:1px solid #e6edf3;border-radius:10px;padding:10px;margin-bottom:8px">
        <b>v${m.version} · ${m.zone_code} 区</b>
        <span class="tag ${m.status === 'active' ? 'live' : m.status === 'draft' ? '' : 'dead'}">${m.status}</span>
        <div class="muted">${m.note || ''} ｜ 底图 ${m.bg_image_url}</div>
        <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">
          ${m.status === 'draft' ? `<button class="g" onclick="d.publish(${m.id})">发布（校验箭头与坐标一致）</button>` : ''}
          <button class="s" onclick="d.viewMap(${m.version})">查看货架/箭头快照</button>
          <button class="r" onclick="d.bgFail(${m.version})">模拟底图 404</button>
          <button class="s" onclick="d.bgOk(${m.version})">恢复底图</button>
        </div>
        <div id="mapv${m.version}"></div>
      </div>`).join('');
  },
  async publish(id) {
    try { const r = await api(`/api/maps/${id}/publish`, {});
      alert(`v${r.version} 已发布；旧版置为 retired。已在途任务仍按各自锁定版本渲染。`); await this.maps();
    } catch (e) {}
  },
  async viewMap(v) {
    const m = await api(`/api/maps/version/${v}`);
    $('#mapv' + v).innerHTML = `<table style="margin-top:6px"><tr><th>货架</th><th>x</th><th>y</th><th>箭头角</th></tr>
      ${m.shelves.map(s => `<tr><td>${s.code}</td><td>${s.x}</td><td>${s.y}</td>
        <td class="arrowchk">${s.arrow_dir != null ? '➤ ' + s.arrow_dir + '°' : '—'}</td></tr>`).join('')}</table>
      <div class="muted">箭头角度由相邻货架坐标在发布时同源计算，文字标签与箭头不可能各取一个版本。</div>`;
  },
  async bgFail(v) { await api(`/api/maps/simulate-bg-failure/${v}`, {}); alert('已将底图改为不存在 URL；C 端重新打开任务即会阻断开工'); },
  async bgOk(v) { await api(`/api/maps/restore-bg/${v}`, {}); alert('底图已恢复'); },

  async excs() {
    const list = await api('/api/exceptions');
    $('#excs').innerHTML = list.map(e => `<div class="ex"><b>${e.kind}</b>
      <span class="muted">任务#${e.task_id || '-'} 设备${e.device_id || '-'}</span>
      <div>${e.detail || ''}</div></div>`).join('') || '<p class="muted">无未处理异常</p>';
  },
};
d.load();
setInterval(() => d.load().catch(() => {}), 6000);
