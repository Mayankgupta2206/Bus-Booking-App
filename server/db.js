const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const isVercel = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const defaultDataDir = isVercel ? '/tmp' : path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(defaultDataDir, 'seva.db');
try {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
} catch (e) {
  console.warn('Directory create notice:', e.message);
}

let db;
const isTurso = Boolean(process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN);

if (isTurso) {
  const LibsqlDatabase = require('libsql');
  const TURSO_REPLICA_PATH = path.join(path.dirname(DB_PATH), 'turso_replica.db');
  console.log(`Connecting to Turso Cloud SQLite (${process.env.TURSO_DATABASE_URL})...`);
  db = new LibsqlDatabase(TURSO_REPLICA_PATH, {
    syncUrl: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
    syncPeriod: 30
  });
  try {
    db.sync();
    console.log('Turso Cloud SQLite synced successfully!');
  } catch (err) {
    console.warn('Initial Turso sync notice:', err.message);
  }
} else {
  const Database = require('better-sqlite3');
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
}

try {
  db.pragma('foreign_keys = ON');
} catch (e) {
  /* Libsql pragma notice */
}

let isSyncing = false;
let syncQueued = false;
let syncTimeout = null;

db.syncCloud = () => {
  if (!isTurso || typeof db.sync !== 'function') return;

  if (syncTimeout) clearTimeout(syncTimeout);
  syncTimeout = setTimeout(() => {
    syncTimeout = null;
    if (isSyncing) {
      syncQueued = true;
      return;
    }
    isSyncing = true;
    try {
      db.sync();
    } catch (err) {
      // Suppress transient sync errors gracefully
    } finally {
      isSyncing = false;
      if (syncQueued) {
        syncQueued = false;
        setTimeout(() => db.syncCloud(), 5000);
      }
    }
  }, 10000);
};

try {
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

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  details TEXT,
  performed_by TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trip_archives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id INTEGER,
  trip_date TEXT NOT NULL,
  route_name TEXT,
  bus_name TEXT,
  archive_filename TEXT NOT NULL,
  drive_file_id TEXT,
  drive_web_link TEXT,
  local_path TEXT,
  archive_data TEXT,
  total_bookings INTEGER DEFAULT 0,
  total_seats INTEGER DEFAULT 0,
  total_revenue REAL DEFAULT 0,
  archived_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'Archived'
);

CREATE TABLE IF NOT EXISTS coupons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  discount_type TEXT NOT NULL CHECK(discount_type IN ('flat', 'percent')),
  discount_val REAL NOT NULL,
  min_booking_amount REAL DEFAULT 0,
  valid_until TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS seat_locks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id INTEGER NOT NULL REFERENCES trips(id),
  seat_label TEXT NOT NULL,
  locked_by TEXT NOT NULL,
  session_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE(trip_id, seat_label)
);

CREATE INDEX IF NOT EXISTS idx_booking_seats_booking_id ON booking_seats(booking_id);
CREATE INDEX IF NOT EXISTS idx_bookings_trip_id ON bookings(trip_id);
CREATE INDEX IF NOT EXISTS idx_trips_date_status ON trips(date, status);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_seat_locks_trip ON seat_locks(trip_id, expires_at);

CREATE TABLE IF NOT EXISTS concessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  discount_type TEXT NOT NULL DEFAULT 'percent' CHECK(discount_type IN ('percent', 'flat')),
  discount_val REAL NOT NULL DEFAULT 0,
  min_age INTEGER,
  max_age INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
} catch (e) {
  console.warn('Schema init notice (ignored if provisioned):', e.message);
}

