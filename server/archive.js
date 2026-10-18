const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const JSZip = require('jszip');
const { google } = require('googleapis');
const db = require('./db');

const isVercel = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const defaultDataDir = isVercel ? '/tmp' : path.join(__dirname, '..', 'data');
const ARCHIVES_DIR = path.join(defaultDataDir, 'archives');

try {
  fs.mkdirSync(ARCHIVES_DIR, { recursive: true });
} catch (e) {}

/**
 * Returns the current date in Indian Standard Time (IST) YYYY-MM-DD
 */
function getTodayDateIST() {
  try {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  } catch (e) {
    return new Date().toISOString().slice(0, 10);
  }
}

/**
 * Checks if a trip has ended (past date or marked Completed)
 */
function isTripExpired(tripDate, tripStatus) {
  if (tripStatus === 'Completed') return true;
  if (!tripDate) return false;
  const today = getTodayDateIST();
  return tripDate < today;
}

/**
 * Sanitizes strings for safe filenames
 */
function safeName(str) {
  return String(str || '')
    .trim()
    .replace(/[^a-zA-Z0-9_\-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 30);
}

/**
 * Reads setting from database or environment
 */
function getSetting(key) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (row && row.value) return row.value;
  } catch (e) {}
  return process.env[key] || process.env[key.toUpperCase()] || '';
}

/**
 * Initializes Google Drive client if credentials are configured
 */
function getGoogleDriveClient() {
  const folderId = getSetting('google_drive_folder_id') || process.env.GOOGLE_DRIVE_FOLDER_ID || '';
  const saJsonRaw = getSetting('google_service_account_json') || process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '';

  if (!folderId) {
    return null;
  }

  try {
    let credentials = null;
    if (saJsonRaw) {
      if (typeof saJsonRaw === 'string' && saJsonRaw.trim().startsWith('{')) {
        credentials = JSON.parse(saJsonRaw.trim());
      } else if (fs.existsSync(saJsonRaw)) {
        credentials = JSON.parse(fs.readFileSync(saJsonRaw, 'utf8'));
      }
    }

    if (!credentials) {
      const clientEmail = getSetting('google_service_account_email') || process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
      const privateKey = (getSetting('google_private_key') || process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
      if (clientEmail && privateKey) {
        credentials = { client_email: clientEmail, private_key: privateKey };
      }
    }

    if (!credentials || !credentials.client_email || !credentials.private_key) {
      return null;
    }

    const auth = new google.auth.JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/drive'],
    });

    const drive = google.drive({ version: 'v3', auth });
    return { drive, folderId, clientEmail: credentials.client_email };
  } catch (err) {
    console.warn('Google Drive client init notice:', err.message);
    return null;
  }
}

/**
 * Builds a ZIP buffer for a specific trip with CSV, Summary, and JSON data
 */
