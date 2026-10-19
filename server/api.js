const path = require('path');
const fs = require('fs');
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const { signToken, requireAuth, requireAdmin, requirePerm, requireAgentOrAdmin, requireAdminOrSupervisor } = require('./auth');
const { runBackup, BACKUP_DIR } = require('./backup');
const {
  isTripExpired, runAutoDriveArchive, buildTripArchive, getGoogleDriveClient, getTodayDateIST, ARCHIVES_DIR
} = require('./archive');

const {
  getBusLayout, countSeats, serializeLayout, defaultLayout, resolvePaidStatus, logAudit,
  ALL_PERMISSIONS, defaultPermissionsForRole, parseUserPermissions, getSetting, setSetting
} = db.helpers;
const router = express.Router();

// Rate limiter for login to prevent brute force
const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 25, // limit each IP to 25 login requests per 10 min
  message: { error: 'Too many login attempts from this IP. Please try again after 10 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

function phoneOk(p) {
  const digits = String(p || '').replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15;
}

function enrichBus(bus) {
  const layout = getBusLayout(bus);
  return { ...bus, layout, seatCount: countSeats(layout) };
}

/* ---------- Auth ---------- */
router.post('/auth/login', loginLimiter, async (req, res) => {
  if (req.isPassengerMode) {
    return res.status(403).json({ error: 'Administrative login is disabled on the passenger boarding pass portal.' });
  }
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
  const token = signToken(user);
  logAudit('USER_LOGIN', 'USER', user.username, { name: user.name, role: user.role }, user.name, user.role);
  res.json({
    token,
    user: {
      id: user.id,
      name: user.name,
      role: user.role,
      username: user.username,
      permissions: parseUserPermissions(user)
    }
  });
});

router.post('/auth/logout', requireAuth, (req, res) => {
  logAudit('USER_LOGOUT', 'USER', req.user.username, { name: req.user.name, role: req.user.role }, req.user.name, req.user.role);
  res.json({ ok: true, message: 'Logged out successfully.' });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({
    user: {
      id: req.user.id,
      name: req.user.name,
      role: req.user.role,
      username: req.user.username,
      permissions: req.user.permissions
    }
  });
});

/* ---------- Routes ---------- */
router.get('/routes', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM routes ORDER BY name').all());
});

router.post('/routes', requireAuth, requirePerm('can_manage_routes'), (req, res) => {
  const { name, source, destination, fare, pickupPoints } = req.body || {};
  if (!name || !source || !destination) return res.status(400).json({ error: 'This field is required.' });
  const fareNum = Number(fare);
  if (Number.isNaN(fareNum) || fareNum < 0) return res.status(400).json({ error: 'Fare must be a valid non-negative number.' });
  const pts = pickupPoints ? (typeof pickupPoints === 'string' ? pickupPoints : JSON.stringify(pickupPoints)) : null;
  try {
    const info = db.prepare('INSERT INTO routes (name,source,destination,fare,pickup_points) VALUES (?,?,?,?,?)')
      .run(name, source, destination, fareNum, pts);
    const newRoute = db.prepare('SELECT * FROM routes WHERE id = ?').get(info.lastInsertRowid);
    db.syncCloud();
    logAudit('ROUTE_CREATED', 'ROUTE', newRoute.id, { name, source, destination, fare: fareNum }, req.user.name, req.user.role);
    res.status(201).json(newRoute);
  } catch (e) {
    if (String(e).includes('UNIQUE')) return res.status(409).json({ error: 'A route with this name already exists.' });
    res.status(500).json({ error: 'Could not create route.' });
  }
});

router.patch('/routes/:id', requireAuth, requirePerm('can_manage_routes'), (req, res) => {
  const route = db.prepare('SELECT * FROM routes WHERE id = ?').get(req.params.id);
  if (!route) return res.status(404).json({ error: 'Route not found.' });
  const name = req.body.name != null ? String(req.body.name).trim() : route.name;
  const source = req.body.source != null ? String(req.body.source).trim() : route.source;
  const destination = req.body.destination != null ? String(req.body.destination).trim() : route.destination;
  const active = req.body.active != null ? (req.body.active ? 1 : 0) : route.active;
  const fare = req.body.fare != null ? Number(req.body.fare) : route.fare;
  const pickupPoints = req.body.pickupPoints !== undefined ? (typeof req.body.pickupPoints === 'string' ? req.body.pickupPoints : JSON.stringify(req.body.pickupPoints)) : route.pickup_points;
  if (!name || !source || !destination) return res.status(400).json({ error: 'This field is required.' });
  if (Number.isNaN(fare) || fare < 0) return res.status(400).json({ error: 'Fare must be a valid non-negative number.' });
  try {
    db.prepare('UPDATE routes SET name=?, source=?, destination=?, active=?, fare=?, pickup_points=? WHERE id=?')
      .run(name, source, destination, active, fare, pickupPoints, req.params.id);
    const updated = db.prepare('SELECT * FROM routes WHERE id = ?').get(req.params.id);
    db.syncCloud();
    logAudit('ROUTE_UPDATED', 'ROUTE', req.params.id, { name, fare }, req.user.name, req.user.role);
    res.json(updated);
  } catch (e) {
    if (String(e).includes('UNIQUE')) return res.status(409).json({ error: 'A route with this name already exists.' });
    res.status(500).json({ error: 'Could not update route.' });
  }
});

router.delete('/routes/:id', requireAuth, requirePerm('can_manage_routes'), (req, res) => {
  const route = db.prepare('SELECT * FROM routes WHERE id = ?').get(req.params.id);
  if (!route) return res.status(404).json({ error: 'Route not found.' });
  const force = req.query.force === '1' || req.query.force === 'true' || req.body?.force;
  const tripCount = db.prepare('SELECT COUNT(*) AS c FROM trips WHERE route_id = ?').get(req.params.id).c;
  if (tripCount > 0 && !force) {
    return res.status(409).json({
      error: `This route has ${tripCount} trip(s). Confirm force delete to remove the route, its trips, and related bookings.`,
      tripCount,
      needsForce: true,
    });
  }
  const tx = db.transaction(() => {
    const trips = db.prepare('SELECT id FROM trips WHERE route_id = ?').all(req.params.id);
    for (const t of trips) {
      db.prepare('DELETE FROM booking_seats WHERE trip_id = ?').run(t.id);
      db.prepare('DELETE FROM bookings WHERE trip_id = ?').run(t.id);
      db.prepare('DELETE FROM trips WHERE id = ?').run(t.id);
    }
    db.prepare('DELETE FROM routes WHERE id = ?').run(req.params.id);
  });
  tx();
  logAudit('ROUTE_DELETED', 'ROUTE', route.name, { source: route.source, destination: route.destination, deletedTrips: tripCount }, req.user.name, req.user.role);
  res.json({ ok: true, deletedTrips: tripCount });
});

/* ---------- Users & Powers ---------- */
router.get('/users', requireAuth, requirePerm('can_manage_users'), (req, res) => {
  const users = db.prepare('SELECT id, username, name, role, permissions FROM users ORDER BY role, name').all();
  res.json(users.map((u) => ({
    id: u.id,
    username: u.username,
    name: u.name,
    role: u.role,
    permissions: parseUserPermissions(u)
  })));
});

router.post('/users', requireAuth, requirePerm('can_manage_users'), (req, res) => {
  const { username, password, name, role, permissions } = req.body || {};
  if (!username || !password || !name || !role) {
    return res.status(400).json({ error: 'Username, password, name, and role are required.' });
  }
  if (!['Admin', 'Agent', 'Supervisor'].includes(role)) {
    return res.status(400).json({ error: 'Role must be Admin, Agent, or Supervisor.' });
  }
  if (String(password).length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters.' });
  }
  const permsToSave = permissions && typeof permissions === 'object'
    ? permissions
    : defaultPermissionsForRole(role);
  try {
    const info = db.prepare('INSERT INTO users (username,password_hash,name,role,permissions) VALUES (?,?,?,?,?)')
      .run(String(username).trim(), bcrypt.hashSync(password, 10), String(name).trim(), role, JSON.stringify(permsToSave));
    const created = db.prepare('SELECT id, username, name, role, permissions FROM users WHERE id = ?').get(info.lastInsertRowid);
    db.syncCloud();
    logAudit('USER_CREATED', 'USER', created.id, { username, role }, req.user.name, req.user.role);
    res.status(201).json({
      id: created.id,
      username: created.username,
      name: created.name,
      role: created.role,
      permissions: parseUserPermissions(created)
    });
  } catch (e) {
    if (String(e).includes('UNIQUE')) return res.status(409).json({ error: 'Username already exists.' });
    res.status(500).json({ error: 'Could not create user.' });
  }
});

router.patch('/users/:id', requireAuth, requirePerm('can_manage_users'), (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const name = req.body.name != null ? String(req.body.name).trim() : user.name;
  const role = req.body.role != null ? req.body.role : user.role;
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  if (!['Admin', 'Agent', 'Supervisor'].includes(role)) {
    return res.status(400).json({ error: 'Role must be Admin, Agent, or Supervisor.' });
  }
  if (Number(user.id) === Number(req.user.id) && role !== 'Admin') {
    return res.status(400).json({ error: 'You cannot remove your own Admin role.' });
  }
  if (req.body.password) {
    if (String(req.body.password).length < 4) {
      return res.status(400).json({ error: 'Password must be at least 4 characters.' });
    }
    db.prepare('UPDATE users SET name=?, role=?, password_hash=? WHERE id=?')
      .run(name, role, bcrypt.hashSync(req.body.password, 10), req.params.id);
  } else {
    db.prepare('UPDATE users SET name=?, role=? WHERE id=?').run(name, role, req.params.id);
  }
  db.syncCloud();
  logAudit('USER_UPDATED', 'USER', req.params.id, { name, role }, req.user.name, req.user.role);
  const updated = db.prepare('SELECT id, username, name, role, permissions FROM users WHERE id = ?').get(req.params.id);
  res.json({
    id: updated.id,
    username: updated.username,
    name: updated.name,
    role: updated.role,
    permissions: parseUserPermissions(updated)
  });
});

