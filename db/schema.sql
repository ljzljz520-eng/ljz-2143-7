PRAGMA foreign_keys = ON;

-- ============ 主数据：地图（分区图）版本 ============
-- 每次布局更新产生新版本，旧版本永久保留；任务行 pin 住 map_version，
-- 客户端必须用任务对应的版本渲染（文字与箭头同源于同一数据，杜绝"文字对、箭头错"）。
CREATE TABLE IF NOT EXISTS map_version (
  id           INTEGER PRIMARY KEY,
  version      INTEGER NOT NULL UNIQUE,
  zone_code    TEXT NOT NULL,
  bg_image_url TEXT,                       -- 分区底图，可能 404/加载失败
  width        REAL NOT NULL,
  height       REAL NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','active','retired')),
  note         TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 货架：坐标百分比 + 指引箭头（箭头角度由 shelf->目标下一跳 在发布时计算并快照）
-- 渲染时文字标签与箭头共用同一行数据；geom_hash 用于客户端校验图文一致。
CREATE TABLE IF NOT EXISTS map_shelf (
  id          INTEGER PRIMARY KEY,
  map_id      INTEGER NOT NULL REFERENCES map_version(id),
  shelf_code  TEXT NOT NULL,              -- 如 A-01-03
  x           REAL NOT NULL CHECK (x BETWEEN 0 AND 100),
  y           REAL NOT NULL CHECK (y BETWEEN 0 AND 100),
  arrow_dir   REAL NOT NULL,              -- 箭头角度(度)，0=右 90=下
  arrow_from  TEXT,                       -- 箭头来源货架(动线前驱)
  UNIQUE(map_id, shelf_code)
);

CREATE TABLE IF NOT EXISTS sku (
  sku      TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  unit     TEXT NOT NULL DEFAULT 'EA'
);

-- 货架-库位库存（shelf 是 map_shelf.shelf_code，同一物理货架跨版本 code 不变）
CREATE TABLE IF NOT EXISTS inventory (
  shelf      TEXT NOT NULL,
  sku        TEXT NOT NULL REFERENCES sku(sku),
  on_hand    INTEGER NOT NULL DEFAULT 0,   -- 实物在架
  available  INTEGER NOT NULL DEFAULT 0,   -- 可用 = on_hand - 已占用
  PRIMARY KEY (shelf, sku)
);

-- ============ 订单与拆单 ============
CREATE TABLE IF NOT EXISTS biz_order (
  id         INTEGER PRIMARY KEY,
  order_no   TEXT NOT NULL UNIQUE,
  status     TEXT NOT NULL DEFAULT 'open'
               CHECK (status IN ('open','picking','done','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_line (
  id        INTEGER PRIMARY KEY,
  order_id  INTEGER NOT NULL REFERENCES biz_order(id),
  sku       TEXT NOT NULL REFERENCES sku(sku),
  shelf     TEXT NOT NULL,
  qty_plan  INTEGER NOT NULL CHECK (qty_plan > 0),
  UNIQUE(order_id, sku, shelf)
);

-- 拣货任务：同一订单可拆到多台设备；任务行 pin 住分配时刻的 active 地图版本
CREATE TABLE IF NOT EXISTS pick_task (
  id            INTEGER PRIMARY KEY,
  task_no       TEXT NOT NULL UNIQUE,
  order_id      INTEGER NOT NULL REFERENCES biz_order(id),
  device_id     TEXT,                      -- NULL=未领取(在池内)
  status        TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','leased','picking','submitted',
                                    'verified','short_closed','cancelled')),
  lease_until   TEXT,                      -- 租约到期时间
  lease_epoch   INTEGER NOT NULL DEFAULT 0, -- 每次领取/续租 +1，调走即换新 epoch
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_line (
  id           INTEGER PRIMARY KEY,
  task_id      INTEGER NOT NULL REFERENCES pick_task(id),
  order_line_id INTEGER NOT NULL REFERENCES order_line(id),
  sku          TEXT NOT NULL,
  shelf        TEXT NOT NULL,
  qty_alloc    INTEGER NOT NULL CHECK (qty_alloc > 0),  -- 本行分到的量
  map_version  INTEGER NOT NULL,           -- ★ 分配时快照的地图版本
  seq          INTEGER NOT NULL DEFAULT 0  -- 动线顺序（箭头指向 seq+1）
);

-- ============ 扫码实绩 ============
-- 每行=一次扫描的不可变流水。撤销不删行，而是写 revoke_voucher。
CREATE TABLE IF NOT EXISTS pick_actual (
  id           INTEGER PRIMARY KEY,
  task_id      INTEGER NOT NULL REFERENCES pick_task(id),
  task_line_id INTEGER NOT NULL REFERENCES task_line(id),
  device_id    TEXT NOT NULL,
  lease_epoch  INTEGER NOT NULL,           -- 扫描发生时的 epoch
  scan_code    TEXT NOT NULL,              -- 枪扫到的码(shelf 或 sku 条码)
  scan_type    TEXT NOT NULL CHECK (scan_type IN ('shelf','sku')),
  qty          INTEGER NOT NULL DEFAULT 1,
  client_uid   TEXT NOT NULL,              -- ★ 终端幂等键(扫描枪连发去重)
  batch_id     TEXT,                       -- 短批提交的批次号(逐扫为 NULL)
  result       TEXT NOT NULL
                 CHECK (result IN ('accepted','rejected','late_kept','late_rejected')),
  reject_reason TEXT,
  qty_effective INTEGER NOT NULL DEFAULT 0, -- 实际入"已拣"的量
  state        TEXT NOT NULL DEFAULT 'picked'
                 CHECK (state IN ('picked','verified','revoked')), -- ★ 实物待核对
  revoked_by   INTEGER REFERENCES pick_actual(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_actual_uid ON pick_actual(client_uid);

-- 撤销凭证：撤销必须引用原实绩
CREATE TABLE IF NOT EXISTS revoke_voucher (
  id              INTEGER PRIMARY KEY,
  actual_id       INTEGER NOT NULL UNIQUE REFERENCES pick_actual(id),
  ref_actual_uid  TEXT NOT NULL,           -- 被撤销实绩的 client_uid
  reason          TEXT NOT NULL,
  operator        TEXT,
  qty_returned    INTEGER NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 异常：部分短缺/扫错架/超拣/背景图失败等
CREATE TABLE IF NOT EXISTS exception_log (
  id         INTEGER PRIMARY KEY,
  task_id    INTEGER REFERENCES pick_task(id),
  device_id  TEXT,
  kind       TEXT NOT NULL
               CHECK (kind IN ('shortage','wrong_shelf','overpick','late_scan',
                               'bg_load_failed','map_version_mismatch',
                               'lease_expired','power_loss_recovered','batch_conflict')),
  detail     TEXT,
  resolved   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS op_log (
  id         INTEGER PRIMARY KEY,
  actor      TEXT,
  action     TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