function ensureColumn(table, column, defSql) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${defSql}`);
    }
  } catch (err) {
    // Column already exists or table sync notice
  }
}

ensureColumn('users', 'permissions', 'TEXT');

ensureColumn('routes', 'fare', 'REAL NOT NULL DEFAULT 0');
ensureColumn('routes', 'pickup_points', 'TEXT');
ensureColumn('buses', 'layout_json', 'TEXT');
ensureColumn('bookings', 'booked_by_username', 'TEXT');
ensureColumn('bookings', 'booked_by_role', 'TEXT');
ensureColumn('bookings', 'is_group', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('bookings', 'group_contact', 'TEXT');
ensureColumn('bookings', 'fare_per_seat', 'REAL NOT NULL DEFAULT 0');
ensureColumn('bookings', 'total_amount', 'REAL NOT NULL DEFAULT 0');
ensureColumn('bookings', 'paid_status', "TEXT NOT NULL DEFAULT 'Unpaid'");
ensureColumn('bookings', 'amount_paid', 'REAL NOT NULL DEFAULT 0');
ensureColumn('bookings', 'pickup_point', 'TEXT');
ensureColumn('bookings', 'payment_method', "TEXT NOT NULL DEFAULT 'Cash'");
ensureColumn('bookings', 'discount_amount', 'REAL NOT NULL DEFAULT 0');
ensureColumn('bookings', 'discount_reason', 'TEXT');
ensureColumn('bookings', 'coupon_code', 'TEXT');
ensureColumn('booking_seats', 'boarded', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('booking_seats', 'boarded_at', 'TEXT');
ensureColumn('booking_seats', 'boarded_by', 'TEXT');
ensureColumn('booking_seats', 'concession', 'TEXT');
ensureColumn('booking_seats', 'seat_fare', 'REAL NOT NULL DEFAULT 0');

// Seed starter demo coupons
(function seedCoupons() {
  try {
    const c = db.prepare('SELECT COUNT(*) as cnt FROM coupons').get()?.cnt || 0;
    if (c === 0) {
      const ins = db.prepare('INSERT INTO coupons (code, discount_type, discount_val, min_booking_amount, active) VALUES (?, ?, ?, ?, 1)');
      ins.run('SEVA50', 'flat', 50, 200);
      ins.run('SEVA10', 'percent', 10, 0);
      ins.run('FESTIVAL100', 'flat', 100, 500);
      ins.run('ROUNDTRIP', 'percent', 15, 300);
    }
  } catch (e) {}
})();

// Seed starter dynamic concessions
(function seedConcessions() {
  try {
    const c = db.prepare('SELECT COUNT(*) as cnt FROM concessions').get()?.cnt || 0;
    if (c === 0) {
      const ins = db.prepare('INSERT INTO concessions (name, discount_type, discount_val, min_age, max_age, active) VALUES (?, ?, ?, ?, ?, 1)');
      ins.run('Senior Citizen', 'percent', 20, 60, null);
      ins.run('Child', 'percent', 50, null, 10);
      ins.run('Seva Volunteer / Monk', 'percent', 100, null, null);
    }
  } catch (e) {}
})();

function logAudit(action, entityType, entityId, details, performedBy, role) {
  try {
    db.prepare('INSERT INTO audit_logs (action, entity_type, entity_id, details, performed_by, role) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        String(action || ''),
        String(entityType || ''),
        String(entityId || ''),
        typeof details === 'object' ? JSON.stringify(details) : String(details || ''),
        String(performedBy || 'System'),
        String(role || 'System')
      );
  } catch (err) {
    console.warn('Audit log write notice:', err.message);
  }
}

function flushAuditLogs() {
  // Direct insert writes immediately to SQLite
}

// Backfill historical audit logs for bookings & cancellations if audit_logs is empty
(function backfillHistoricalAuditLogs() {
  try {
    const existing = db.prepare('SELECT COUNT(*) as c FROM audit_logs').get()?.c || 0;
    if (existing === 0) {
      const insertAudit = db.prepare('INSERT INTO audit_logs (action, entity_type, entity_id, details, performed_by, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
      
      // 1. Backfill cancelled bookings
      const cancelled = db.prepare('SELECT * FROM cancelled_bookings').all();
      for (const c of cancelled) {
        insertAudit.run(
          'BOOKING_CANCELLED',
          'BOOKING',
          c.pnr,
          JSON.stringify({
            seats: c.seats_list,
            route: c.route_name,
            bus: c.bus_name,
            reason: c.refund_notes,
            amountPaid: c.amount_paid,
            totalAmount: c.total_amount
          }),
          c.cancelled_by || 'Staff',
          'Admin',
          c.cancelled_at || new Date().toISOString()
        );
      }

      // 2. Backfill active bookings
      const bookings = db.prepare('SELECT * FROM bookings').all();
      for (const b of bookings) {
        const seats = db.prepare('SELECT seat_label FROM booking_seats WHERE booking_id = ?').all(b.id).map(s => s.seat_label);
        insertAudit.run(
          'BOOKING_CREATED',
          'BOOKING',
          b.pnr,
          JSON.stringify({
            seats,
            totalAmount: b.total_amount,
            amountPaid: b.amount_paid,
            paidStatus: b.paid_status,
            paymentMethod: b.payment_method
          }),
          b.booked_by || 'Staff',
          b.booked_by_role || 'Agent',
          b.created_at || new Date().toISOString()
        );
      }
      db.syncCloud();
    }
  } catch (err) {
    console.warn('Audit logs backfill notice:', err.message);
  }
})();


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

const ALL_PERMISSIONS = [
  'can_book',
  'can_cancel',
  'can_collect_payment',
  'can_manifest',
  'can_manage_routes',
  'can_manage_trips',
  'can_manage_buses',
  'can_view_logs',
  'can_manage_users',
  'can_manage_settings'
];

function defaultPermissionsForRole(role) {
  if (role === 'Admin') {
    return ALL_PERMISSIONS.reduce((acc, p) => ({ ...acc, [p]: true }), {});
  }
  if (role === 'Supervisor') {
    return {
      can_book: false,
      can_cancel: true,
      can_collect_payment: true,
      can_manifest: true,
      can_manage_routes: false,
      can_manage_trips: false,
      can_manage_buses: false,
      can_view_logs: true,
      can_manage_users: false,
      can_manage_settings: false,
    };
  }
  // Agent
  return {
    can_book: true,
    can_cancel: true,
    can_collect_payment: false,
    can_manifest: false,
    can_manage_routes: false,
    can_manage_trips: false,
    can_manage_buses: false,
    can_view_logs: false,
    can_manage_users: false,
    can_manage_settings: false,
  };
}

function parseUserPermissions(user) {
  if (!user) return {};
  if (user.role === 'Admin') {
    return defaultPermissionsForRole('Admin');
  }
  if (user.permissions) {
    try {
      const parsed = typeof user.permissions === 'string' ? JSON.parse(user.permissions) : user.permissions;
      if (parsed && typeof parsed === 'object') {
        return { ...defaultPermissionsForRole(user.role), ...parsed };
      }
    } catch (e) { /* ignore */ }
  }
  return defaultPermissionsForRole(user.role);
}

function getSetting(key, defVal = '') {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : defVal;
  } catch (e) {
    return defVal;
  }
}

function setSetting(key, val) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(key), String(val));
  db.syncCloud();
}

db.logAudit = logAudit;
db.flushAuditLogs = flushAuditLogs;
db.helpers = {
  parsePattern,
  defaultLayout,
  countSeats,
  layoutWidth,
  getBusLayout,
  serializeLayout,
  resolvePaidStatus,
  logAudit,
  flushAuditLogs,
  ALL_PERMISSIONS,
  defaultPermissionsForRole,
  parseUserPermissions,
  getSetting,
  setSetting
};
module.exports = db;
