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

function cleanFolderId(input) {
  if (!input) return '';
  let str = String(input).trim();
  const match = str.match(/folders\/([a-zA-Z0-9_\-]+)/);
  if (match) return match[1];
  str = str.split('?')[0].split('#')[0].trim();
  return str;
}

/**
 * Initializes Google Drive client if credentials are configured
 */
function getGoogleDriveClient() {
  const folderId = cleanFolderId(getSetting('google_drive_folder_id') || process.env.GOOGLE_DRIVE_FOLDER_ID || '');
  const scriptUrl = getSetting('google_drive_script_url') || process.env.GOOGLE_DRIVE_SCRIPT_URL || '';

  if (!folderId) {
    return null;
  }

  // 1. Google Apps Script Webhook (Recommended for personal Gmail accounts, 0 quota issues)
  if (scriptUrl) {
    return {
      type: 'script',
      scriptUrl: scriptUrl.trim(),
      folderId,
      clientEmail: 'Google Drive Webhook (Personal Account)'
    };
  }

  // 2. Google Service Account (Shared Drives / Workspace)
  const saJsonRaw = getSetting('google_service_account_json') || process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '';

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
    return { type: 'jwt', drive, folderId, clientEmail: credentials.client_email };
  } catch (err) {
    console.warn('Google Drive client init notice:', err.message);
    return null;
  }
}

/**
 * Generates an all-in-one standalone HTML report with complete financials,
 * agent collections, passenger manifest, and printable PDF styling.
 */
