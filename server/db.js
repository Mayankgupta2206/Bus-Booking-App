const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'seva.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('Admin','Agent','Supervisor'))
);

CREATE TABLE IF NOT EXISTS routes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  source TEXT NOT NULL,
  destination TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  fare REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS buses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  rows INTEGER NOT NULL,
  cols INTEGER NOT NULL DEFAULT 4,
  pattern TEXT NOT NULL DEFAULT '2+2',
  layout_json TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS trips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id INTEGER NOT NULL REFERENCES routes(id),
  bus_id INTEGER NOT NULL REFERENCES buses(id),
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Planned' CHECK(status IN ('Planned','Completed','Cancelled'))
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pnr TEXT UNIQUE NOT NULL,
  trip_id INTEGER NOT NULL REFERENCES trips(id),
  booked_by TEXT NOT NULL,
  booked_by_username TEXT,
  booked_by_role TEXT,
  is_group INTEGER NOT NULL DEFAULT 0,
  group_contact TEXT,
  fare_per_seat REAL NOT NULL DEFAULT 0,
  total_amount REAL NOT NULL DEFAULT 0,
  paid_status TEXT NOT NULL DEFAULT 'Unpaid' CHECK(paid_status IN ('Unpaid','Partial','Paid')),
  amount_paid REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS booking_seats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  trip_id INTEGER NOT NULL REFERENCES trips(id),
  seat_label TEXT NOT NULL,
  passenger_name TEXT NOT NULL,
  age INTEGER NOT NULL,
  gender TEXT NOT NULL,
  contact TEXT,
  UNIQUE(trip_id, seat_label)
);

CREATE TABLE IF NOT EXISTS cancelled_bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pnr TEXT NOT NULL,
  trip_id INTEGER NOT NULL,
  route_name TEXT,
  bus_name TEXT,
  trip_date TEXT,
  trip_time TEXT,
  booked_by TEXT,
  cancelled_by TEXT,
  cancelled_at TEXT NOT NULL DEFAULT (datetime('now')),
  seats_list TEXT,
  refund_notes TEXT,
  amount_paid REAL DEFAULT 0,
  total_amount REAL DEFAULT 0
);
`);

function ensureColumn(table, column, defSql) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${defSql}`);
  }
}