/* Update specific permissions / powers for a user */
router.patch('/users/:id/permissions', requireAuth, requirePerm('can_manage_users'), (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const { permissions } = req.body || {};
  if (!permissions || typeof permissions !== 'object') {
    return res.status(400).json({ error: 'Valid permissions object is required.' });
  }

  // Prevent admin from removing their own power to manage users
  if (Number(user.id) === Number(req.user.id) && permissions.can_manage_users === false) {
    return res.status(400).json({ error: 'You cannot revoke user management powers from your own account.' });
  }

  db.prepare('UPDATE users SET permissions = ? WHERE id = ?').run(JSON.stringify(permissions), req.params.id);
  db.syncCloud();
  logAudit('USER_PERMISSIONS_UPDATED', 'USER', req.params.id, { username: user.username, permissions }, req.user.name, req.user.role);
  const updated = db.prepare('SELECT id, username, name, role, permissions FROM users WHERE id = ?').get(req.params.id);
  res.json({
    id: updated.id,
    username: updated.username,
    name: updated.name,
    role: updated.role,
    permissions: parseUserPermissions(updated)
  });
});

router.delete('/users/:id', requireAuth, requirePerm('can_manage_users'), (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  if (Number(user.id) === Number(req.user.id)) {
    return res.status(400).json({ error: 'You cannot delete your own account.' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  db.syncCloud();
  logAudit('USER_DELETED', 'USER', req.params.id, { username: user.username }, req.user.name, req.user.role);
  res.json({ ok: true });
});

/* ---------- Buses ---------- */
router.get('/buses', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM buses ORDER BY name').all().map(enrichBus));
});

function validateLayout(layout) {
  if (!Array.isArray(layout) || layout.length < 1 || layout.length > 20) {
    return 'Layout must have between 1 and 20 rows.';
  }
  const labels = new Set();
  let seats = 0;
  for (const row of layout) {
    if (!Array.isArray(row) || row.length < 1 || row.length > 12) {
      return 'Each layout row must have between 1 and 12 cells.';
    }
    for (const cell of row) {
      if (cell == null || cell === '') continue;
      const lab = String(cell).trim();
      if (!lab) continue;
      if (labels.has(lab)) return `Duplicate seat label: ${lab}`;
      labels.add(lab);
      seats += 1;
    }
  }
  if (seats < 1) return 'Layout must include at least one seat.';
  return null;
}

router.post('/buses', requireAuth, requirePerm('can_manage_buses'), (req, res) => {
  const { name, rows, cols, pattern, layout, active } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Bus name is required.' });
  let grid = layout;
  if (!grid) {
    const rowCount = Number(rows) || 5;
    if (!Number.isInteger(rowCount) || rowCount < 1 || rowCount > 20) {
      return res.status(400).json({ error: 'Rows must be a whole number between 1 and 20.' });
    }
    grid = defaultLayout(rowCount, pattern || '2+2');
  }
  const layoutErr = validateLayout(grid);
  if (layoutErr) return res.status(400).json({ error: layoutErr });
  try {
    const seatCount = countSeats(grid);
    const info = db.prepare('INSERT INTO buses (name,rows,cols,pattern,layout_json,active) VALUES (?,?,?,?,?,?)')
      .run(name, grid.length, seatCount, pattern || 'custom', serializeLayout(grid), active === false ? 0 : 1);
    logAudit('BUS_CREATED', 'BUS', name, { seatCount, rows: grid.length, pattern: pattern || 'custom' }, req.user.name, req.user.role);
    res.status(201).json(enrichBus(db.prepare('SELECT * FROM buses WHERE id = ?').get(info.lastInsertRowid)));
  } catch (e) {
    if (String(e).includes('UNIQUE')) return res.status(409).json({ error: 'A bus with this name already exists.' });
    res.status(500).json({ error: 'Could not create bus.' });
  }
});

router.patch('/buses/:id', requireAuth, requirePerm('can_manage_buses'), (req, res) => {
  const bus = db.prepare('SELECT * FROM buses WHERE id = ?').get(req.params.id);
  if (!bus) return res.status(404).json({ error: 'Bus not found.' });
  const name = req.body.name != null ? String(req.body.name).trim() : bus.name;
  const pattern = req.body.pattern != null ? String(req.body.pattern).trim() : bus.pattern;
  const active = req.body.active != null ? (req.body.active ? 1 : 0) : bus.active;
  let grid = req.body.layout != null ? req.body.layout : getBusLayout(bus);
  if (req.body.layout == null && req.body.rows != null && req.body.pattern) {
    grid = defaultLayout(Number(req.body.rows), req.body.pattern);
  }
  if (!name) return res.status(400).json({ error: 'Bus name is required.' });
  const layoutErr = validateLayout(grid);
  if (layoutErr) return res.status(400).json({ error: layoutErr });
  try {
    const seatCount = countSeats(grid);
    db.prepare('UPDATE buses SET name=?, rows=?, cols=?, pattern=?, layout_json=?, active=? WHERE id=?')
      .run(name, grid.length, seatCount, pattern || 'custom', serializeLayout(grid), active, req.params.id);
    logAudit('BUS_UPDATED', 'BUS', name, { seatCount, rows: grid.length, pattern: pattern || 'custom', active }, req.user.name, req.user.role);
    res.json(enrichBus(db.prepare('SELECT * FROM buses WHERE id = ?').get(req.params.id)));
  } catch (e) {
    if (String(e).includes('UNIQUE')) return res.status(409).json({ error: 'A bus with this name already exists.' });
    res.status(500).json({ error: 'Could not update bus.' });
  }
});

router.delete('/buses/:id', requireAuth, requirePerm('can_manage_buses'), (req, res) => {
  const bus = db.prepare('SELECT * FROM buses WHERE id = ?').get(req.params.id);
  if (!bus) return res.status(404).json({ error: 'Bus not found.' });
  const force = req.query.force === '1' || req.query.force === 'true' || req.body?.force;
  const tripCount = db.prepare('SELECT COUNT(*) AS c FROM trips WHERE bus_id = ?').get(req.params.id).c;
  if (tripCount > 0 && !force) {
    return res.status(409).json({
      error: `This bus is assigned to ${tripCount} trip(s). Confirm force delete to remove the bus, its trips, and related bookings.`,
      tripCount,
      needsForce: true,
    });
  }
  const tx = db.transaction(() => {
    const trips = db.prepare('SELECT id FROM trips WHERE bus_id = ?').all(req.params.id);
    for (const t of trips) {
      db.prepare('DELETE FROM booking_seats WHERE trip_id = ?').run(t.id);
      db.prepare('DELETE FROM bookings WHERE trip_id = ?').run(t.id);
      db.prepare('DELETE FROM trips WHERE id = ?').run(t.id);
    }
    db.prepare('DELETE FROM buses WHERE id = ?').run(req.params.id);
  });
  tx();
  logAudit('BUS_DELETED', 'BUS', bus.name, { deletedTrips: tripCount }, req.user.name, req.user.role);
  res.json({ ok: true, deletedTrips: tripCount });
});

/* ---------- Trips ---------- */
router.get('/trips', requireAuth, (req, res) => {
  const { routeId, date, status } = req.query;
  let sql = `SELECT t.*, r.name AS route_name, r.fare AS fare, b.name AS bus_name,
                    b.rows AS bus_rows, b.cols AS bus_cols, b.layout_json
             FROM trips t
             JOIN routes r ON r.id = t.route_id
             JOIN buses b ON b.id = t.bus_id
             WHERE 1=1`;
  const params = [];
  if (routeId) { sql += ' AND t.route_id = ?'; params.push(routeId); }
  if (date) { sql += ' AND t.date = ?'; params.push(date); }
  if (status) { sql += ' AND t.status = ?'; params.push(status); }
  sql += ' ORDER BY t.date, t.time';
  const trips = db.prepare(sql).all(...params);
  const withAvail = trips.map((t) => {
    const layout = getBusLayout(t);
    const total = countSeats(layout);
    const booked = db.prepare('SELECT COUNT(*) AS c FROM booking_seats WHERE trip_id = ?').get(t.id).c;
    return { ...t, totalSeats: total, bookedSeats: booked, availableSeats: total - booked, fare: t.fare };
  });
  res.json(withAvail);
});

router.post('/trips', requireAuth, requirePerm('can_manage_trips'), (req, res) => {
  const { routeId, busId, date, time } = req.body || {};
  if (!routeId || !busId || !date || !time) return res.status(400).json({ error: 'This field is required.' });
  const route = db.prepare('SELECT * FROM routes WHERE id = ?').get(routeId);
  const bus = db.prepare('SELECT * FROM buses WHERE id = ?').get(busId);
  if (!route) return res.status(400).json({ error: 'Route not found.' });
  if (!bus) return res.status(400).json({ error: 'Bus not found.' });
  if (!route.active) return res.status(400).json({ error: 'Cannot schedule a trip on an inactive route.' });
  if (!bus.active) return res.status(400).json({ error: 'Cannot schedule a trip on an inactive bus.' });
  const info = db.prepare('INSERT INTO trips (route_id,bus_id,date,time) VALUES (?,?,?,?)').run(routeId, busId, date, time);
  const trip = db.prepare(`SELECT t.*, r.name AS route_name, r.fare AS fare, b.name AS bus_name,
                                  b.rows AS bus_rows, b.cols AS bus_cols
                           FROM trips t
                           JOIN routes r ON r.id = t.route_id
                           JOIN buses b ON b.id = t.bus_id
                           WHERE t.id = ?`).get(info.lastInsertRowid);
  logAudit('TRIP_SCHEDULED', 'TRIP', String(trip.id), { route: trip.route_name, bus: trip.bus_name, date, time }, req.user.name, req.user.role);
  res.status(201).json(trip);
});

/* Bulk / Recurring Trip Scheduler */
router.post('/trips/recurring', requireAuth, requirePerm('can_manage_trips'), (req, res) => {
  const { routeId, busId, startDate, endDate, time, daysOfWeek } = req.body || {};
  if (!routeId || !busId || !startDate || !endDate || !time) {
    return res.status(400).json({ error: 'Route, Bus, Start Date, End Date, and Time are required.' });
  }
  const route = db.prepare('SELECT * FROM routes WHERE id = ?').get(routeId);
  const bus = db.prepare('SELECT * FROM buses WHERE id = ?').get(busId);
  if (!route || !bus) return res.status(400).json({ error: 'Route or Bus not found.' });
  if (!route.active) return res.status(400).json({ error: 'Cannot schedule trips on an inactive route.' });
  if (!bus.active) return res.status(400).json({ error: 'Cannot schedule trips on an inactive bus.' });

  const start = new Date(startDate);
  const end = new Date(endDate);
  if (start > end) return res.status(400).json({ error: 'Start date cannot be after end date.' });

  const activeDays = Array.isArray(daysOfWeek) && daysOfWeek.length ? daysOfWeek.map(Number) : [0, 1, 2, 3, 4, 5, 6];

  const createdTrips = [];
  const insertTrip = db.prepare('INSERT INTO trips (route_id, bus_id, date, time) VALUES (?, ?, ?, ?)');
  const checkExisting = db.prepare('SELECT id FROM trips WHERE route_id = ? AND bus_id = ? AND date = ? AND time = ?');

  const cur = new Date(start);
  while (cur <= end) {
    const day = cur.getDay();
    if (activeDays.includes(day)) {
      const dateStr = cur.toISOString().slice(0, 10);
      const exists = checkExisting.get(routeId, busId, dateStr, time);
      if (!exists) {
        const info = insertTrip.run(routeId, busId, dateStr, time);
        createdTrips.push({ id: info.lastInsertRowid, date: dateStr, time });
      }
    }
    cur.setDate(cur.getDate() + 1);
  }

  db.syncCloud();
  logAudit('RECURRING_TRIPS_SCHEDULED', 'TRIP', `${createdTrips.length} trips`, {
    route: route.name, bus: bus.name, startDate, endDate, time, count: createdTrips.length
  }, req.user.name, req.user.role);

  res.status(201).json({ success: true, count: createdTrips.length, createdTrips });
});

router.patch('/trips/:id/cancel', requireAuth, requirePerm('can_manage_trips'), (req, res) => {
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found.' });
  if (trip.status === 'Cancelled') return res.json({ ok: true, status: 'Cancelled' });
  db.prepare("UPDATE trips SET status = 'Cancelled' WHERE id = ?").run(req.params.id);
  logAudit('TRIP_CANCELLED', 'TRIP', String(trip.id), { routeId: trip.route_id, date: trip.date, time: trip.time }, req.user.name, req.user.role);
  res.json({ ok: true, status: 'Cancelled' });
});

router.patch('/trips/:id/status', requireAuth, requirePerm('can_manage_trips'), (req, res) => {
  const { status } = req.body || {};
  const validStatuses = ['Planned', 'In-Transit', 'Completed', 'Cancelled'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
  }
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found.' });
  db.prepare('UPDATE trips SET status = ? WHERE id = ?').run(status, req.params.id);
  logAudit('TRIP_STATUS_UPDATED', 'TRIP', String(trip.id), { previousStatus: trip.status, newStatus: status, date: trip.date, time: trip.time }, req.user.name, req.user.role);
  res.json({ ok: true, id: trip.id, status });
});

router.delete('/trips/:id', requireAuth, requirePerm('can_manage_trips'), (req, res) => {
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found.' });
  const force = req.query.force === '1' || req.query.force === 'true' || req.body?.force;
  const booked = db.prepare('SELECT COUNT(*) AS c FROM booking_seats WHERE trip_id = ?').get(req.params.id).c;
  if (booked > 0 && !force) {
    return res.status(409).json({
      error: `This trip has ${booked} booked seat(s). Confirm force delete to remove the trip and its bookings.`,
      booked,
      needsForce: true,
    });
  }
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM booking_seats WHERE trip_id = ?').run(req.params.id);
    db.prepare('DELETE FROM bookings WHERE trip_id = ?').run(req.params.id);
    db.prepare('DELETE FROM trips WHERE id = ?').run(req.params.id);
  });
  tx();
  logAudit('TRIP_DELETED', 'TRIP', String(trip.id), { date: trip.date, time: trip.time }, req.user.name, req.user.role);
  res.json({ ok: true });
});