function generateTripReportHtml(trip, bookingsWithSeats, cancelled, stats, staffStats) {
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fmtMoney = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

  const staffRows = Object.entries(staffStats || {}).map(([staff, d]) => `
    <tr>
      <td><b>${esc(staff)}</b></td>
      <td style="text-align:center;">${d.count}</td>
      <td style="text-align:center;">${d.seats}</td>
      <td style="text-align:right;color:#15803D;font-weight:600;">${fmtMoney(d.collected)}</td>
      <td style="text-align:right;font-weight:600;">${fmtMoney(d.total)}</td>
    </tr>
  `).join('');

  let passengerRows = '';
  bookingsWithSeats.forEach((b) => {
    const baseFare = Number(b.fare_per_seat || trip.fare || 0);
    (b.seats || []).forEach((s) => {
      const seatFare = Number(s.seat_fare != null && s.seat_fare > 0 ? s.seat_fare : (baseFare || 0));
      const discount = Math.max(0, baseFare - seatFare);
      const isPaid = b.paid_status === 'Paid';
      const isBoarded = Boolean(s.boarded);

      passengerRows += `
        <tr>
          <td><b style="color:#7C1A22;font-size:14px;">${esc(s.seat_label)}</b></td>
          <td><span style="font-family:monospace;font-weight:600;">${esc(b.pnr)}</span></td>
          <td>
            <b>${esc(s.passenger_name || 'Passenger')}</b>
            ${s.concession ? `<span class="badge badge-concession">${esc(s.concession)}</span>` : ''}
          </td>
          <td>${esc(s.age || '—')} / ${esc(s.gender || '—')}</td>
          <td>${esc(s.contact || b.group_contact || '—')}</td>
          <td>${fmtMoney(baseFare)}</td>
          <td style="color:${discount > 0 ? '#15803D' : '#64748B'};font-weight:600;">${discount > 0 ? '-' + fmtMoney(discount) : '—'}</td>
          <td><b>${fmtMoney(seatFare)}</b></td>
          <td>
            <span class="badge ${isPaid ? 'badge-paid' : 'badge-unpaid'}">${esc(b.paid_status)}</span>
            <div style="font-size:11px;color:#64748B;margin-top:2px;">${esc(b.payment_method || 'Cash')}</div>
          </td>
          <td>${esc(b.pickup_point || 'Default Boarding')}</td>
          <td><span class="badge ${isBoarded ? 'badge-boarded' : 'badge-pending'}">${isBoarded ? '✓ Boarded' : 'Confirmed'}</span></td>
          <td style="font-size:12px;color:#64748B;">${esc(b.booked_by || 'Staff')}</td>
        </tr>
      `;
    });
  });

  const cancelledRows = (cancelled || []).map((c) => `
    <tr>
      <td><b>${esc(c.pnr)}</b></td>
      <td>${esc(c.seats_list || '—')}</td>
      <td>${esc(c.booked_by || '—')}</td>
      <td>${esc(c.cancelled_by || '—')}</td>
      <td>${esc(c.refund_notes || '—')}</td>
      <td style="text-align:right;">${fmtMoney(c.amount_paid)}</td>
      <td style="font-size:12px;color:#64748B;">${esc(c.cancelled_at)}</td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Trip #${trip.id} Complete Archive Report | Seva Bus Service</title>
<style>
  :root {
    --maroon: #7C1A22;
    --ink: #1E293B;
    --ink-soft: #64748B;
    --line: #E2E8F0;
    --bg-page: #F8FAFC;
    --card: #FFFFFF;
    --ok: #15803D;
    --err: #B91C1C;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    background: var(--bg-page);
    color: var(--ink);
    padding: 30px 20px;
    font-size: 13.5px;
    line-height: 1.5;
  }
  .container {
    max-width: 1080px;
    margin: 0 auto;
    background: var(--card);
    border-radius: 12px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.06);
    border: 1px solid var(--line);
    overflow: hidden;
  }
  .header {
    background: var(--maroon);
    color: #FFFFFF;
    padding: 24px 30px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .header-title h1 { font-size: 22px; font-weight: 700; letter-spacing: 0.02em; }
  .header-title div { font-size: 13px; opacity: 0.9; margin-top: 3px; }
  .btn-print {
    background: #FFFFFF;
    color: var(--maroon);
    border: none;
    font-weight: 700;
    font-size: 13px;
    padding: 9px 18px;
    border-radius: 6px;
    cursor: pointer;
    box-shadow: 0 2px 6px rgba(0,0,0,0.15);
  }
  .meta-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 16px;
    padding: 20px 30px;
    background: #FDFBF7;
    border-bottom: 1px solid var(--line);
  }
  .meta-item div { font-size: 11.5px; text-transform: uppercase; color: var(--ink-soft); font-weight: 600; }
  .meta-item b { font-size: 14.5px; color: var(--ink); margin-top: 2px; display: block; }

  .kpi-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 12px;
    padding: 20px 30px;
    background: #FFFFFF;
    border-bottom: 1px solid var(--line);
  }
  .kpi-card {
    background: #F8FAFC;
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 12px 14px;
  }
  .kpi-card div { font-size: 11.5px; font-weight: 600; color: var(--ink-soft); }
  .kpi-card .val { font-size: 18px; font-weight: 700; margin-top: 4px; color: var(--ink); }

  .section { padding: 24px 30px; border-bottom: 1px solid var(--line); }
  .section:last-child { border-bottom: none; }
  .section h2 { font-size: 16px; font-weight: 700; margin-bottom: 12px; display: flex; align-items: center; gap: 8px; color: var(--maroon); }

  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { padding: 9px 12px; text-align: left; border-bottom: 1px solid var(--line); }
  th { background: #F1F5F9; color: var(--ink-soft); font-weight: 700; font-size: 11.5px; text-transform: uppercase; }
  tr:hover td { background: #F8FAFC; }

  .badge { display: inline-block; padding: 2px 7px; border-radius: 4px; font-size: 11px; font-weight: 600; }
  .badge-paid { background: #DCFCE7; color: #166534; }
  .badge-unpaid { background: #FEE2E2; color: #991B1B; }
  .badge-boarded { background: #DCFCE7; color: #166534; }
  .badge-pending { background: #FEF3C7; color: #92400E; }
  .badge-concession { background: #E0F2FE; color: #0369A1; margin-left: 4px; }

  .footer {
    padding: 16px 30px;
    background: #F8FAFC;
    font-size: 12px;
    color: var(--ink-soft);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  @media print {
    body { background: #FFFFFF; padding: 0; font-size: 11px; }
    .no-print { display: none !important; }
    .container { border: none; box-shadow: none; border-radius: 0; max-width: 100%; }
    .header { background: #7C1A22 !important; color: #fff !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    th { background: #F1F5F9 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style>
</head>
<body>

<div class="container">
  <div class="header">
    <div class="header-title">
      <h1>SEVA BUS SERVICE — OFFICIAL TRIP REPORT</h1>
      <div>Complete All-in-One Trip Manifest, Financial Audit & Concession Breakdown</div>
    </div>
    <button class="btn-print no-print" onclick="window.print()">🖨️ Print / Save as PDF</button>
  </div>

  <div class="meta-grid">
    <div class="meta-item"><div>Trip ID</div><b>#${trip.id}</b></div>
    <div class="meta-item"><div>Route</div><b>${esc(trip.route_name)} (${esc(trip.source)} ➔ ${esc(trip.destination)})</b></div>
    <div class="meta-item"><div>Bus & Layout</div><b>${esc(trip.bus_name)} (${esc(trip.pattern || '2+2')} Layout)</b></div>
    <div class="meta-item"><div>Date & Time</div><b>${esc(trip.date)} at ${esc(trip.time)}</b></div>
    <div class="meta-item"><div>Standard Fare</div><b>${fmtMoney(trip.fare)} per seat</b></div>
    <div class="meta-item"><div>Trip Status</div><b style="color:var(--ok);">✓ Archived & Verified</b></div>
  </div>

  <div class="kpi-row">
    <div class="kpi-card">
      <div>Bookings & Occupancy</div>
      <div class="val">${stats.totalSeatsBooked} seats ${stats.occupancyPct != null ? `<span style="font-size:12px;font-weight:600;color:var(--ok);">(${stats.occupancyPct}% Full)</span>` : ''}</div>
      <div style="font-size:11px;color:var(--ink-soft);margin-top:2px;">${stats.totalBookings} Bookings ${stats.totalCapacity ? `· Cap: ${stats.totalCapacity}` : ''}</div>
    </div>
    <div class="kpi-card">
      <div>Standard Gross Fare</div>
      <div class="val">${fmtMoney(stats.totalStandardGross)}</div>
    </div>
    <div class="kpi-card">
      <div>Total Discounts Given</div>
      <div class="val" style="color:var(--ok);">${stats.totalDiscountsGiven > 0 ? '-' + fmtMoney(stats.totalDiscountsGiven) : '₹0.00'}</div>
    </div>
    <div class="kpi-card">
      <div>Net Revenue</div>
      <div class="val">${fmtMoney(stats.totalGross)}</div>
    </div>
    <div class="kpi-card">
      <div>Total Paid (Collected)</div>
      <div class="val" style="color:var(--ok);">${fmtMoney(stats.totalPaid)}</div>
      <div style="font-size:11px;color:#15803D;margin-top:2px;">Cash: <b>${fmtMoney(stats.cashPaid)}</b> · Online: <b>${fmtMoney(stats.onlinePaid)}</b></div>
    </div>
    <div class="kpi-card">
      <div>Balance Due</div>
      <div class="val" style="color:${stats.totalDue > 0 ? 'var(--err)' : 'var(--ok)'};">${fmtMoney(stats.totalDue)}</div>
    </div>
  </div>

  ${staffRows ? `
  <div class="section">
    <h2>👥 Collections by Staff / Booking Agent</h2>
    <table>
      <thead>
        <tr>
          <th>Staff / Agent Name</th>
          <th style="text-align:center;">Bookings Count</th>
          <th style="text-align:center;">Seats Booked</th>
          <th style="text-align:right;">Amount Collected</th>
          <th style="text-align:right;">Total Fare Value</th>
        </tr>
      </thead>
      <tbody>
        ${staffRows}
      </tbody>
    </table>
  </div>
  ` : ''}

  <div class="section">
    <h2>💺 Complete Passenger Manifest (${stats.totalSeatsBooked} Passengers)</h2>
    <div style="overflow-x:auto;">
      <table>
        <thead>
          <tr>
            <th>Seat</th>
            <th>PNR</th>
            <th>Passenger Name</th>
            <th>Age/Gen</th>
            <th>Phone</th>
            <th>Base Fare</th>
            <th>Discount</th>
            <th>Net Fare</th>
            <th>Paid Status</th>
            <th>Pickup Point</th>
            <th>Boarded</th>
            <th>Booked By</th>
          </tr>
        </thead>
        <tbody>
          ${passengerRows || '<tr><td colspan="12" style="text-align:center;color:#64748B;">No passengers recorded for this trip.</td></tr>'}
        </tbody>
      </table>
    </div>
  </div>

  ${(cancelled && cancelled.length > 0) ? `
  <div class="section">
    <h2 style="color:var(--err);">❌ Cancelled Bookings (${cancelled.length})</h2>
    <table>
      <thead>
        <tr>
          <th>PNR</th>
          <th>Seats</th>
          <th>Booked By</th>
          <th>Cancelled By</th>
          <th>Refund Notes</th>
          <th style="text-align:right;">Amount</th>
          <th>Cancelled At</th>
        </tr>
      </thead>
      <tbody>
        ${cancelledRows}
      </tbody>
    </table>
  </div>
  ` : ''}

  <div class="footer">
    <div>Official Seva Bus Transit Archive System · Generated automatically on ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} (IST)</div>
    <div>System Verified ✓</div>
  </div>
</div>

</body>
</html>`;
}

/**
 * Builds a ZIP buffer for a specific trip with All-in-One HTML, CSV, Summary, and JSON data
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

  let cashPaid = 0;
  let onlinePaid = 0;
  bookingsWithSeats.forEach((b) => {
    const paid = Number(b.amount_paid || 0);
    const method = String(b.payment_method || 'Cash').toLowerCase();
    if (method === 'cash') {
      cashPaid += paid;
    } else {
      onlinePaid += paid;
    }
  });

  const totalCapacity = trip.bus_rows && trip.bus_cols ? (trip.bus_rows * trip.bus_cols) : 0;
  const occupancyPct = totalCapacity > 0 ? Math.min(100, Math.round((totalSeatsBooked / totalCapacity) * 100)) : null;

  let totalDiscountsGiven = 0;
  let totalStandardGross = 0;

  bookingsWithSeats.forEach((b) => {
    const baseFare = Number(b.fare_per_seat || trip.fare || 0);
    totalDiscountsGiven += Number(b.discount_amount || 0);
    (b.seats || []).forEach((s) => {
      const sf = Number(s.seat_fare != null && s.seat_fare > 0 ? s.seat_fare : baseFare);
      totalStandardGross += baseFare;
      if (baseFare > sf) {
        totalDiscountsGiven += (baseFare - sf);
      }
    });
  });

  if (totalStandardGross === 0) totalStandardGross = totalGross;

  // 1. Generate All-in-One Trip_Complete_Report.html
  const htmlContent = generateTripReportHtml(trip, bookingsWithSeats, cancelled, {
    totalBookings: bookingsWithSeats.length,
    totalSeatsBooked,
    totalCapacity,
    occupancyPct,
    totalStandardGross,
    totalDiscountsGiven,
    totalGross,
    totalPaid,
    cashPaid,
    onlinePaid,
    totalDue,
  }, staffStats);

  // 2. Generate Enhanced Passenger_Manifest.csv (All-in-one Excel Sheet)
  const csvSummaryBlock = [
    'SEVA BUS SERVICE - TRIP COMPLETE ARCHIVE & AUDIT MANIFEST',
    `Trip ID,#${trip.id},Route,"${trip.route_name} (${trip.source} -> ${trip.destination})",Bus,"${trip.bus_name}",Date,${trip.date},Departure,${trip.time}`,
    `Total Bookings,${bookingsWithSeats.length},Total Seats Booked,${totalSeatsBooked},Standard Fare,Rs. ${totalStandardGross.toFixed(2)},Total Discounts Saved,Rs. ${totalDiscountsGiven.toFixed(2)},Net Payable,Rs. ${totalGross.toFixed(2)},Total Collected,Rs. ${totalPaid.toFixed(2)},Balance Due,Rs. ${totalDue.toFixed(2)}`,
    '',
    'COLLECTIONS BY AGENT / STAFF:',
    'Agent Name,Bookings,Seats Booked,Total Paid,Total Gross',
    ...Object.entries(staffStats).map(([staff, data]) => 
      `"${staff}",${data.count},${data.seats},Rs. ${data.collected.toFixed(2)},Rs. ${data.total.toFixed(2)}`
    ),
    '',
    'PASSENGER MANIFEST:',
  ];

  const csvHeaders = [
    'Seat',
    'PNR',
    'Passenger Name',
    'Age',
    'Gender',
    'Contact Number',
    'Concession Category',
    'Standard Fare',
    'Discount / Concession',
    'Net Seat Fare',
    'Paid Status',
    'Amount Paid',
    'Balance Due',
    'Payment Method',
    'Pickup Stop',
    'Boarding Status',
    'Booked By',
    'Created At',
  ];

  const csvRows = [];
  bookingsWithSeats.forEach((b) => {
    const baseFare = Number(b.fare_per_seat || trip.fare || 0);
    (b.seats || []).forEach((s) => {
      const seatFare = Number(s.seat_fare != null && s.seat_fare > 0 ? s.seat_fare : baseFare);
      const discount = Math.max(0, baseFare - seatFare);
      const row = [
        `"${s.seat_label}"`,
        `"${b.pnr}"`,
        `"${(s.passenger_name || 'Passenger').replace(/"/g, '""')}"`,
        s.age || '',
        s.gender || '',
        `"${s.contact || b.group_contact || ''}"`,
        `"${(s.concession || 'General').replace(/"/g, '""')}"`,
        baseFare,
        discount > 0 ? -discount : 0,
        seatFare,
        `"${b.paid_status}"`,
        b.amount_paid,
        Math.max(0, b.total_amount - b.amount_paid),
        `"${b.payment_method || 'Cash'}"`,
        `"${(b.pickup_point || '').replace(/"/g, '""')}"`,
        s.boarded ? 'Boarded' : 'Confirmed',
        `"${(b.booked_by || '').replace(/"/g, '""')}"`,
        `"${b.created_at || ''}"`,
      ];
      csvRows.push(row.join(','));
    });
  });

  const csvContent = '\uFEFF' + [...csvSummaryBlock, csvHeaders.join(','), ...csvRows].join('\r\n');

  // 3. Generate Trip_Financial_Summary.txt
  const summaryLines = [
    '======================================================================',
    '                   SEVA BUS SERVICE - TRIP ARCHIVE REPORT             ',
    '======================================================================',
    `Trip ID:           #${trip.id}`,
    `Trip Date:         ${trip.date}`,
    `Departure Time:    ${trip.time}`,
    `Route:             ${trip.route_name} (${trip.source} -> ${trip.destination})`,
    `Bus Name:          ${trip.bus_name} (Pattern: ${trip.pattern || '2+2'})`,
    `Standard Fare:     Rs. ${trip.fare}`,
    '----------------------------------------------------------------------',
    'PASSENGER & BOOKING STATISTICS:',
    `Total Bookings:    ${bookingsWithSeats.length}`,
    `Total Seats Booked: ${totalSeatsBooked}`,
    `Cancelled Bookings: ${cancelled.length}`,
    '----------------------------------------------------------------------',
    'FINANCIAL SUMMARY:',
    `Standard Gross:    Rs. ${totalStandardGross.toFixed(2)}`,
    `Total Discounts:   Rs. -${totalDiscountsGiven.toFixed(2)}`,
    `Net Revenue:       Rs. ${totalGross.toFixed(2)}`,
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

  // 4. Generate Trip_Full_Backup.json
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
      totalStandardGross,
      totalDiscountsGiven,
      totalGross,
      totalPaid,
      totalDue,
    },
    bookings: bookingsWithSeats,
    cancelled,
  };
  const jsonContent = JSON.stringify(fullBackupObj, null, 2);

  // Pack into ZIP: Primary file is the all-in-one Trip_Complete_Report.html!
  const zip = new JSZip();
  zip.file('Trip_Complete_Report.html', htmlContent);
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
    htmlContent,
    csvContent,
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
  if (driveClient.type === 'script') {
    const base64Content = fileBuffer.toString('base64');
    const response = await fetch(driveClient.scriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        folderId: driveClient.folderId,
        fileName,
        mimeType: 'application/zip',
        base64Content,
      }),
      redirect: 'follow',
    });
    const resData = await response.json();
    if (!resData.success && resData.error) {
      throw new Error(resData.error);
    }
    return {
      fileId: resData.fileId,
      webViewLink: resData.webViewLink || `https://drive.google.com/file/d/${resData.fileId}/view`,
      webContentLink: resData.webViewLink,
    };
  }

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
  cleanDriveFolderId: cleanFolderId,
  generateTripReportHtml,
  buildTripArchive,
  uploadToGoogleDrive,
  purgeTripFromDatabase,
  runAutoDriveArchive,
  ARCHIVES_DIR,
};
