const path = require('path');
const fs = require('fs');
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const { signToken, requireAuth, requireAdmin, requirePerm, requireAgentOrAdmin, requireAdminOrSupervisor } = require('./auth');
const { runBackup, BACKUP_DIR } = require('./backup');

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
router.post('/auth/login', loginLimiter, (req, res) => {
  if (req.isPassengerMode) {
    return res.status(403).json({ error: 'Administrative login is disabled on the passenger boarding pass portal.' });
  }
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
  const token = signToken(user);
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
  res.status(201).json(trip);
});

router.patch('/trips/:id/cancel', requireAuth, requirePerm('can_manage_trips'), (req, res) => {
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found.' });
  if (trip.status === 'Cancelled') return res.json({ ok: true, status: 'Cancelled' });
  db.prepare("UPDATE trips SET status = 'Cancelled' WHERE id = ?").run(req.params.id);
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
  const t = db.prepare(`SELECT t.*, b.rows AS bus_rows, b.cols AS bus_cols, b.layout_json, b.pattern
                        FROM trips t JOIN buses b ON b.id = t.bus_id WHERE t.id = ?`).get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Trip not found.' });
  const seats = db.prepare(`SELECT bs.id, bs.seat_label, bs.passenger_name, bs.age, bs.gender, bs.contact,
                                    bs.boarded, bs.boarded_at, bs.boarded_by,
                                    bk.pnr, bk.booked_by, bk.booked_by_username, bk.booked_by_role,
                                    bk.paid_status, bk.amount_paid, bk.total_amount, bk.is_group, bk.created_at
                             FROM booking_seats bs
                             JOIN bookings bk ON bk.id = bs.booking_id
                             WHERE bs.trip_id = ?`).all(req.params.id);
  const booked = {};
  seats.forEach((s) => { booked[s.seat_label] = s; });
  const grid = getBusLayout(t);
  res.json({ grid, booked, seatCount: countSeats(grid) });
});

/* ---------- Bookings ---------- */
router.post('/bookings', requireAuth, requireAgentOrAdmin, (req, res) => {
  const { tripId, seats, isGroup, groupContact, paidStatus, amountPaid, pickupPoint, paymentMethod } = req.body || {};
  if (!tripId || !Array.isArray(seats) || seats.length === 0) {
    return res.status(400).json({ error: 'Please select at least one seat.' });
  }

  const sharedContact = isGroup ? (groupContact || (seats[0] && seats[0].contact)) : null;
  if (isGroup && !phoneOk(sharedContact)) {
    return res.status(400).json({ error: 'A valid phone number is required for group booking.' });
  }

  for (const s of seats) {
    if (!s.label || !s.name || s.age === undefined || s.age === '' || !s.gender) {
      return res.status(400).json({ error: 'Please fill all required fields.' });
    }
    if (Number(s.age) < 0 || Number(s.age) > 120) {
      return res.status(400).json({ error: 'Please enter a valid age (0–120).' });
    }
    const contact = isGroup ? sharedContact : s.contact;
    if (!phoneOk(contact)) {
      return res.status(400).json({ error: 'A valid phone number is required for each passenger.' });
    }
  }

  const trip = db.prepare(`SELECT t.*, r.fare AS fare FROM trips t JOIN routes r ON r.id = t.route_id WHERE t.id = ?`).get(tripId);
  if (!trip) return res.status(404).json({ error: 'Trip not found.' });
  if (trip.status !== 'Planned') {
    return res.status(400).json({ error: 'This trip is not open for booking.' });
  }

  const farePerSeat = Number(trip.fare) || 0;
  const totalAmount = farePerSeat * seats.length;
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

  const pnr = 'PNR' + Math.floor(100000 + Math.random() * 900000);

  let bookingId;
  const tx = db.transaction(() => {
    const bookingInfo = db.prepare(`INSERT INTO bookings
      (pnr, trip_id, booked_by, booked_by_username, booked_by_role, is_group, group_contact,
       fare_per_seat, total_amount, paid_status, amount_paid, pickup_point, payment_method)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      pnr, tripId, req.user.name, req.user.username, req.user.role,
      isGroup ? 1 : 0, isGroup ? sharedContact : null,
      farePerSeat, totalAmount, status, paidAmt, pickupPoint || null, method
    );
    bookingId = bookingInfo.lastInsertRowid;
    const insertSeat = db.prepare(`INSERT INTO booking_seats (booking_id,trip_id,seat_label,passenger_name,age,gender,contact)
                                    VALUES (?,?,?,?,?,?,?)`);
    for (const s of seats) {
      const contact = isGroup ? sharedContact : s.contact;
      insertSeat.run(bookingId, tripId, s.label, s.name, s.age, s.gender, contact);
    }
  });

  try {
    tx();
    db.syncCloud();
    logAudit('BOOKING_CREATED', 'BOOKING', pnr, {
      seats: seats.map(s => s.label),
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
    return res.status(500).json({ error: 'Could not complete booking.' });
  }

  res.status(201).json({
    pnr, tripId, seats, bookingId,
    farePerSeat, totalAmount, paidStatus: status, amountPaid: paidAmt,
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
    seats: db.prepare('SELECT * FROM booking_seats WHERE booking_id = ?').all(b.id),
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
    seats: db.prepare('SELECT * FROM booking_seats WHERE booking_id = ?').all(b.id),
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
    const seats = db.prepare(`
      SELECT id, seat_label, passenger_name, age, gender, contact, boarded
      FROM booking_seats
      WHERE booking_id = ?
      ORDER BY seat_label ASC
    `).all(directBooking.id);
    return res.json({ ...directBooking, seats });
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
      const seats = db.prepare(`
        SELECT id, seat_label, passenger_name, age, gender, contact, boarded
        FROM booking_seats
        WHERE booking_id = ?
        ORDER BY seat_label ASC
      `).all(b.id);
      return res.json({ ...b, seats });
    }

    if (matches.length > 1) {
      const bookingsWithSeats = matches.map((b) => ({
        ...b,
        seats: db.prepare(`
          SELECT id, seat_label, passenger_name, age, gender, contact, boarded
          FROM booking_seats
          WHERE booking_id = ?
          ORDER BY seat_label ASC
        `).all(b.id),
      }));
      return res.json({
        multiple: true,
        query: raw,
        count: bookingsWithSeats.length,
        bookings: bookingsWithSeats,
      });
    }
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
  const seats = db.prepare('SELECT * FROM booking_seats WHERE booking_id = ?').all(b.id);
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

  // Recent bookings (latest 6)
  const recentBookings = db.prepare(`
    SELECT b.*, t.date AS trip_date, t.time AS trip_time, t.status AS trip_status,
           r.name AS route_name, bu.name AS bus_name,
           (SELECT COUNT(*) FROM booking_seats bs WHERE bs.booking_id = b.id) AS seat_count
    FROM bookings b
    JOIN trips t ON t.id = b.trip_id
    JOIN routes r ON r.id = t.route_id
    JOIN buses bu ON bu.id = t.bus_id
    ORDER BY b.id DESC
    LIMIT 6
  `).all();

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
    totalDueAllTime: allTimeDue,
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

  const seats = db.prepare('SELECT * FROM booking_seats WHERE booking_id = ?').all(booking.id);
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
  res.json({ ok: true, freedSeat: label, message: `Seat ${label} released.` });
});

/* ---------- Admin: Database Backup ---------- */
router.post('/admin/backup', requireAuth, requireAdmin, async (req, res) => {
  try {
    const backup = await runBackup();
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
  const seats = db.prepare('SELECT * FROM booking_seats WHERE booking_id = ?').all(req.params.id);
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

module.exports = router;