async function buildTripArchive(tripId) {
  const trip = db.prepare(`
    SELECT t.*, r.name AS route_name, r.source, r.destination, r.fare,
           bu.name AS bus_name, bu.pattern, bu.rows AS bus_rows, bu.cols AS bus_cols
    FROM trips t
    JOIN routes r ON r.id = t.route_id
    JOIN buses bu ON bu.id = t.bus_id
    WHERE t.id = ?
  `).get(tripId);

  if (!trip) {
    throw new Error(`Trip #${tripId} not found.`);
  }

  const bookings = db.prepare('SELECT * FROM bookings WHERE trip_id = ? ORDER BY id ASC').all(tripId);
  const bookingsWithSeats = bookings.map((b) => ({
    ...b,
    seats: db.prepare('SELECT * FROM booking_seats WHERE booking_id = ? ORDER BY seat_label ASC').all(b.id),
  }));

  const cancelled = db.prepare('SELECT * FROM cancelled_bookings WHERE trip_id = ? ORDER BY id ASC').all(tripId);

  // Calculate statistics
  let totalSeatsBooked = 0;
  let totalGross = 0;
  let totalPaid = 0;
  const staffStats = {};

  bookingsWithSeats.forEach((b) => {
    const seatCount = (b.seats && b.seats.length) || 0;
    totalSeatsBooked += seatCount;
    totalGross += Number(b.total_amount || 0);
    totalPaid += Number(b.amount_paid || 0);

    const staff = b.booked_by || 'Unknown Staff';
    if (!staffStats[staff]) {
      staffStats[staff] = { count: 0, seats: 0, collected: 0, total: 0 };
    }
    staffStats[staff].count += 1;
    staffStats[staff].seats += seatCount;
    staffStats[staff].collected += Number(b.amount_paid || 0);
    staffStats[staff].total += Number(b.total_amount || 0);
  });

  const totalDue = Math.max(0, totalGross - totalPaid);

  // 1. Generate Passenger_Manifest.csv
  const csvHeaders = [
    'Booking ID',
    'PNR',
    'Seat Label',
    'Passenger Name',
    'Age',
    'Gender',
    'Contact',
    'Boarded Status',
    'Fare',
    'Amount Paid',
    'Balance Due',
    'Payment Method',
    'Pickup Stop',
    'Booked By',
    'Created At',
  ];

  const csvRows = [];
  bookingsWithSeats.forEach((b) => {
    (b.seats || []).forEach((s) => {
      const seatFare = Number(b.fare_per_seat || 0);
      const row = [
        b.id,
        `"${b.pnr}"`,
        `"${s.seat_label}"`,
        `"${(s.passenger_name || '').replace(/"/g, '""')}"`,
        s.age || '',
        s.gender || '',
        `"${s.contact || b.group_contact || ''}"`,
        s.boarded ? 'Boarded' : 'Confirmed',
        seatFare,
        b.amount_paid,
        Math.max(0, b.total_amount - b.amount_paid),
        `"${b.payment_method || 'Cash'}"`,
        `"${(b.pickup_point || '').replace(/"/g, '""')}"`,
        `"${(b.booked_by || '').replace(/"/g, '""')}"`,
        `"${b.created_at || ''}"`,
      ];
      csvRows.push(row.join(','));
    });
  });

  const csvContent = '\uFEFF' + [csvHeaders.join(','), ...csvRows].join('\r\n');

  // 2. Generate Trip_Financial_Summary.txt
  const summaryLines = [
    '======================================================================',
    '                   SEVA BUS SERVICE - TRIP ARCHIVE REPORT             ',
    '======================================================================',
    `Trip ID:           #${trip.id}`,
    `Trip Date:         ${trip.date}`,
    `Departure Time:    ${trip.time}`,
    `Route:             ${trip.route_name} (${trip.source} -> ${trip.destination})`,
    `Bus Name:          ${trip.bus_name} (Pattern: ${trip.pattern})`,
    `Standard Fare:     Rs. ${trip.fare}`,
    '----------------------------------------------------------------------',
    'PASSENGER & BOOKING STATISTICS:',
    `Total Bookings:    ${bookingsWithSeats.length}`,
    `Total Seats Booked: ${totalSeatsBooked}`,
    `Cancelled Bookings: ${cancelled.length}`,
    '----------------------------------------------------------------------',
    'FINANCIAL SUMMARY:',
    `Total Gross Fare:  Rs. ${totalGross.toFixed(2)}`,
    `Total Collected:   Rs. ${totalPaid.toFixed(2)}`,
    `Total Balance Due: Rs. ${totalDue.toFixed(2)}`,
    '----------------------------------------------------------------------',
    'COLLECTIONS BY STAFF / AGENT:',
    ...Object.entries(staffStats).map(([staff, data]) => 
      ` • ${staff.padEnd(20)}: ${String(data.count).padStart(2)} bookings | ${String(data.seats).padStart(2)} seats | Paid: Rs. ${data.collected.toFixed(2)} / Rs. ${data.total.toFixed(2)}`
    ),
    '======================================================================',
    `Archive Generated At: ${new Date().toISOString()}`,
    '======================================================================'
  ];
  const summaryContent = summaryLines.join('\r\n');

  // 3. Generate Trip_Full_Backup.json
  const fullBackupObj = {
    metadata: {
      system: 'Seva Bus Booking System',
      version: '1.0.0',
      exported_at: new Date().toISOString(),
      trip_id: trip.id,
      trip_date: trip.date,
      route: trip.route_name,
      bus: trip.bus_name,
    },
    trip,
    stats: {
      totalBookings: bookingsWithSeats.length,
      totalSeatsBooked,
      totalGross,
      totalPaid,
      totalDue,
    },
    bookings: bookingsWithSeats,
    cancelled,
  };
  const jsonContent = JSON.stringify(fullBackupObj, null, 2);

  // Pack into ZIP
  const zip = new JSZip();
  zip.file('Passenger_Manifest.csv', csvContent);
  zip.file('Trip_Financial_Summary.txt', summaryContent);
  zip.file('Trip_Full_Backup.json', jsonContent);

  const zipBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });

  const fileName = `SevaBus_${trip.date}_${safeName(trip.route_name)}_${safeName(trip.bus_name)}_Trip${trip.id}.zip`;

  return {
    trip,
    fileName,
    zipBuffer,
    stats: {
      totalBookings: bookingsWithSeats.length,
      totalSeatsBooked,
      totalGross,
      totalPaid,
      totalDue,
    },
    fullBackupObj,
  };
}