router.get('/trips/:id', requireAuth, (req, res) => {
  const t = db.prepare(`SELECT t.*, r.name AS route_name, r.source, r.destination, r.fare AS fare,
                                b.name AS bus_name, b.rows AS bus_rows, b.cols AS bus_cols, b.layout_json
                         FROM trips t
                         JOIN routes r ON r.id = t.route_id
                         JOIN buses b ON b.id = t.bus_id
                         WHERE t.id = ?`).get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Trip not found.' });
  const layout = getBusLayout(t);
  res.json({ ...t, totalSeats: countSeats(layout), layout });
});

router.get('/trips/:id/seats', requireAuth, (req, res) => {
  const t = db.prepare(`SELECT t.*, r.name AS route_name, r.source, r.destination, r.fare AS fare,
                                b.name AS bus_name, b.rows AS bus_rows, b.cols AS bus_cols, b.layout_json, b.pattern
                         FROM trips t
                         JOIN routes r ON r.id = t.route_id
                         JOIN buses b ON b.id = t.bus_id
                         WHERE t.id = ?`).get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Trip not found.' });

  const now = Date.now();
  const seats = db.prepare(`SELECT bs.id, bs.seat_label, bs.passenger_name, bs.age, bs.gender, bs.contact,
                                    bs.boarded, bs.boarded_at, bs.boarded_by, bs.concession, bs.seat_fare,
                                    bk.pnr, bk.booked_by, bk.booked_by_username, bk.booked_by_role,
                                    bk.paid_status, bk.amount_paid, bk.total_amount, bk.is_group, bk.created_at,
                                    bk.fare_per_seat, bk.discount_amount, bk.discount_reason, bk.coupon_code
                             FROM booking_seats bs
                             JOIN bookings bk ON bk.id = bs.booking_id
                             WHERE bs.trip_id = ?`).all(req.params.id);
  const booked = {};
  seats.forEach((s) => { booked[s.seat_label] = s; });

  // High-performance index query for active locks without blocking write transaction
  const activeLocks = db.prepare('SELECT seat_label, locked_by, session_id, expires_at FROM seat_locks WHERE trip_id = ? AND expires_at > ?').all(req.params.id, now);
  const locked = {};
  activeLocks.forEach((l) => { locked[l.seat_label] = l; });

  const grid = getBusLayout(t);
  const seatCount = countSeats(grid);
  const trip = { ...t, totalSeats: seatCount, layout: grid };
  res.json({ trip, grid, booked, locked, seatCount });
});

