const $ = s => document.querySelector(s);
const api = async (u, b) => {
  const opt = { headers: { 'X-Actor': 'manager' } };
  if (b) { opt.method = 'POST'; opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(b); }
  const r = await fetch(u, opt); const j = await r.json().catch(() => ({}));
  if (!r.ok) { alert((j.error || '') + ' ' + (j.message || '') + (j.reasons ? '\n- ' + j.reasons.join('\n- ') : '')); throw new Error(j.message); }
  return j;
};
const m = {
  cur: null,
  async start() {
    const tasks = await api('/api/tasks');
    $('#taskSel').innerHTML = tasks.map(t =>
      `<option value="${t.id}">${t.task_no} · ${t.order_no} · ${t.status}</option>`).join('');
    const hash = location.hash.match(/task(\d+)/);
    await this.load(hash ? Number(hash[1]) : Number($('#taskSel').value));
  },
  async refresh() { await this.load(this.cur?.taskId); await this.excs(); },
  async load(id) {
    if (!id) return;
    const [p, detail] = await Promise.all([api(`/api/tasks/${id}/progress`), api(`/api/tasks/${id}`)]);
    this.cur = p;
    const vCls = p.variance < 0 ? 'neg' : p.variance > 0 ? 'pos' : 'ok';
    $('#summary').innerHTML = `
      <div class="muted">${p.taskNo} ｜ 状态 ${p.status} ｜ 设备 ${p.deviceId || '-'} ｜
        地图版本 ${p.mapVersions.join(', ')}（按各行分配时锁定版本）</div>
      <div class="kpi">
        <div><b>${p.plan}</b><span class="muted">计划</span></div>
        <div><b class="pos">${p.picked}</b><span class="muted">已拣(系统)</span></div>
        <div><b class="ok">${p.verified}</b><span class="muted">已核对(实物)</span></div>
        <div><b class="pos">${p.pending}</b><span class="muted">实物待核对</span></div>
        <div><b class="${vCls}">${p.variance > 0 ? '+' : ''}${p.variance}</b><span class="muted">差异(拣-计划)</span></div>
      </div>
      <table><tr><th>货架(v)</th><th>SKU</th><th>计划</th><th>已拣</th><th>已核对</th><th>待核对</th><th>短缺</th></tr>
        ${p.lines.map(l => `<tr>
          <td>${l.shelf} <span class="muted">v${l.mapVersion}</span></td><td>${l.sku}</td>
          <td>${l.plan}</td><td>${l.picked}</td><td>${l.verified}</td>
          <td class="${l.pendingPhysical ? 'pos' : ''}">${l.pendingPhysical}</td>
          <td class="${l.shortage ? 'neg' : ''}">${l.shortage || ''}</td></tr>`).join('')}
      </table>
      <div class="gate ${p.canComplete ? 'ok' : ''}">
        ${p.canComplete
          ? '✔ 完成条件满足：每行 已拣≥计划、全部实物已核对、无未处理短缺异常。'
          : '⛔ 完成按钮被门控禁用：<br>· ' + p.gateReasons.join('<br>· ')}
      </div>
      <div style="margin-top:10px">
        <button class="g" ${p.canComplete ? '' : 'disabled'} onclick="m.complete()">完成任务（核对通过）</button>
        <span class="muted">按钮仅在业务条件满足时可用</span>
      </div>`;

    // 明细
    const stTag = (a) => {
      const late = a.result === 'late_kept' ? ' <span class="tag late">迟到已留</span>'
        : a.result.includes('rejected') ? ' <span class="tag revoked">拒</span>' : '';
      return `<span class="tag ${a.state}">${a.state === 'picked' ? '实物待核对' : a.state === 'verified' ? '已核对' : '已撤销'}</span>${late}`;
    };
    $('#actuals').innerHTML = '<table><tr><th>#</th><th>类型/码</th><th>结果</th><th>数量</th><th>状态</th><th>client_uid</th><th></th></tr>' +
      detail.actuals.map(a => `<tr>
        <td>${a.id}</td>
        <td>${a.scan_type === 'shelf' ? '货架' : 'SKU'} ${a.scan_code}<br><span class="muted">epoch ${a.lease_epoch}${a.batch_id ? ' ·批' + a.batch_id.slice(-6) : ''}</span></td>
        <td>${a.result}${a.reject_reason ? '<br><span class="muted">' + a.reject_reason + '</span>' : ''}</td>
        <td>${a.qty_effective || (a.qty && a.result === 'rejected' ? 0 : '')}</td>
        <td>${stTag(a)}</td>
        <td class="muted" style="font-size:11px">${a.client_uid}</td>
        <td>${a.state === 'picked' && a.qty_effective > 0 ? `<button class="g" onclick="m.verify(${a.id})">实物核对</button>
            <button class="r" onclick="m.fillRev('${a.client_uid}')">撤销</button>` : ''}</td></tr>`).join('') + '</table>';
    await this.excs();
  },
  async verify(id) { await api(`/api/actuals/${id}/verify`, {}); await this.refresh(); },
  fillRev(uidv) { $('#revUid').value = uidv; },
  async revoke() {
    const refClientUid = $('#revUid').value.trim(), reason = $('#revReason').value.trim();
    if (!refClientUid || !reason) return alert('必须填写原实绩 client_uid 与撤销原因');
    try { const r = await api('/api/actuals/revoke', { refClientUid, reason });
      alert(`已撤销 ${r.revoked}，回补可用量 ${r.qtyReturned}`);
      $('#revUid').value = ''; $('#revReason').value = '';
      await this.refresh();
    } catch (e) {}
  },
  async complete() {
    try { const r = await api(`/api/tasks/${this.cur.taskId}/complete`, {});
      alert('任务完成：' + r.status); await m.start();
    } catch (e) {}
  },
  async excs() {
    const list = await api('/api/exceptions');
    $('#excs').innerHTML = list.filter(e => !this.cur || e.task_id === this.cur.taskId || e.kind === 'shortage')
      .slice(0, 30).map(e => `<div class="ex"><b>${e.kind}</b>
        <span class="muted">任务#${e.task_id || '-'}</span><div>${e.detail || ''}</div>
        ${e.kind === 'shortage' ? `<button class="s" style="margin-top:4px" onclick="m.resolve(${e.id})">登记处理（闭环）</button>` : ''}</div>`).join('')
      || '<p class="muted">无未处理异常</p>';
  },
  async resolve(id) { await api(`/api/exceptions/${id}/resolve`, {}); await this.refresh(); },
};
m.start();