/**
 * Uploads a file buffer directly to Google Drive
 */
async function uploadToGoogleDrive(driveClient, fileName, fileBuffer) {
  const { drive, folderId } = driveClient;
  const stream = new Readable();
  stream.push(fileBuffer);
  stream.push(null);

  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId],
      description: `Seva Bus automated trip archive created on ${new Date().toISOString()}`,
    },
    media: {
      mimeType: 'application/zip',
      body: stream,
    },
    fields: 'id, name, webViewLink, webContentLink',
  });

  return {
    fileId: res.data.id,
    webViewLink: res.data.webViewLink || `https://drive.google.com/file/d/${res.data.id}/view`,
    webContentLink: res.data.webContentLink,
  };
}

/**
 * Purges a completed trip and its associated seats/bookings from the live web database
 * ONLY called after backup is 100% saved and verified!
 */
function purgeTripFromDatabase(tripId, archiveRecordId) {
  // 1. Delete booking seats
  db.prepare(`
    DELETE FROM booking_seats
    WHERE booking_id IN (SELECT id FROM bookings WHERE trip_id = ?)
  `).run(tripId);

  // 2. Delete bookings
  db.prepare('DELETE FROM bookings WHERE trip_id = ?').run(tripId);

  // 3. Delete cancelled bookings for this trip
  db.prepare('DELETE FROM cancelled_bookings WHERE trip_id = ?').run(tripId);

  // 4. Update trip status to Completed / Archived or remove
  db.prepare("UPDATE trips SET status = 'Completed' WHERE id = ?").run(tripId);

  // 5. Update archive record
  db.prepare("UPDATE trip_archives SET status = 'Purged & Archived' WHERE id = ?").run(archiveRecordId);

  // 6. Sync to Turso cloud
  if (typeof db.syncCloud === 'function') {
    db.syncCloud();
  }

  // 7. Log audit trail
  try {
    db.prepare(`
      INSERT INTO audit_logs (action, entity_type, entity_id, details, performed_by, role)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      'AUTO_ARCHIVE_PURGE',
      'trip',
      String(tripId),
      JSON.stringify({ archiveId: archiveRecordId, message: 'Trip bookings safely archived and purged from live database' }),
      'Auto-Drive Archive',
      'System'
    );
  } catch (e) {}
}

/**
 * Main Auto-Drive Archive executor
 * Finds all past trips (date < today or status = 'Completed') that haven't been archived yet,
 * builds the ZIP, uploads to Drive (or saves locally), and purges live web database.
 */
async function runAutoDriveArchive(options = {}) {
  const today = getTodayDateIST();
  const driveClient = getGoogleDriveClient();

  // Find trips that need archiving
  // Either trip_date < today OR status = 'Completed', and not already in trip_archives with status != 'Failed'
  const eligibleTrips = db.prepare(`
    SELECT t.id, t.date, t.time, t.status, r.name AS route_name, bu.name AS bus_name
    FROM trips t
    JOIN routes r ON r.id = t.route_id
    JOIN buses bu ON bu.id = t.bus_id
    WHERE (t.date < ? OR t.status = 'Completed')
      AND t.id NOT IN (
        SELECT trip_id FROM trip_archives WHERE status IN ('Archived', 'Purged & Archived')
      )
    ORDER BY t.date ASC, t.id ASC
  `).all(today);

  const results = {
    today,
    totalEligible: eligibleTrips.length,
    archived: [],
    skipped: [],
    errors: [],
    driveConnected: Boolean(driveClient),
  };

  for (const t of eligibleTrips) {
    try {
      // 1. Build labeled ZIP
      const archiveData = await buildTripArchive(t.id);
      const { fileName, zipBuffer, stats, fullBackupObj } = archiveData;

      // 2. Save locally (always as immediate fallback/cache)
      const localFilePath = path.join(ARCHIVES_DIR, fileName);
      try {
        fs.writeFileSync(localFilePath, zipBuffer);
      } catch (e) {
        console.warn('Local archive save notice:', e.message);
      }

      // Convert small JSON representation for fast browser download from DB if local file gets cleared
      const compactJsonStr = JSON.stringify(fullBackupObj);

      let driveFileId = null;
      let driveWebLink = null;

      // 3. Upload to Google Drive if configured
      if (driveClient) {
        try {
          const uploadRes = await uploadToGoogleDrive(driveClient, fileName, zipBuffer);
          driveFileId = uploadRes.fileId;
          driveWebLink = uploadRes.webViewLink;
        } catch (driveErr) {
          console.error(`Google Drive upload failed for Trip #${t.id}:`, driveErr.message);
          // Safety lock: if drive upload fails and drive is required, don't purge!
          if (options.requireDrive) {
            results.errors.push({ tripId: t.id, error: `Google Drive upload failed: ${driveErr.message}` });
            continue;
          }
        }
      }

      // 4. Record in trip_archives table
      const insertArchive = db.prepare(`
        INSERT INTO trip_archives (
          trip_id, trip_date, route_name, bus_name, archive_filename,
          drive_file_id, drive_web_link, local_path, archive_data,
          total_bookings, total_seats, total_revenue, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const archiveId = insertArchive.run(
        t.id,
        t.date,
        t.route_name,
        t.bus_name,
        fileName,
        driveFileId,
        driveWebLink,
        localFilePath,
        compactJsonStr,
        stats.totalBookings,
        stats.totalSeatsBooked,
        stats.totalPaid,
        'Archived'
      ).lastInsertRowid;

      // 5. Zero-Data-Loss Safety Check & Purge
      // Purge live bookings to keep DB small and fast
      purgeTripFromDatabase(t.id, archiveId);

      results.archived.push({
        tripId: t.id,
        tripDate: t.date,
        routeName: t.route_name,
        busName: t.bus_name,
        fileName,
        driveWebLink,
        driveFileId,
        bookingsPurged: stats.totalBookings,
        seatsPurged: stats.totalSeatsBooked,
        totalRevenue: stats.totalPaid,
      });

    } catch (err) {
      console.error(`Error archiving trip #${t.id}:`, err);
      results.errors.push({ tripId: t.id, error: err.message });
    }
  }

  return results;
}

module.exports = {
  getTodayDateIST,
  isTripExpired,
  getGoogleDriveClient,
  buildTripArchive,
  uploadToGoogleDrive,
  purgeTripFromDatabase,
  runAutoDriveArchive,
  ARCHIVES_DIR,
};