/* Complete All-in-One Trip Report (HTML & CSV) */
router.get('/trips/:id/report', requireAuth, async (req, res) => {
  try {
    const archiveData = await buildTripArchive(req.params.id);
    if (req.query.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="trip_${req.params.id}_complete_manifest.csv"`);
      return res.send(archiveData.csvContent);
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(archiveData.htmlContent);
  } catch (err) {
    res.status(500).send('Failed to generate trip report: ' + err.message);
  }
});

/* Temporary Seat Lock & Unlock */
router.post('/trips/:id/seats/lock', requireAuth, (req, res) => {
  const { seatLabel, sessionId } = req.body || {};
  if (!seatLabel) return res.status(400).json({ error: 'seatLabel is required.' });

  const tripId = Number(req.params.id);
  const now = Date.now();

  // Check if seat is already booked
  const isBooked = db.prepare('SELECT id FROM booking_seats WHERE trip_id = ? AND seat_label = ?').get(tripId, String(seatLabel));
  if (isBooked) return res.status(409).json({ error: `Seat ${seatLabel} is already booked.` });

  // Check if seat is locked by someone else and lock has not expired
  const existingLock = db.prepare('SELECT * FROM seat_locks WHERE trip_id = ? AND seat_label = ?').get(tripId, String(seatLabel));
  if (existingLock && existingLock.expires_at > now && existingLock.session_id !== sessionId) {
    return res.status(409).json({
      error: `Seat ${seatLabel} is temporarily on hold by ${existingLock.locked_by}. Please choose another seat.`,
      lockedBy: existingLock.locked_by
    });
  }

  // 5 minutes lock
  const expiresAt = now + 5 * 60 * 1000;
  try {
    db.prepare(`
      INSERT INTO seat_locks (trip_id, seat_label, locked_by, session_id, expires_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(trip_id, seat_label) DO UPDATE SET
        locked_by = excluded.locked_by,
        session_id = excluded.session_id,
        expires_at = excluded.expires_at
    `).run(tripId, String(seatLabel), req.user.name, sessionId || req.user.username, expiresAt);
  } catch (e) {
    console.warn('Seat lock notice:', e.message);
    return res.status(500).json({ error: 'Failed to acquire seat lock. Please try again.' });
  }

  res.json({ success: true, seatLabel, expiresAt });
});

router.post('/trips/:id/seats/unlock', requireAuth, (req, res) => {
  const { seatLabel, sessionId } = req.body || {};
  if (!seatLabel) return res.status(400).json({ error: 'seatLabel is required.' });
  try {
    db.prepare('DELETE FROM seat_locks WHERE trip_id = ? AND seat_label = ? AND (session_id = ? OR locked_by = ?)').run(
      Number(req.params.id), String(seatLabel), sessionId || '', req.user.name
    );
  } catch (e) {
    console.warn('Seat unlock notice:', e.message);
  }
  res.json({ success: true, seatLabel });
});

/* ---------- Coupons & Discounts ---------- */
router.get('/coupons', requireAuth, (req, res) => {
  const coupons = db.prepare('SELECT id, code, discount_type, discount_val, min_booking_amount, valid_until, active FROM coupons WHERE active = 1 ORDER BY code').all();
  res.json(coupons);
});

router.post('/coupons/validate', requireAuth, (req, res) => {
  const { code, grossAmount } = req.body || {};
  if (!code) return res.status(400).json({ error: 'Coupon code is required.' });
  const coupon = db.prepare('SELECT * FROM coupons WHERE UPPER(code) = ? AND active = 1').get(String(code).trim().toUpperCase());
  if (!coupon) return res.status(404).json({ error: 'Invalid or inactive coupon code.' });

  const today = getTodayDateIST();
  if (coupon.valid_until && coupon.valid_until < today) {
    return res.status(400).json({ error: `Coupon ${coupon.code} expired on ${coupon.valid_until}.` });
  }

  const gross = Number(grossAmount) || 0;
  if (coupon.min_booking_amount > 0 && gross < coupon.min_booking_amount) {
    return res.status(400).json({ error: `Minimum booking amount of ₹${coupon.min_booking_amount} required for this coupon.` });
  }

  let discount = 0;
  if (coupon.discount_type === 'flat') {
    discount = Math.min(gross, Number(coupon.discount_val));
  } else if (coupon.discount_type === 'percent') {
    discount = Math.min(gross, Math.round((gross * Number(coupon.discount_val)) / 100));
  }

  res.json({
    valid: true,
    code: coupon.code,
    discountType: coupon.discount_type,
    discountVal: coupon.discount_val,
    discountAmount: discount,
    finalAmount: Math.max(0, gross - discount)
  });
});

/* ---------- Dynamic Concessions & Policies ---------- */
router.get('/concessions', requireAuth, (req, res) => {
  const list = db.prepare('SELECT id, name, discount_type, discount_val, min_age, max_age, active FROM concessions WHERE active = 1 ORDER BY id ASC').all();
  res.json(list);
});

router.get('/admin/concessions', requireAuth, requireAdmin, (req, res) => {
  const list = db.prepare('SELECT * FROM concessions ORDER BY id ASC').all();
  res.json(list);
});

router.post('/admin/concessions', requireAuth, requireAdmin, (req, res) => {
  const { name, discount_type, discount_val, min_age, max_age, active } = req.body || {};
  if (!name || discount_val == null) return res.status(400).json({ error: 'Name and discount value are required.' });
  const type = discount_type === 'flat' ? 'flat' : 'percent';
  const val = Math.max(0, Number(discount_val));
  if (type === 'percent' && val > 100) return res.status(400).json({ error: 'Percentage discount cannot exceed 100%.' });
  const minA = min_age != null && min_age !== '' ? Number(min_age) : null;
  const maxA = max_age != null && max_age !== '' ? Number(max_age) : null;
  const act = active === false || active === 0 ? 0 : 1;
  try {
    const info = db.prepare('INSERT INTO concessions (name, discount_type, discount_val, min_age, max_age, active) VALUES (?, ?, ?, ?, ?, ?)')
      .run(String(name).trim(), type, val, minA, maxA, act);
    db.syncCloud();
    res.status(201).json({ ok: true, id: info.lastInsertRowid, message: 'Concession created successfully.' });
  } catch (e) {
    if (String(e).includes('UNIQUE')) return res.status(409).json({ error: 'A concession with this name already exists.' });
    res.status(500).json({ error: e.message });
  }
});

router.put('/admin/concessions/:id', requireAuth, requireAdmin, (req, res) => {
  const { name, discount_type, discount_val, min_age, max_age, active } = req.body || {};
  const conc = db.prepare('SELECT * FROM concessions WHERE id = ?').get(req.params.id);
  if (!conc) return res.status(404).json({ error: 'Concession not found.' });
  const newName = name ? String(name).trim() : conc.name;
  const type = discount_type ? (discount_type === 'flat' ? 'flat' : 'percent') : conc.discount_type;
  const val = discount_val != null ? Math.max(0, Number(discount_val)) : conc.discount_val;
  if (type === 'percent' && val > 100) return res.status(400).json({ error: 'Percentage discount cannot exceed 100%.' });
  const minA = min_age !== undefined ? (min_age !== '' && min_age != null ? Number(min_age) : null) : conc.min_age;
  const maxA = max_age !== undefined ? (max_age !== '' && max_age != null ? Number(max_age) : null) : conc.max_age;
  const act = active !== undefined ? (active ? 1 : 0) : conc.active;
  try {
    db.prepare('UPDATE concessions SET name = ?, discount_type = ?, discount_val = ?, min_age = ?, max_age = ?, active = ? WHERE id = ?')
      .run(newName, type, val, minA, maxA, act, req.params.id);
    db.syncCloud();
    res.json({ ok: true, message: 'Concession updated.' });
  } catch (e) {
    if (String(e).includes('UNIQUE')) return res.status(409).json({ error: 'A concession with this name already exists.' });
    res.status(500).json({ error: e.message });
  }
});

router.delete('/admin/concessions/:id', requireAuth, requireAdmin, (req, res) => {
  db.prepare('DELETE FROM concessions WHERE id = ?').run(req.params.id);
  db.syncCloud();
  res.json({ ok: true, message: 'Concession deleted.' });
});

/* ---------- Bookings ---------- */
router.post('/bookings', requireAuth, requireAgentOrAdmin, (req, res) => {
  const {
    tripId, seats, isGroup, groupContact, paidStatus, amountPaid, pickupPoint, paymentMethod,
    couponCode, discountAmount, discountReason
  } = req.body || {};
  if (!tripId || !Array.isArray(seats) || seats.length === 0) {
    return res.status(400).json({ error: 'Please select at least one seat.' });
  }

  const trip = db.prepare(`SELECT t.*, r.fare AS fare FROM trips t JOIN routes r ON r.id = t.route_id WHERE t.id = ?`).get(tripId);
  if (!trip) return res.status(404).json({ error: 'Trip not found.' });
  if (trip.status !== 'Planned') {
    return res.status(400).json({ error: 'This trip is not open for booking.' });
  }
  if (isTripExpired(trip.date, trip.status)) {
    return res.status(400).json({ error: 'Cannot book seats on a past or completed trip.' });
  }

  const sharedContact = isGroup ? (groupContact || (seats[0] && seats[0].contact)) : null;
  if (isGroup && !phoneOk(sharedContact)) {
    return res.status(400).json({ error: 'A valid phone number is required for group booking.' });
  }

  // Find first adult contact to inherit for young children
  const adultPhone = sharedContact || seats.find(s => phoneOk(s.contact) && Number(s.age || 0) >= 12)?.contact;

  for (const s of seats) {
    if (!s.label || !s.name || s.age === undefined || s.age === '' || !s.gender) {
      return res.status(400).json({ error: 'Please fill all required fields.' });
    }
    const ageNum = Number(s.age);
    if (Number.isNaN(ageNum) || ageNum < 0 || ageNum > 120) {
      return res.status(400).json({ error: 'Please enter a valid age (0–120).' });
    }
    let contact = isGroup ? sharedContact : s.contact;
    // Allow young children under 12 to inherit the lead/adult contact
    if (!contact && ageNum < 12 && adultPhone) {
      contact = adultPhone;
      s.contact = adultPhone;
    }
    if (!phoneOk(contact)) {
      return res.status(400).json({ error: `A valid phone number is required for passenger ${s.name || s.label}.` });
    }
  }

  let farePerSeat = Number(trip.fare) || 0;
  if (pickupPoint) {
    const stageMatch = String(pickupPoint).match(/[₹\$\s-]\s*(\d+(\.\d+)?)/);
    if (stageMatch && Number(stageMatch[1]) > 0) {
      farePerSeat = Number(stageMatch[1]);
    }
  }

  // Load dynamic concessions
  const allConcessions = db.prepare('SELECT name, discount_type, discount_val FROM concessions WHERE active = 1').all();
  const concMap = {};
  allConcessions.forEach((c) => { concMap[c.name.toLowerCase()] = c; });

  // Calculate seat-level concession fares dynamically
  let grossAmount = 0;
  const processedSeats = seats.map((s) => {
    const conc = String(s.concession || 'General').trim();
    let seatFare = farePerSeat;
    const rule = concMap[conc.toLowerCase()];
    if (rule) {
      if (rule.discount_type === 'flat') {
        seatFare = Math.max(0, farePerSeat - Number(rule.discount_val));
      } else {
        const pct = Math.min(100, Math.max(0, Number(rule.discount_val)));
        seatFare = Math.max(0, Math.round(farePerSeat * (1 - pct / 100)));
      }
    } else {
      // Fallback
      if (conc === 'Senior Citizen') seatFare = Math.round(farePerSeat * 0.8);
      else if (conc === 'Child') seatFare = Math.round(farePerSeat * 0.5);
      else if (conc === 'Seva Volunteer / Monk') seatFare = 0;
    }
    grossAmount += seatFare;
    return { ...s, concession: conc, seatFare };
  });

  // Calculate discounts (coupon + manual)
  let totalDiscount = 0;
  let appliedCoupon = null;
  if (couponCode) {
    const coupon = db.prepare('SELECT * FROM coupons WHERE UPPER(code) = ? AND active = 1').get(String(couponCode).trim().toUpperCase());
    if (coupon) {
      appliedCoupon = coupon.code;
      if (coupon.discount_type === 'flat') {
        totalDiscount += Math.min(grossAmount, Number(coupon.discount_val));
      } else {
        totalDiscount += Math.min(grossAmount, Math.round((grossAmount * Number(coupon.discount_val)) / 100));
      }
    }
  }

  const manualDisc = Number(discountAmount) || 0;
  if (manualDisc > 0) {
    totalDiscount += manualDisc;
  }
  totalDiscount = Math.min(grossAmount, totalDiscount);
  const totalAmount = Math.max(0, grossAmount - totalDiscount);

  let paidAmt = amountPaid != null ? Number(amountPaid) : 0;
  if (Number.isNaN(paidAmt) || paidAmt < 0) {
    return res.status(400).json({ error: 'Advance / amount paid must be a valid number.' });
  }
  if (paidAmt > totalAmount + 0.001) {
    return res.status(400).json({ error: 'Amount paid cannot exceed total fare.' });
  }
  // Explicit Paid with no amount → treat as full payment
  if (paidStatus === 'Paid' && (amountPaid == null || amountPaid === '')) paidAmt = totalAmount;
  if (paidStatus === 'Unpaid' && amountPaid == null) paidAmt = 0;
  const status = resolvePaidStatus(paidAmt, totalAmount);
  const method = paymentMethod || 'Cash';

  // Collision-safe PNR generator
  let pnr;
  let attempts = 0;
  while (!pnr && attempts < 10) {
    const candidate = 'PNR' + Math.floor(100000 + Math.random() * 900000);
    const existing = db.prepare('SELECT id FROM bookings WHERE pnr = ?').get(candidate);
    if (!existing) {
      pnr = candidate;
      break;
    }
    attempts++;
  }
  if (!pnr) pnr = 'PNR' + Date.now().toString().slice(-6);

  let bookingId;
  // Ensure seats are inserted in natural serial order (1, 2... 10... or 1A, 1B...)
  processedSeats.sort((a, b) => String(a.label).localeCompare(String(b.label), undefined, { numeric: true, sensitivity: 'base' }));

  const tx = db.transaction(() => {
    const bookingInfo = db.prepare(`INSERT INTO bookings
      (pnr, trip_id, booked_by, booked_by_username, booked_by_role, is_group, group_contact,
       fare_per_seat, total_amount, paid_status, amount_paid, pickup_point, payment_method,
       discount_amount, discount_reason, coupon_code)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      pnr, tripId, req.user.name, req.user.username, req.user.role,
      isGroup ? 1 : 0, isGroup ? sharedContact : null,
      farePerSeat, totalAmount, status, paidAmt, pickupPoint || null, method,
      totalDiscount, discountReason || null, appliedCoupon || null
    );
    bookingId = bookingInfo.lastInsertRowid;
    const insertSeat = db.prepare(`INSERT INTO booking_seats (booking_id,trip_id,seat_label,passenger_name,age,gender,contact,concession,seat_fare)
                                    VALUES (?,?,?,?,?,?,?,?,?)`);
    for (const s of processedSeats) {
      const contact = isGroup ? sharedContact : (s.contact || adultPhone);
      insertSeat.run(bookingId, tripId, s.label, s.name, s.age, s.gender, contact, s.concession, s.seatFare);
    }
  });

  try {
    tx();
    db.syncCloud();
    logAudit('BOOKING_CREATED', 'BOOKING', pnr, {
      seats: processedSeats.map(s => s.label),
      grossAmount,
      discount: totalDiscount,
      coupon: appliedCoupon,
      totalAmount,
      amountPaid: paidAmt,
      paidStatus: status,
      paymentMethod: method,
      pickupPoint
    }, req.user.name, req.user.role);
  } catch (e) {
    if (String(e).includes('UNIQUE')) {
      return res.status(409).json({ error: 'One or more selected seats are no longer available. Please refresh and try again.' });
    }
    return res.status(500).json({ error: 'Could not complete booking: ' + e.message });
  }

  res.status(201).json({
    pnr, tripId, seats: processedSeats, bookingId,
    farePerSeat, grossAmount, discountAmount: totalDiscount, couponCode: appliedCoupon,
    totalAmount, paidStatus: status, amountPaid: paidAmt,
    paymentMethod: method,
    pickupPoint: pickupPoint || null,
    bookedBy: { name: req.user.name, username: req.user.username, role: req.user.role },
  });
});

