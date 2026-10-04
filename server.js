// 后台 API + 静态页面
const path = require('path');
const express = require('express');
const { openDb, seed } = require('./db/init');
const { createServices, ApiError } = require('./services');

const db = openDb();
seed(db);
const svc = createServices(db);
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const actor = req => req.get('x-actor') || req.body?.operator || req.body?.deviceId || 'unknown';

// ---------- 主数据 / 地图 ----------
app.get('/api/maps', wrap((req, res) => res.json(svc.maps())));
app.post('/api/maps/:id/publish', wrap((req, res) =>
  res.json(svc.publishMap(Number(req.params.id), actor(req)))));
app.get('/api/maps/version/:v', wrap((req, res) =>
  res.json(svc.getMapForVersion(Number(req.params.v)))));
app.post('/api/maps/simulate-bg-failure/:v', wrap((req, res) => {
  // 演示用：把某版本底图 URL 改为不存在的地址
  const v = Number(req.params.v);
  db.prepare('UPDATE map_version SET bg_image_url=? WHERE version=?').run('/maps/__missing__.svg', v);
  res.json({ ok: true, version: v, bgImageUrl: '/maps/__missing__.svg' });
}));
app.post('/api/maps/restore-bg/:v', wrap((req, res) => {
  const v = Number(req.params.v);
  db.prepare('UPDATE map_version SET bg_image_url=? WHERE version=?').run(`/maps/bg-v${v}.svg`, v);
  res.json({ ok: true, version: v });
}));

// ---------- 订单 / 调度 ----------
app.get('/api/orders', wrap((req, res) => res.json(svc.listOrders())));
app.get('/api/orders/:id', wrap((req, res) => res.json(svc.orderDetail(Number(req.params.id)))));
app.post('/api/orders/:id/allocate', wrap((req, res) =>
  res.json(svc.allocateOrder(Number(req.params.id), req.body.split || null, actor(req)))));
app.get('/api/tasks', wrap((req, res) => res.json(svc.listTasks())));
app.get('/api/tasks/pool', wrap((req, res) => res.json(svc.pool())));
app.get('/api/tasks/:id', wrap((req, res) => res.json(svc.taskDetail(Number(req.params.id)))));

// ---------- 租约 ----------
app.post('/api/tasks/pull', wrap((req, res) =>
  res.json(svc.pullNext(req.body.deviceId))));
app.post('/api/tasks/:id/claim', wrap((req, res) =>
  res.json(svc.claimTask(Number(req.params.id), req.body.deviceId, actor(req)))));
app.post('/api/tasks/:id/heartbeat', wrap((req, res) =>
  res.json(svc.heartbeat(Number(req.params.id), req.body.deviceId))));
app.post('/api/tasks/:id/reassign', wrap((req, res) =>
  res.json(svc.revokeLease(Number(req.params.id), req.body.reason, actor(req)))));

// ---------- 扫码实绩（逐扫 / 短批）----------
app.post('/api/scan', wrap((req, res) => res.json(svc.submitScan(req.body, actor(req)))));
app.post('/api/scan/batch', wrap((req, res) => res.json(svc.submitBatch(req.body, actor(req)))));
app.post('/api/shortage', wrap((req, res) => res.json(svc.reportShortage(req.body, actor(req)))));

// ---------- 管理：核对 / 撤销 / 完成门控 ----------
app.get('/api/tasks/:id/progress', wrap((req, res) => res.json(svc.taskProgress(Number(req.params.id)))));
app.post('/api/actuals/:id/verify', wrap((req, res) => res.json(svc.verifyActual(Number(req.params.id), actor(req)))));
app.post('/api/actuals/revoke', wrap((req, res) => res.json(svc.revokeActual(req.body, actor(req)))));
app.post('/api/tasks/:id/complete', wrap((req, res) => res.json(svc.completeTask(Number(req.params.id), actor(req)))));
app.get('/api/exceptions', wrap((req, res) => res.json(svc.exceptions(req.query.all === '1'))));
app.post('/api/exceptions/:id/resolve', wrap((req, res) =>
  res.json(svc.resolveException(Number(req.params.id), actor(req)))));
app.get('/api/inventory', wrap((req, res) =>
  res.json(db.prepare('SELECT * FROM inventory ORDER BY shelf,sku').all())));
app.get('/api/devices/:id/tasks', wrap((req, res) => res.json(svc.deviceView(req.params.id))));

// 错误处理
app.use((err, req, res, next) => {
  if (err instanceof ApiError) return res.status(err.status).json({ error: err.code, message: err.message, ...err.extra });
  console.error(err);
  res.status(500).json({ error: 'INTERNAL', message: err.message });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`picking demo listening on http://localhost:${PORT}`));
}
module.exports = app;
