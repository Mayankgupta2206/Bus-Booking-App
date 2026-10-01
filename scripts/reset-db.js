require('dotenv').config();
const db = require('../server/db');
const bcrypt = require('bcryptjs');

const mode = process.argv[2] || '--help';

async function resetDb() {
  console.log('--------------------------------------------------');
  console.log('Seva Bus Booking App - Database Reset Utility');
  console.log('--------------------------------------------------');

  if (mode === '--help') {
    console.log(`
Usage:
  node scripts/reset-db.js --bookings   (Delete ALL bookings & passenger tickets, keep routes/buses/users)
  node scripts/reset-db.js --all        (Factory Reset: delete everything & restore fresh clean demo state)

NPM Shortcuts:
  npm run reset:bookings
  npm run reset:all
`);
    process.exit(0);
  }

  try {
    if (mode === '--bookings') {
      console.log('Clearing all passenger bookings, seats, and cancellations...');
      db.prepare('DELETE FROM booking_seats').run();
      db.prepare('DELETE FROM bookings').run();
      db.prepare('DELETE FROM cancelled_bookings').run();
      db.prepare("DELETE FROM audit_logs WHERE entity_type IN ('booking', 'seat', 'cancellation')").run();

      console.log('Resetting SQLite auto-increment counters for bookings...');
      try {
        db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('bookings', 'booking_seats', 'cancelled_bookings')").run();
      } catch (e) {}

      console.log('Syncing changes to Turso Cloud SQLite...');
      if (typeof db.syncCloud === 'function') db.syncCloud();

      console.log('SUCCESS: All bookings and ticket data deleted cleanly!');
      console.log('Routes, Buses, Staff Accounts, and Admin permissions remain 100% intact.');
      process.exit(0);
    }

    if (mode === '--all') {
      console.log('WARNING: Performing COMPLETE Factory Reset...');
      
      // Delete child tables first
      db.prepare('DELETE FROM booking_seats').run();
      db.prepare('DELETE FROM bookings').run();
      db.prepare('DELETE FROM cancelled_bookings').run();
      db.prepare('DELETE FROM audit_logs').run();
      db.prepare('DELETE FROM trips').run();
      db.prepare('DELETE FROM buses').run();
      db.prepare('DELETE FROM routes').run();
      db.prepare('DELETE FROM users').run();

      try {
        db.prepare('DELETE FROM sqlite_sequence').run();
      } catch (e) {}

      console.log('Re-creating default administrative & demo users...');
      const insertUser = db.prepare('INSERT INTO users (username, password_hash, name, role) VALUES (?, ?, ?, ?)');
      insertUser.run('admin', bcrypt.hashSync('Admin@321', 10), 'Administrator', 'Admin');
      insertUser.run('agent', bcrypt.hashSync('Agent321', 10), 'Agent', 'Agent');
      insertUser.run('supervisor', bcrypt.hashSync('Supervisor321', 10), 'Supervisor', 'Supervisor');

      console.log('Re-creating starter route & bus...');
      const insertRoute = db.prepare('INSERT INTO routes (name, source, destination, fare) VALUES (?, ?, ?, ?)');
      const r1 = insertRoute.run('Delhi ➔ Jaipur', 'Delhi', 'Jaipur', 450).lastInsertRowid;

      const insertBus = db.prepare('INSERT INTO buses (name, rows, cols, pattern, layout_json) VALUES (?, ?, ?, ?, ?)');
      // Default 2+2 layout helper
      const grid = [];
      let seatNum = 1;
      for (let r = 0; r < 5; r++) {
        const row = [];
        row.push({ label: `A${seatNum++}`, type: 'seat' });
        row.push({ label: `A${seatNum++}`, type: 'seat' });
        row.push({ label: '', type: 'aisle' });
        row.push({ label: `B${seatNum++}`, type: 'seat' });
        row.push({ label: `B${seatNum++}`, type: 'seat' });
        grid.push(row);
      }
      const b1 = insertBus.run('Seva Express 1', 5, 20, '2+2', JSON.stringify(grid)).lastInsertRowid;

      const today = new Date().toISOString().slice(0, 10);
      const insertTrip = db.prepare('INSERT INTO trips (route_id, bus_id, date, time) VALUES (?, ?, ?, ?)');
      insertTrip.run(r1, b1, today, '08:00');

      console.log('Syncing factory reset to Turso Cloud SQLite...');
      if (typeof db.syncCloud === 'function') db.syncCloud();

      console.log('SUCCESS: Factory Reset Complete!');
      console.log('Default Login: admin / Admin@321');
      process.exit(0);
    }

    console.log(`Unknown flag "${mode}". Run "node scripts/reset-db.js --help" for options.`);
    process.exit(1);

  } catch (err) {
    console.error('Database reset failed:', err.message);
    process.exit(1);
  }
}

resetDb();