router.get('/bookings', requireAuth, (req, res) => {
  const { tripId, bookedBy } = req.query;
  if (!tripId) return res.status(400).json({ error: 'tripId is required.' });
  let sql = 'SELECT * FROM bookings WHERE trip_id = ?';
  const params = [tripId];
  if (bookedBy) { sql += ' AND booked_by_username = ?'; params.push(bookedBy); }
  // Agents only see their own bookings on manifest filters unless Admin/Supervisor
  if (req.user.role === 'Agent' && req.query.mine === '1') {
    sql += ' AND booked_by_username = ?';
    params.push(req.user.username);
  }
  sql += ' ORDER BY created_at';
  const bookings = db.prepare(sql).all(...params);
  const result = bookings.map((b) => ({
    ...b,
    seats: db.prepare('SELECT * FROM booking_seats WHERE booking_id = ? ORDER BY CAST(seat_label AS INTEGER), seat_label ASC').all(b.id),
  }));
  res.json(result);
});

/* ---------- Global PNR / Phone / Passenger Search ---------- */
router.get('/bookings/search', requireAuth, (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q || q.length < 2) {
    return res.json({ bookings: [], cancelled: [] });
  }
  const term = `%${q}%`;
  const cleanDigits = q.replace(/\D/g, '');
  const phoneTerm = cleanDigits.length >= 4 ? `%${cleanDigits}%` : term;

  const bookings = db.prepare(`
    SELECT DISTINCT b.*, t.date AS trip_date, t.time AS trip_time, t.status AS trip_status,
                    r.name AS route_name, r.source, r.destination, bu.name AS bus_name
    FROM bookings b
    JOIN trips t ON t.id = b.trip_id
    JOIN routes r ON r.id = t.route_id
    JOIN buses bu ON bu.id = t.bus_id
    LEFT JOIN booking_seats bs ON bs.booking_id = b.id
    WHERE b.pnr LIKE ?
       OR b.group_contact LIKE ?
       OR b.booked_by LIKE ?
       OR b.pickup_point LIKE ?
       OR bs.passenger_name LIKE ?
       OR bs.contact LIKE ?
       OR bs.seat_label LIKE ?
       OR r.name LIKE ?
       OR bu.name LIKE ?
    ORDER BY t.date DESC, b.id DESC
    LIMIT 30
  `).all(term, phoneTerm, term, term, term, phoneTerm, term, term, term);

  const withSeats = bookings.map((b) => ({
    ...b,
    seats: db.prepare('SELECT * FROM booking_seats WHERE booking_id = ? ORDER BY CAST(seat_label AS INTEGER), seat_label ASC').all(b.id),
  }));

  const cancelled = db.prepare(`
    SELECT * FROM cancelled_bookings
    WHERE pnr LIKE ? OR seats_list LIKE ? OR booked_by LIKE ? OR route_name LIKE ? OR cancelled_by LIKE ?
    ORDER BY id DESC
    LIMIT 15
  `).all(term, term, term, term, term);

  res.json({ bookings: withSeats, cancelled });
});

/* ---------- Public Pass Lookup (Search by PNR or Mobile Number - No auth required for passengers) ---------- */
router.get(['/public/pass', '/public/pass/:pnr'], (req, res) => {
  const raw = String(req.params.pnr || req.query.pnr || req.query.phone || req.query.q || '').trim();
  if (!raw) return res.status(400).json({ error: 'PNR or Mobile number is required.' });

  const upper = raw.toUpperCase();
  const digits = raw.replace(/\D/g, '');

  const bookingSelectSql = `
    SELECT b.id, b.pnr, b.trip_id, b.total_amount, b.amount_paid, b.paid_status,
           b.fare_per_seat, b.discount_amount, b.discount_reason, b.coupon_code,
           b.pickup_point, b.group_contact, b.booked_by, b.created_at,
           t.date AS trip_date, t.time AS trip_time, t.status AS trip_status,
           r.name AS route_name, r.source, r.destination, bu.name AS bus_name
    FROM bookings b
    JOIN trips t ON t.id = b.trip_id
    JOIN routes r ON r.id = t.route_id
    JOIN buses bu ON bu.id = t.bus_id
  `;

  // 1. Direct exact PNR or 6-digit PNR match
  let directBooking = db.prepare(`${bookingSelectSql} WHERE UPPER(b.pnr) = ?`).get(upper);
  if (!directBooking && /^\d{6}$/.test(digits)) {
    directBooking = db.prepare(`${bookingSelectSql} WHERE UPPER(b.pnr) = ?`).get('PNR' + digits);
  }

  if (directBooking) {
    const expired = isTripExpired(directBooking.trip_date, directBooking.trip_status);
    const seats = db.prepare(`
      SELECT id, seat_label, passenger_name, age, gender, contact, concession, seat_fare, boarded
      FROM booking_seats
      WHERE booking_id = ?
      ORDER BY seat_label ASC
    `).all(directBooking.id);
    return res.json({
      ...directBooking,
      seats,
      expired,
      expiry_reason: expired ? `Aapki journey ${directBooking.trip_date} ko complete ho chuki hai. Yeh boarding pass ab active nahi hai.` : null
    });
  }

  // 2. Search by mobile number or partial PNR
  const phoneDigits = digits.length >= 10 ? digits.slice(-10) : digits;
  if (phoneDigits.length >= 4 || upper.length >= 3) {
    const phoneTerm = `%${phoneDigits}%`;
    const pnrTerm = `%${upper}%`;

    const matches = db.prepare(`
      SELECT DISTINCT b.id, b.pnr, b.trip_id, b.total_amount, b.amount_paid, b.paid_status,
             b.pickup_point, b.group_contact, b.booked_by, b.created_at,
             t.date AS trip_date, t.time AS trip_time, t.status AS trip_status,
             r.name AS route_name, r.source, r.destination, bu.name AS bus_name
      FROM bookings b
      JOIN trips t ON t.id = b.trip_id
      JOIN routes r ON r.id = t.route_id
      JOIN buses bu ON bu.id = t.bus_id
      LEFT JOIN booking_seats bs ON bs.booking_id = b.id
      WHERE (b.group_contact LIKE ? OR bs.contact LIKE ? OR UPPER(b.pnr) LIKE ?)
      ORDER BY t.date DESC, b.id DESC
      LIMIT 20
    `).all(phoneTerm, phoneTerm, pnrTerm);

    if (matches.length === 1) {
      const b = matches[0];
      const expired = isTripExpired(b.trip_date, b.trip_status);
      const seats = db.prepare(`
        SELECT id, seat_label, passenger_name, age, gender, contact, concession, seat_fare, boarded
        FROM booking_seats
        WHERE booking_id = ?
        ORDER BY CAST(seat_label AS INTEGER), seat_label ASC
      `).all(b.id);
      return res.json({
        ...b,
        seats,
        expired,
        expiry_reason: expired ? `Aapki journey ${b.trip_date} ko complete ho chuki hai. Yeh boarding pass ab active nahi hai.` : null
      });
    }

    if (matches.length > 1) {
      const bookingsWithSeats = matches.map((b) => ({
        ...b,
        seats: db.prepare(`
          SELECT id, seat_label, passenger_name, age, gender, contact, concession, seat_fare, boarded
          FROM booking_seats
          WHERE booking_id = ?
          ORDER BY CAST(seat_label AS INTEGER), seat_label ASC
        `).all(b.id),
        expired: isTripExpired(b.trip_date, b.trip_status)
      }));
      return res.json({
        multiple: true,
        query: raw,
        count: bookingsWithSeats.length,
        bookings: bookingsWithSeats,
      });
    }
  }

  // 3. Fallback: Check if trip was previously archived & purged
  const archivedRow = db.prepare(`
    SELECT * FROM trip_archives
    WHERE archive_data LIKE ?
    ORDER BY id DESC LIMIT 1
  `).get(`%${upper}%`);

  if (archivedRow) {
    return res.status(410).json({
      expired: true,
      error: `Trip #${archivedRow.trip_id} (${archivedRow.route_name}) on ${archivedRow.trip_date} was completed and safely archived. Boarding pass is no longer active.`,
      trip_date: archivedRow.trip_date,
      route_name: archivedRow.route_name,
    });
  }

  return res.status(404).json({
    error: `No active Boarding Pass found for PNR or Mobile Number "${raw}".`,
  });
});