ensureColumn('routes', 'fare', 'REAL NOT NULL DEFAULT 0');
ensureColumn('buses', 'layout_json', 'TEXT');
ensureColumn('bookings', 'booked_by_username', 'TEXT');
ensureColumn('bookings', 'booked_by_role', 'TEXT');
ensureColumn('bookings', 'is_group', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('bookings', 'group_contact', 'TEXT');
ensureColumn('bookings', 'fare_per_seat', 'REAL NOT NULL DEFAULT 0');
ensureColumn('bookings', 'total_amount', 'REAL NOT NULL DEFAULT 0');
ensureColumn('bookings', 'paid_status', "TEXT NOT NULL DEFAULT 'Unpaid'");
ensureColumn('bookings', 'amount_paid', 'REAL NOT NULL DEFAULT 0');

// Allow In-Transit on trip status check
(function migrateTripStatusCheck() {
  const sample = db.prepare('SELECT sql FROM sqlite_master WHERE type=? AND name=?').get('table', 'trips');
  if (!sample || !sample.sql || sample.sql.includes('In-Transit')) return;
  db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN;
    CREATE TABLE trips_mig (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      route_id INTEGER NOT NULL REFERENCES routes(id),
      bus_id INTEGER NOT NULL REFERENCES buses(id),
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Planned' CHECK(status IN ('Planned','In-Transit','Completed','Cancelled'))
    );
    INSERT INTO trips_mig (id, route_id, bus_id, date, time, status)
    SELECT id, route_id, bus_id, date, time, status FROM trips;
    DROP TABLE trips;
    ALTER TABLE trips_mig RENAME TO trips;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
  console.log('Migrated trips.status to allow In-Transit.');
})();

// Allow Partial (advance) on paid_status for DBs created with Unpaid/Paid only
(function migratePaidStatusCheck() {
  const sample = db.prepare('SELECT sql FROM sqlite_master WHERE type=? AND name=?').get('table', 'bookings');
  if (!sample || !sample.sql || sample.sql.includes('Partial')) return;
  if (!sample.sql.includes('paid_status')) return;
  db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN;
    CREATE TABLE bookings_mig (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pnr TEXT UNIQUE NOT NULL,
      trip_id INTEGER NOT NULL,
      booked_by TEXT NOT NULL,
      booked_by_username TEXT,
      booked_by_role TEXT,
      is_group INTEGER NOT NULL DEFAULT 0,
      group_contact TEXT,
      fare_per_seat REAL NOT NULL DEFAULT 0,
      total_amount REAL NOT NULL DEFAULT 0,
      paid_status TEXT NOT NULL DEFAULT 'Unpaid' CHECK(paid_status IN ('Unpaid','Partial','Paid')),
      amount_paid REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO bookings_mig
      (id,pnr,trip_id,booked_by,booked_by_username,booked_by_role,is_group,group_contact,
       fare_per_seat,total_amount,paid_status,amount_paid,created_at)
    SELECT id,pnr,trip_id,booked_by,booked_by_username,booked_by_role,is_group,group_contact,
           fare_per_seat,total_amount,
           CASE WHEN paid_status IN ('Unpaid','Partial','Paid') THEN paid_status ELSE 'Unpaid' END,
           amount_paid,created_at
    FROM bookings;
    DROP TABLE bookings;
    ALTER TABLE bookings_mig RENAME TO bookings;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
  console.log('Migrated bookings.paid_status to allow Partial (advance).');
})();

function resolvePaidStatus(amountPaid, totalAmount) {
  const paid = Number(amountPaid) || 0;
  const total = Number(totalAmount) || 0;
  if (paid <= 0) return 'Unpaid';
  if (total > 0 && paid + 0.001 >= total) return 'Paid';
  return 'Partial';
}

function parsePattern(pattern) {
  if (!pattern || typeof pattern !== 'string') return [2, 2];
  const p = pattern.trim().toLowerCase();
  if (p === '2+2') return [2, 2];
  if (p === '2+1') return [2, 1];
  if (p === '1+2') return [1, 2];
  if (p === '1+1') return [1, 1];
  if (p === '3+2') return [3, 2];
  if (p === '2+3') return [2, 3];
  const parts = p.split('+').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n) && n > 0);
  return parts.length ? parts : [2, 2];
}

function defaultLayout(rows, pattern, options = {}) {
  const rowCount = Math.min(Math.max(1, parseInt(rows, 10) || 5), 20);
  const blocks = parsePattern(pattern);
  const rearBench = !!(options && options.rearBench);
  const numbering = (options && options.numbering) || 'row-letter';
  const grid = [];
  const totalCols = blocks.reduce((a, b) => a + b, 0) + (blocks.length - 1);
  let seq = 1;

  for (let r = 1; r <= rowCount; r++) {
    const isRear = rearBench && r === rowCount;
    const row = [];
    if (isRear) {
      for (let c = 0; c < totalCols; c++) {
        let label = '';
        if (numbering === 'seq') label = String(seq++);
        else if (numbering === 'letter-row') label = String.fromCharCode(65 + c) + r;
        else if (numbering === 'sleeper') label = 'S' + (seq++);
        else label = r + String.fromCharCode(65 + c);
        row.push(label);
      }
    } else {
      let seatInRow = 0;
      for (let bi = 0; bi < blocks.length; bi++) {
        if (bi > 0) row.push(null);
        for (let s = 0; s < blocks[bi]; s++) {
          let label = '';
          if (numbering === 'seq') label = String(seq++);
          else if (numbering === 'letter-row') label = String.fromCharCode(65 + seatInRow) + r;
          else if (numbering === 'sleeper') label = 'S' + (seq++);
          else label = r + String.fromCharCode(65 + seatInRow);
          seatInRow++;
          row.push(label);
        }
      }
    }
    grid.push(row);
  }
  return grid;
}

