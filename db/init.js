// 数据库初始化 + 种子数据
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.PICK_DB || path.join(__dirname, 'pick.db');

function openDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  return db;
}

// 按 seq 顺序计算每支货架箭头：指向下一 seq 货架的角度（atan2，0=东，90=下，顺时针）
function insertShelves(db, mapId, rows) {
  const bySeq = rows
    .map(([code, x, y, seq]) => ({ code, x, y, seq }))
    .sort((a, b) => a.seq - b.seq);
  const ins = db.prepare(
    'INSERT INTO map_shelf(map_id,shelf_code,x,y,arrow_dir,arrow_from) VALUES(?,?,?,?,?,?)');
  for (let i = 0; i < bySeq.length; i += 1) {
    const cur = bySeq[i];
    const next = bySeq[i + 1];
    let dir = 0;
    if (next) {
      let deg = (Math.atan2(next.y - cur.y, next.x - cur.x) * 180) / Math.PI;
      if (deg < 0) deg += 360;
      dir = Math.round(deg);
    }
    ins.run(mapId, cur.code, cur.x, cur.y, dir, next ? cur.code : null);
  }
}

function seed(db) {
  if (db.prepare('SELECT COUNT(*) c FROM map_version').get().c > 0) return;

  const tx = db.transaction(() => {
    const shelvesV1 = [
      ['A-01', 12, 75, 1], ['A-02', 32, 75, 2], ['A-03', 52, 75, 3],
      ['A-04', 52, 35, 4], ['A-05', 32, 35, 5], ['A-06', 12, 35, 6],
    ];
    const shelvesV2 = [
      ['A-01', 12, 75, 1], ['A-02', 32, 75, 2], ['A-03', 52, 75, 3],
      ['A-04', 52, 35, 4], ['A-05', 68, 55, 5], ['A-06', 84, 55, 6],
    ];
    const insMap = db.prepare(
      'INSERT INTO map_version(version,zone_code,bg_image_url,width,height,status,note) VALUES(?,?,?,?,?,?,?)');
    const m1 = insMap.run(1, 'A', '/maps/bg-v1.svg', 100, 100, 'active', '初版分区图').lastInsertRowid;
    insertShelves(db, m1, shelvesV1);
    const m2 = insMap.run(2, 'A', '/maps/bg-v2.svg', 100, 100, 'draft', '布局更新：A-05/A-06 移至右侧').lastInsertRowid;
    insertShelves(db, m2, shelvesV2); // v2 保持 draft，由调度端发布

    const insSku = db.prepare('INSERT INTO sku(sku,name,unit) VALUES(?,?,?)');
    const skus = [
      ['SKU1001', '六角螺栓 M8x40', 'EA'],
      ['SKU1002', '平垫圈 8mm', 'EA'],
      ['SKU1003', '内六角扳手组', 'SET'],
      ['SKU1004', '工业扎带 200mm', 'EA'],
    ];
    skus.forEach(s => insSku.run(...s));

    const insInv = db.prepare(
      'INSERT INTO inventory(shelf,sku,on_hand,available) VALUES(?,?,?,?)');
    const inv = [
      ['A-01', 'SKU1001', 100, 100],
      ['A-02', 'SKU1002', 60, 60],
      ['A-03', 'SKU1003', 8, 8],
      ['A-04', 'SKU1004', 200, 200],
      ['A-05', 'SKU1002', 5, 5], // v1 下仅 5，制造部分短缺
    ];
    inv.forEach(i => insInv.run(...i));

    const insOrd = db.prepare('INSERT INTO biz_order(order_no) VALUES(?)');
    const oid1 = insOrd.run('SO-20261004-01').lastInsertRowid;
    const oid2 = insOrd.run('SO-20261004-02').lastInsertRowid;

    const insOL = db.prepare(
      'INSERT INTO order_line(order_id,sku,shelf,qty_plan) VALUES(?,?,?,?)');
    [
      [oid1, 'SKU1001', 'A-01', 10],
      [oid1, 'SKU1002', 'A-02', 6],
      [oid1, 'SKU1003', 'A-03', 2],
      [oid1, 'SKU1004', 'A-04', 20],
      [oid2, 'SKU1002', 'A-05', 8], // 需要 8，库存 5 => 部分短缺
      [oid2, 'SKU1001', 'A-01', 3],
    ].forEach(r => insOL.run(...r));

    db.prepare("INSERT INTO op_log(actor,action,detail) VALUES('system','seed','demo data')").run();
  });
  tx();
}

if (require.main === module) {
  const db = openDb();
  seed(db);
  console.log('db initialized at', DB_PATH);
}
module.exports = { openDb, seed, DB_PATH };