router.get('/bookings/:id', requireAuth, (req, res) => {
  const b = db.prepare(`
    SELECT b.*, t.date AS trip_date, t.time AS trip_time, t.status AS trip_status,
           r.name AS route_name, r.source, r.destination, bu.name AS bus_name
    FROM bookings b
    JOIN trips t ON t.id = b.trip_id
    JOIN routes r ON r.id = t.route_id
    JOIN buses bu ON bu.id = t.bus_id
    WHERE b.id = ?
  `).get(req.params.id);
  if (!b) return res.status(404).json({ error: 'Booking not found.' });
  const seats = db.prepare('SELECT * FROM booking_seats WHERE booking_id = ? ORDER BY CAST(seat_label AS INTEGER), seat_label ASC').all(b.id);
  res.json({ ...b, seats });
});

router.patch('/bookings/:id/payment', requireAuth, requireAdminOrSupervisor, (req, res) => {
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found.' });
  let amountPaid = req.body.amountPaid != null ? Number(req.body.amountPaid) : booking.amount_paid;
  if (req.body.paidStatus === 'Paid' && req.body.amountPaid == null) amountPaid = booking.total_amount;
  if (req.body.paidStatus === 'Unpaid' && req.body.amountPaid == null) amountPaid = 0;
  if (Number.isNaN(amountPaid) || amountPaid < 0) {
    return res.status(400).json({ error: 'Invalid amount paid.' });
  }
  if (amountPaid > Number(booking.total_amount) + 0.001) {
    return res.status(400).json({ error: 'Amount paid cannot exceed total fare.' });
  }
  const paidStatus = resolvePaidStatus(amountPaid, booking.total_amount);
  db.prepare('UPDATE bookings SET paid_status=?, amount_paid=? WHERE id=?').run(paidStatus, amountPaid, req.params.id);
  res.json(db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id));
});