function countSeats(grid) {
  return (grid || []).reduce((n, row) => n + row.filter((c) => c != null && c !== '').length, 0);
}

function layoutWidth(grid) {
  return Math.max(1, ...(grid || []).map((row) => row.length));
}

function getBusLayout(bus) {
  if (bus.layout_json) {
    try {
      const parsed = JSON.parse(bus.layout_json);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch { /* fall through */ }
  }
  return defaultLayout(bus.rows, bus.pattern);
}

function serializeLayout(grid) {
  return JSON.stringify(grid);
}

// Backfill layout_json for buses that don't have one yet
db.prepare('SELECT * FROM buses WHERE layout_json IS NULL OR layout_json = \'\'').all().forEach((bus) => {
  const grid = defaultLayout(bus.rows, bus.pattern);
  db.prepare('UPDATE buses SET layout_json = ?, cols = ? WHERE id = ?')
    .run(serializeLayout(grid), countSeats(grid), bus.id);
});

// Backfill demo fares if still zero
db.prepare('UPDATE routes SET fare = 150 WHERE fare = 0 AND name LIKE ?').run('%Temple%');
db.prepare('UPDATE routes SET fare = 200 WHERE fare = 0 AND name LIKE ?').run('%Hill%');
db.prepare('UPDATE routes SET fare = 100 WHERE fare = 0').run();

function seedIfEmpty() {
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (userCount > 0) {
    const hasSupervisor = db.prepare("SELECT id FROM users WHERE username = 'supervisor'").get();
    if (!hasSupervisor) {
      db.prepare('INSERT INTO users (username,password_hash,name,role) VALUES (?,?,?,?)')
        .run('supervisor', bcrypt.hashSync('supervisor', 10), 'S. Nair', 'Supervisor');
      console.log('Added supervisor demo user.');
    }
    return;
  }

  const insertUser = db.prepare('INSERT INTO users (username,password_hash,name,role) VALUES (?,?,?,?)');
  insertUser.run('admin', bcrypt.hashSync('Admin@321', 10), 'Administrator', 'Admin');
  insertUser.run('agent', bcrypt.hashSync('Agent321', 10), 'Agent', 'Agent');
  insertUser.run('supervisor', bcrypt.hashSync('Supervisor321', 10), 'Supervisor', 'Supervisor');

  const insertRoute = db.prepare('INSERT INTO routes (name,source,destination,fare) VALUES (?,?,?,?)');
  const r1 = insertRoute.run('Temple A → Town B', 'Temple A', 'Town B', 150).lastInsertRowid;
  insertRoute.run('Town B → Hill Shrine', 'Town B', 'Hill Shrine', 200);

  const insertBus = db.prepare('INSERT INTO buses (name,rows,cols,pattern,layout_json) VALUES (?,?,?,?,?)');
  const layout1 = defaultLayout(5, '2+2');
  const layout2 = defaultLayout(5, '2+2');
  const b1 = insertBus.run('Seva Bus 1', 5, countSeats(layout1), '2+2', serializeLayout(layout1)).lastInsertRowid;
  const b2 = insertBus.run('Seva Bus 2', 5, countSeats(layout2), '2+2', serializeLayout(layout2)).lastInsertRowid;

  const today = new Date().toISOString().slice(0, 10);
  const insertTrip = db.prepare('INSERT INTO trips (route_id,bus_id,date,time) VALUES (?,?,?,?)');
  insertTrip.run(r1, b1, today, '06:00');
  insertTrip.run(r1, b2, today, '09:30');

  console.log('Seeded database with demo users, routes, buses, and trips.');
}
seedIfEmpty();

db.helpers = { parsePattern, defaultLayout, countSeats, layoutWidth, getBusLayout, serializeLayout, resolvePaidStatus };
module.exports = db;