/* ---------- Dashboard Metrics ---------- */
router.get('/dashboard/stats', requireAuth, (req, res) => {
  const targetDate = req.query.date || new Date().toISOString().slice(0, 10);
  const trips = db.prepare(`SELECT t.*, r.name AS route_name, r.fare AS fare, b.name AS bus_name,
                                   b.rows AS bus_rows, b.cols AS bus_cols, b.layout_json
                            FROM trips t
                            JOIN routes r ON r.id = t.route_id
                            JOIN buses b ON b.id = t.bus_id
                            WHERE t.date = ?
                            ORDER BY t.time`).all(targetDate);
  let totalCapacity = 0;
  let totalBooked = 0;
  let plannedCount = 0;
  let inTransitCount = 0;
  let completedCount = 0;
  let cancelledCount = 0;

  trips.forEach((t) => {
    const layout = getBusLayout(t);
    const cap = countSeats(layout);
    totalCapacity += cap;
    const bCount = db.prepare('SELECT COUNT(*) AS c FROM booking_seats WHERE trip_id = ?').get(t.id).c;
    totalBooked += bCount;
    if (t.status === 'Planned') plannedCount++;
    else if (t.status === 'In-Transit') inTransitCount++;
    else if (t.status === 'Completed') completedCount++;
    else if (t.status === 'Cancelled') cancelledCount++;
  });

  const occupancyRate = totalCapacity > 0 ? Math.round((totalBooked / totalCapacity) * 100) : 0;

  // Financials for target date trips with payment breakdown
  const finRow = db.prepare(`
    SELECT COALESCE(SUM(b.amount_paid), 0) AS collected,
           COALESCE(SUM(CASE WHEN b.payment_method = 'Cash' THEN b.amount_paid ELSE 0 END), 0) AS cash_collected,
           COALESCE(SUM(CASE WHEN b.payment_method = 'UPI' THEN b.amount_paid ELSE 0 END), 0) AS upi_collected,
           COALESCE(SUM(CASE WHEN b.payment_method = 'Card' THEN b.amount_paid ELSE 0 END), 0) AS card_collected,
           COALESCE(SUM(CASE WHEN (b.total_amount - b.amount_paid) > 0 THEN (b.total_amount - b.amount_paid) ELSE 0 END), 0) AS due,
           COALESCE(SUM(b.total_amount), 0) AS total_fare
    FROM bookings b
    JOIN trips t ON t.id = b.trip_id
    WHERE t.date = ? AND t.status != 'Cancelled'
  `).get(targetDate);

  // All-time pending dues across active bookings
  const allTimeDue = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN (b.total_amount - b.amount_paid) > 0 THEN (b.total_amount - b.amount_paid) ELSE 0 END), 0) AS pending_due
    FROM bookings b
    JOIN trips t ON t.id = b.trip_id
    WHERE t.status != 'Cancelled'
  `).get().pending_due;

  // Recent bookings (latest 8)
  const recentBookings = db.prepare(`
    SELECT b.*, t.date AS trip_date, t.time AS trip_time, t.status AS trip_status,
           r.name AS route_name, bu.name AS bus_name,
           (SELECT COUNT(*) FROM booking_seats bs WHERE bs.booking_id = b.id) AS seat_count
    FROM bookings b
    JOIN trips t ON t.id = b.trip_id
    JOIN routes r ON r.id = t.route_id
    JOIN buses bu ON bu.id = t.bus_id
    ORDER BY b.id DESC
    LIMIT 8
  `).all();

  // Active trips with live boarding progress & trip dues
  const activeTrips = trips.map((t) => {
    const layout = getBusLayout(t);
    const cap = countSeats(layout);
    const bookedCount = db.prepare('SELECT COUNT(*) AS c FROM booking_seats WHERE trip_id = ?').get(t.id).c;
    const boardedCount = db.prepare('SELECT COUNT(*) AS c FROM booking_seats WHERE trip_id = ? AND boarded = 1').get(t.id).c;
    const due = db.prepare(`
      SELECT COALESCE(SUM(b.total_amount - b.amount_paid), 0) AS due
      FROM bookings b WHERE b.trip_id = ? AND (b.total_amount - b.amount_paid) > 0
    `).get(t.id).due;
    return {
      id: t.id,
      route_name: t.route_name,
      source: t.source,
      destination: t.destination,
      bus_name: t.bus_name,
      time: t.time,
      date: t.date,
      status: t.status,
      capacity: cap,
      bookedCount,
      boardedCount,
      dueAmt: due,
      occupancyPct: cap > 0 ? Math.round((bookedCount / cap) * 100) : 0,
      boardedPct: bookedCount > 0 ? Math.round((boardedCount / bookedCount) * 100) : 0
    };
  });

  const dueBookingsCountToday = db.prepare(`
    SELECT COUNT(*) AS c
    FROM bookings b
    JOIN trips t ON t.id = b.trip_id
    WHERE t.date = ? AND t.status != 'Cancelled' AND (b.total_amount - b.amount_paid) > 0
  `).get(targetDate).c;

  // Upcoming trips (future departures after targetDate)
  const rawUpcoming = db.prepare(`
    SELECT t.*, r.name AS route_name, r.source, r.destination, r.fare AS fare, bu.name AS bus_name,
           bu.rows AS bus_rows, bu.cols AS bus_cols, bu.layout_json
    FROM trips t
    JOIN routes r ON r.id = t.route_id
    JOIN buses bu ON bu.id = t.bus_id
    WHERE t.date > ? AND t.status = 'Planned'
    ORDER BY t.date ASC, t.time ASC
    LIMIT 8
  `).all(targetDate);

  const upcomingTrips = rawUpcoming.map((t) => {
    const layout = getBusLayout(t);
    const cap = countSeats(layout);
    const bookedCount = db.prepare('SELECT COUNT(*) AS c FROM booking_seats WHERE trip_id = ?').get(t.id).c;
    return {
      id: t.id,
      route_name: t.route_name,
      source: t.source,
      destination: t.destination,
      bus_name: t.bus_name,
      time: t.time,
      date: t.date,
      fare: t.fare,
      capacity: cap,
      bookedCount,
      availableSeats: Math.max(0, cap - bookedCount),
      occupancyPct: cap > 0 ? Math.round((bookedCount / cap) * 100) : 0,
    };
  });

  res.json({
    date: targetDate,
    tripsCount: trips.length,
    plannedCount,
    inTransitCount,
    completedCount,
    cancelledCount,
    totalCapacity,
    totalBooked,
    availableSeats: Math.max(0, totalCapacity - totalBooked),
    occupancyRate,
    collectedToday: finRow ? finRow.collected : 0,
    cashCollectedToday: finRow ? finRow.cash_collected : 0,
    upiCollectedToday: finRow ? finRow.upi_collected : 0,
    cardCollectedToday: finRow ? finRow.card_collected : 0,
    dueToday: finRow ? finRow.due : 0,
    dueBookingsCountToday,
    totalDueAllTime: allTimeDue,
    activeTrips,
    upcomingTrips,
    recentBookings,
  });
});

/* ---------- Booking Cancellation & Seat Release ---------- */
router.delete('/bookings/:id', requireAuth, (req, res) => {
  const booking = db.prepare(`
    SELECT b.*, t.date AS trip_date, t.time AS trip_time, r.name AS route_name, bu.name AS bus_name
    FROM bookings b
    JOIN trips t ON t.id = b.trip_id
    JOIN routes r ON r.id = t.route_id
    JOIN buses bu ON bu.id = t.bus_id
    WHERE b.id = ?
  `).get(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found.' });

  const isOwner = req.user.username === booking.booked_by_username;
  const canCancel = req.user.role === 'Admin' || req.user.role === 'Supervisor' || isOwner;
  if (!canCancel) {
    return res.status(403).json({ error: 'You do not have permission to cancel this booking.' });
  }

  const seats = db.prepare('SELECT * FROM booking_seats WHERE booking_id = ? ORDER BY CAST(seat_label AS INTEGER), seat_label ASC').all(booking.id);
  const seatLabels = seats.map((s) => s.seat_label).join(', ');
  const refundNotes = req.body?.refundNotes || req.query?.refundNotes || 'Cancelled by staff';

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO cancelled_bookings
      (pnr, trip_id, route_name, bus_name, trip_date, trip_time, booked_by, cancelled_by, seats_list, refund_notes, amount_paid, total_amount)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      booking.pnr, booking.trip_id, booking.route_name, booking.bus_name,
      booking.trip_date, booking.trip_time, booking.booked_by,
      `${req.user.name} (${req.user.role})`, seatLabels, refundNotes,
      booking.amount_paid, booking.total_amount
    );

    db.prepare('DELETE FROM booking_seats WHERE booking_id = ?').run(booking.id);
    db.prepare('DELETE FROM bookings WHERE id = ?').run(booking.id);
  });

  tx();
  logAudit('BOOKING_CANCELLED', 'BOOKING', booking.pnr, {
    seats: seatLabels,
    route: booking.route_name,
    bus: booking.bus_name,
    reason: refundNotes,
    amountPaid: booking.amount_paid,
    totalAmount: booking.total_amount
  }, req.user.name, req.user.role);
  res.json({
    ok: true,
    pnr: booking.pnr,
    freedSeats: seats.map((s) => s.seat_label),
    message: `Booking ${booking.pnr} has been cancelled and seat(s) [${seatLabels}] are now available.`,
  });
});

/* Release single seat from multi-seat booking */
router.delete('/bookings/:id/seats/:seatLabel', requireAuth, (req, res) => {
  const booking = db.prepare(`
    SELECT b.*, t.date AS trip_date, t.time AS trip_time, r.name AS route_name, bu.name AS bus_name
    FROM bookings b
    JOIN trips t ON t.id = b.trip_id
    JOIN routes r ON r.id = t.route_id
    JOIN buses bu ON bu.id = t.bus_id
    WHERE b.id = ?
  `).get(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found.' });

  const isOwner = req.user.username === booking.booked_by_username;
  const canCancel = req.user.role === 'Admin' || req.user.role === 'Supervisor' || isOwner;
  if (!canCancel) {
    return res.status(403).json({ error: 'You do not have permission to modify this booking.' });
  }

  const label = decodeURIComponent(req.params.seatLabel);
  const seat = db.prepare('SELECT * FROM booking_seats WHERE booking_id = ? AND seat_label = ?').get(booking.id, label);
  if (!seat) return res.status(404).json({ error: `Seat ${label} not found in this booking.` });

  const allSeats = db.prepare('SELECT * FROM booking_seats WHERE booking_id = ?').all(booking.id);
  if (allSeats.length <= 1) {
    // If it's the only seat, cancel full booking
    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO cancelled_bookings
        (pnr, trip_id, route_name, bus_name, trip_date, trip_time, booked_by, cancelled_by, seats_list, refund_notes, amount_paid, total_amount)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        booking.pnr, booking.trip_id, booking.route_name, booking.bus_name,
        booking.trip_date, booking.trip_time, booking.booked_by,
        `${req.user.name} (${req.user.role})`, label, 'Single seat cancelled',
        booking.amount_paid, booking.total_amount
      );
      db.prepare('DELETE FROM booking_seats WHERE booking_id = ?').run(booking.id);
      db.prepare('DELETE FROM bookings WHERE id = ?').run(booking.id);
    });
    tx();
    logAudit('BOOKING_CANCELLED', 'BOOKING', booking.pnr, {
      seats: label,
      route: booking.route_name,
      bus: booking.bus_name,
      reason: 'Single seat cancelled - booking closed',
      amountPaid: booking.amount_paid,
      totalAmount: booking.total_amount
    }, req.user.name, req.user.role);
    return res.json({ ok: true, freedSeat: label, bookingDeleted: true, message: `Seat ${label} released and booking closed.` });
  }

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM booking_seats WHERE id = ?').run(seat.id);
    const remainingCount = allSeats.length - 1;
    const newTotal = Number(booking.fare_per_seat) * remainingCount;
    let newPaid = Number(booking.amount_paid);
    if (newPaid > newTotal) newPaid = newTotal;
    const newStatus = resolvePaidStatus(newPaid, newTotal);

    db.prepare('UPDATE bookings SET total_amount = ?, amount_paid = ?, paid_status = ? WHERE id = ?')
      .run(newTotal, newPaid, newStatus, booking.id);
  });

  tx();
  logAudit('SEAT_CANCELLED', 'BOOKING', booking.pnr, {
    seat: label,
    route: booking.route_name,
    bus: booking.bus_name,
    reason: 'Seat released',
    newTotal,
    newPaid,
    newStatus
  }, req.user.name, req.user.role);
  res.json({ ok: true, freedSeat: label, message: `Seat ${label} released.` });
});

/* 1-Click Seat Swap / Shift (Without cancellation) */
router.post('/bookings/:id/seats/:seatLabel/swap', requireAuth, (req, res) => {
  const { newSeatLabel } = req.body || {};
  if (!newSeatLabel) return res.status(400).json({ error: 'Target seat label is required.' });

  const booking = db.prepare(`SELECT b.*, t.bus_id, t.status AS trip_status, t.date AS trip_date FROM bookings b JOIN trips t ON t.id = b.trip_id WHERE b.id = ?`).get(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found.' });

  if (isTripExpired(booking.trip_date, booking.trip_status)) {
    return res.status(400).json({ error: 'Cannot swap seats for a past or completed trip.' });
  }

  const isOwner = req.user.username === booking.booked_by_username;
  const canSwap = req.user.role === 'Admin' || req.user.role === 'Supervisor' || isOwner || (req.user.permissions && req.user.permissions.can_book);
  if (!canSwap) return res.status(403).json({ error: 'Permission denied to modify seat.' });

  const oldLabel = decodeURIComponent(req.params.seatLabel);
  const targetLabel = String(newSeatLabel).trim();

  if (oldLabel === targetLabel) {
    return res.status(400).json({ error: 'Current seat and target seat are the same.' });
  }

  const currentSeat = db.prepare('SELECT * FROM booking_seats WHERE booking_id = ? AND seat_label = ?').get(booking.id, oldLabel);
  if (!currentSeat) return res.status(404).json({ error: `Seat ${oldLabel} not found in this booking.` });

  // Validate bus layout contains target seat
  const bus = db.prepare('SELECT layout_json, rows, pattern FROM buses WHERE id = ?').get(booking.bus_id);
  const layout = getBusLayout(bus);
  const allLabels = (layout || []).flat().filter(Boolean);
  if (!allLabels.includes(targetLabel)) {
    return res.status(400).json({ error: `Seat ${targetLabel} does not exist on this bus.` });
  }

  // Check if target seat is already occupied
  const occupied = db.prepare('SELECT id FROM booking_seats WHERE trip_id = ? AND seat_label = ?').get(booking.trip_id, targetLabel);
  if (occupied) {
    return res.status(409).json({ error: `Seat ${targetLabel} is already booked by another passenger.` });
  }

  // Perform atomic swap
  db.prepare('UPDATE booking_seats SET seat_label = ? WHERE id = ?').run(targetLabel, currentSeat.id);
  db.syncCloud();

  logAudit('SEAT_SWAPPED', 'BOOKING', booking.pnr, {
    oldSeat: oldLabel,
    newSeat: targetLabel,
    passenger: currentSeat.passenger_name,
    tripId: booking.trip_id
  }, req.user.name, req.user.role);

  res.json({
    ok: true,
    message: `Seat ${oldLabel} successfully shifted to ${targetLabel} for ${currentSeat.passenger_name}.`,
    pnr: booking.pnr,
    oldSeat: oldLabel,
    newSeat: targetLabel,
  });
});

/* ---------- Admin: Database Backup ---------- */
router.post('/admin/backup', requireAuth, requireAdmin, async (req, res) => {
  try {
    const backup = await runBackup();
    logAudit('DATABASE_BACKUP_CREATED', 'SYSTEM', backup.fileName, { size: backup.size }, req.user.name, req.user.role);
    res.json({ ok: true, backup });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Backup failed.' });
  }
});

router.get('/admin/backups', requireAuth, requireAdmin, (req, res) => {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return res.json([]);
    const files = fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.endsWith('.db'))
      .map((f) => {
        const stat = fs.statSync(path.join(BACKUP_DIR, f));
        return { fileName: f, size: stat.size, createdAt: stat.mtime };
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to list backups.' });
  }
});

/* ---------- Manifest: Boarding Check-In ---------- */
router.post('/manifest/board', requireAuth, requirePerm('can_manifest'), (req, res) => {
  const { seatId, bookingId, boarded } = req.body || {};
  const boardedVal = boarded ? 1 : 0;
  const now = new Date().toISOString();

  if (seatId) {
    const seat = db.prepare('SELECT bs.*, b.pnr FROM booking_seats bs JOIN bookings b ON b.id = bs.booking_id WHERE bs.id = ?').get(seatId);
    if (!seat) return res.status(404).json({ error: 'Seat not found.' });
    db.prepare('UPDATE booking_seats SET boarded = ?, boarded_at = ?, boarded_by = ? WHERE id = ?')
      .run(boardedVal, boardedVal ? now : null, boardedVal ? req.user.name : null, seatId);
    db.syncCloud();
    logAudit(boardedVal ? 'PASSENGER_BOARDED' : 'BOARDING_UNMARKED', 'SEAT', seat.seat_label, { pnr: seat.pnr, passenger: seat.passenger_name }, req.user.name, req.user.role);
    return res.json({ success: true, seatId, boarded: boardedVal });
  }

  if (bookingId) {
    const b = db.prepare('SELECT pnr FROM bookings WHERE id = ?').get(bookingId);
    if (!b) return res.status(404).json({ error: 'Booking not found.' });
    db.prepare('UPDATE booking_seats SET boarded = ?, boarded_at = ?, boarded_by = ? WHERE booking_id = ?')
      .run(boardedVal, boardedVal ? now : null, boardedVal ? req.user.name : null, bookingId);
    db.syncCloud();
    logAudit(boardedVal ? 'GROUP_BOARDED' : 'GROUP_BOARDING_UNMARKED', 'BOOKING', b.pnr, { bookingId }, req.user.name, req.user.role);
    return res.json({ success: true, bookingId, boarded: boardedVal });
  }

  res.status(400).json({ error: 'seatId or bookingId is required.' });
});

/* ---------- Bookings: Spot Balance Payment at Boarding ---------- */
router.post('/bookings/:id/pay-balance', requireAuth, requirePerm('can_collect_payment'), (req, res) => {
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found.' });

  const amount = Number(req.body.amount);
  const paymentMethod = req.body.paymentMethod || 'Cash';
  const markBoarded = Boolean(req.body.markBoarded);

  if (Number.isNaN(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Please enter a valid payment amount.' });
  }

  const currentPaid = Number(booking.amount_paid || 0);
  const totalAmount = Number(booking.total_amount || 0);
  const due = Math.max(0, totalAmount - currentPaid);

  if (amount > due + 0.01) {
    return res.status(400).json({ error: `Amount cannot exceed balance due of ₹${due.toFixed(2)}.` });
  }

  const newPaid = currentPaid + amount;
  const newStatus = resolvePaidStatus(newPaid, totalAmount);
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    db.prepare('UPDATE bookings SET amount_paid = ?, paid_status = ?, payment_method = ? WHERE id = ?')
      .run(newPaid, newStatus, paymentMethod, req.params.id);

    if (markBoarded) {
      db.prepare('UPDATE booking_seats SET boarded = 1, boarded_at = ?, boarded_by = ? WHERE booking_id = ?')
        .run(now, req.user.name, req.params.id);
    }
  });

  try {
    tx();
    db.syncCloud();
  } catch (err) {
    return res.status(500).json({ error: 'Payment processing failed: ' + err.message });
  }

  logAudit('BALANCE_COLLECTED', 'BOOKING', booking.pnr, {
    amount,
    paymentMethod,
    newPaid,
    newStatus,
    markBoarded,
    collector: req.user.name
  }, req.user.name, req.user.role);

  const updated = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  const seats = db.prepare('SELECT * FROM booking_seats WHERE booking_id = ? ORDER BY CAST(seat_label AS INTEGER), seat_label ASC').all(req.params.id);
  res.json({ success: true, booking: { ...updated, seats }, amountPaid: newPaid, paidStatus: newStatus });
});

/* ---------- Audit Logs ---------- */
router.get('/audit-logs', requireAuth, requirePerm('can_view_logs'), (req, res) => {
  const limit = Math.min(200, Math.max(10, Number(req.query.limit) || 100));
  const rawLogs = db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?').all(limit);
  const logs = rawLogs.map((l) => ({
    id: l.id != null ? l.id : l.ID,
    action: l.action || l.ACTION || '',
    entity_type: l.entity_type || l.ENTITY_TYPE || '',
    entity_id: l.entity_id || l.ENTITY_ID || '',
    details: l.details || l.DETAILS || '',
    performed_by: l.performed_by || l.PERFORMED_BY || '',
    role: l.role || l.ROLE || '',
    created_at: l.created_at || l.CREATED_AT || '',
  }));
  res.json(logs);
});

/* ---------- System Settings (Passenger Portal & Config) ---------- */
router.get('/settings/public', (req, res) => {
  res.json({
    passengerPortalUrl: getSetting('passenger_portal_url', ''),
    companyName: getSetting('company_name', 'Seva Bus Service'),
    supportPhone: getSetting('support_phone', '')
  });
});

router.get('/settings', requireAuth, requirePerm('can_manage_settings'), (req, res) => {
  res.json({
    passenger_portal_url: getSetting('passenger_portal_url', ''),
    company_name: getSetting('company_name', 'Seva Bus Service'),
    support_phone: getSetting('support_phone', '')
  });
});

router.post('/settings', requireAuth, requirePerm('can_manage_settings'), (req, res) => {
  const { passenger_portal_url, company_name, support_phone } = req.body || {};
  if (passenger_portal_url !== undefined) setSetting('passenger_portal_url', String(passenger_portal_url).trim());
  if (company_name !== undefined) setSetting('company_name', String(company_name).trim());
  if (support_phone !== undefined) setSetting('support_phone', String(support_phone).trim());
  
  logAudit('SETTINGS_UPDATED', 'SYSTEM', 'CONFIG', { passenger_portal_url, company_name, support_phone }, req.user.name, req.user.role);
  res.json({
    ok: true,
    settings: {
      passenger_portal_url: getSetting('passenger_portal_url', ''),
      company_name: getSetting('company_name', 'Seva Bus Service'),
      support_phone: getSetting('support_phone', '')
    }
  });
});

/* ---------- Auto-Drive Archive & Google Drive Sync Endpoints ---------- */
function cleanDriveFolderId(input) {
  if (!input) return '';
  let str = String(input).trim();
  const match = str.match(/folders\/([a-zA-Z0-9_\-]+)/);
  if (match) return match[1];
  str = str.split('?')[0].split('#')[0].trim();
  return str;
}

router.get('/archive/status', requireAuth, (req, res) => {
  const driveClient = getGoogleDriveClient();
  const today = getTodayDateIST();

  const pending = db.prepare(`
    SELECT COUNT(*) AS c FROM trips t
    WHERE (t.date < ? OR t.status = 'Completed')
      AND t.id NOT IN (
        SELECT trip_id FROM trip_archives WHERE status IN ('Archived', 'Purged & Archived')
      )
  `).get(today);

  const totalArchived = db.prepare('SELECT COUNT(*) AS c FROM trip_archives').get()?.c || 0;
  const folderId = getSetting('google_drive_folder_id', '');

  res.json({
    today,
    driveConfigured: Boolean(driveClient),
    driveFolderId: folderId,
    driveScriptUrl: getSetting('google_drive_script_url', ''),
    clientEmail: driveClient ? driveClient.clientEmail : (getSetting('google_service_account_email', '') || null),
    pendingTripsCount: pending?.c || 0,
    totalArchivedCount: totalArchived,
  });
});

router.get('/archive/history', requireAuth, (req, res) => {
  const limit = Math.min(100, Math.max(10, Number(req.query.limit) || 50));
  const archives = db.prepare(`
    SELECT id, trip_id, trip_date, route_name, bus_name, archive_filename,
           drive_file_id, drive_web_link, total_bookings, total_seats, total_revenue,
           archived_at, status
    FROM trip_archives
    ORDER BY id DESC
    LIMIT ?
  `).all(limit);
  res.json(archives);
});

router.post('/archive/run', async (req, res) => {
  const cronSecret = req.headers['x-cron-secret'] || req.query.cron_secret;
  const configuredSecret = process.env.CRON_SECRET || 'seva-bus-cron-secret';
  const isCronAuthed = cronSecret && cronSecret === configuredSecret;

  if (!isCronAuthed) {
    // Standard auth check
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const results = await runAutoDriveArchive({ requireDrive: false });
    res.json({ success: true, ...results });
  } catch (err) {
    res.status(500).json({ error: 'Archive execution failed: ' + err.message });
  }
});

router.get('/archive/download/:id', requireAuth, (req, res) => {
  const archive = db.prepare('SELECT * FROM trip_archives WHERE id = ?').get(req.params.id);
  if (!archive) return res.status(404).json({ error: 'Archive record not found' });

  // 1. Check local file on disk
  if (archive.local_path && fs.existsSync(archive.local_path)) {
    return res.download(archive.local_path, archive.archive_filename);
  }

  const defaultPath = path.join(ARCHIVES_DIR, archive.archive_filename);
  if (fs.existsSync(defaultPath)) {
    return res.download(defaultPath, archive.archive_filename);
  }

  // 2. If stored as JSON backup in DB
  if (archive.archive_data) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${archive.archive_filename.replace('.zip', '.json')}"`);
    return res.send(archive.archive_data);
  }

  res.status(404).json({ error: 'Archive file not found on disk. Please open via Google Drive link.' });
});

router.get('/archive/view/:id', requireAuth, async (req, res) => {
  const archive = db.prepare('SELECT * FROM trip_archives WHERE id = ?').get(req.params.id);
  if (!archive) return res.status(404).send('Archive record not found');

  try {
    const JSZip = require('jszip');
    const targetPath = (archive.local_path && fs.existsSync(archive.local_path))
      ? archive.local_path
      : path.join(ARCHIVES_DIR, archive.archive_filename);

    if (fs.existsSync(targetPath)) {
      const zipBuffer = fs.readFileSync(targetPath);
      const zip = await JSZip.loadAsync(zipBuffer);
      const htmlFile = zip.file('Trip_Complete_Report.html');
      if (htmlFile) {
        const html = await htmlFile.async('string');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(html);
      }
    }

    if (archive.archive_data) {
      const parsed = JSON.parse(archive.archive_data);
      const { generateTripReportHtml } = require('./archive');
      const html = generateTripReportHtml(parsed.trip, parsed.bookings, parsed.cancelled, parsed.stats, {});
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    }

    res.status(404).send('Archive report document not found.');
  } catch (e) {
    res.status(500).send('Error loading archive report: ' + e.message);
  }
});

router.post('/archive/config', requireAuth, requirePerm('can_manage_settings'), (req, res) => {
  const { google_drive_folder_id, google_drive_script_url, google_service_account_json, google_service_account_email, google_private_key } = req.body || {};

  if (google_drive_folder_id !== undefined) setSetting('google_drive_folder_id', cleanDriveFolderId(google_drive_folder_id));
  if (google_drive_script_url !== undefined) setSetting('google_drive_script_url', String(google_drive_script_url).trim());
  if (google_service_account_json !== undefined) setSetting('google_service_account_json', String(google_service_account_json).trim());
  if (google_service_account_email !== undefined) setSetting('google_service_account_email', String(google_service_account_email).trim());
  if (google_private_key !== undefined) setSetting('google_private_key', String(google_private_key).trim());

  logAudit('ARCHIVE_CONFIG_UPDATED', 'SYSTEM', 'GOOGLE_DRIVE', { google_drive_folder_id }, req.user.name, req.user.role);

  const driveClient = getGoogleDriveClient();
  res.json({
    ok: true,
    driveConfigured: Boolean(driveClient),
    driveFolderId: getSetting('google_drive_folder_id', ''),
    driveScriptUrl: getSetting('google_drive_script_url', ''),
    clientEmail: driveClient ? driveClient.clientEmail : null,
  });
});

module.exports = router;
