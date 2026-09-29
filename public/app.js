/* ---------- API helper ---------- */
const API_BASE = '';
const TOKEN_KEY = 'seva_token';
const getToken = () => localStorage.getItem(TOKEN_KEY);
const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
const clearToken = () => localStorage.removeItem(TOKEN_KEY);

async function api(path, opts = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  const token = getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(API_BASE + '/api' + path, { ...opts, headers });
  let data = null;
  try { data = await res.json(); } catch { }
  if (res.status === 401) { clearToken(); state.user = null; nav('#/login'); }
  if (!res.ok) {
    const err = new Error((data && data.error) || 'Something went wrong.');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function todayStr() { return new Date().toISOString().slice(0, 10); }
function fmtDate(s) { return new Date(s + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); }
function fmtMoney(n) { return '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function phoneOk(p) {
  const digits = String(p || '').replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15;
}
function roleIs(role) { return state.user && state.user.role === role; }
function canBook() { return roleIs('Admin') || roleIs('Agent'); }
function canManage() { return roleIs('Admin'); }
function canMarkPaid() { return roleIs('Admin') || roleIs('Supervisor'); }

/* ---------- Layout helpers (client) ---------- */
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

function renumberLayout(grid, numbering = 'row-letter') {
  if (!grid || !grid.length) return grid;
  let seq = 1;
  return grid.map((row, ri) => {
    let seatInRow = 0;
    return row.map((cell) => {
      if (cell == null || cell === '') return null;
      let newLabel = '';
      if (numbering === 'seq') {
        newLabel = String(seq++);
      } else if (numbering === 'letter-row') {
        newLabel = String.fromCharCode(65 + seatInRow) + (ri + 1);
      } else if (numbering === 'sleeper') {
        newLabel = 'S' + (seq++);
      } else {
        newLabel = (ri + 1) + String.fromCharCode(65 + seatInRow);
      }
      seatInRow++;
      return newLabel;
    });
  });
}

function findDuplicateSeatLabels(grid) {
  const seen = new Set();
  const dupes = new Set();
  (grid || []).forEach((row) => {
    row.forEach((cell) => {
      if (cell == null || cell === '') return;
      const lab = String(cell).trim();
      if (!lab) return;
      if (seen.has(lab)) dupes.add(lab);
      else seen.add(lab);
    });
  });
  return Array.from(dupes);
}

function countSeats(grid) {
  return (grid || []).reduce((n, row) => n + row.filter((c) => c != null && c !== '').length, 0);
}
function layoutWidth(grid) {
  return Math.max(1, ...(grid || []).map((row) => row.length));
}
function cloneLayout(grid) { return grid.map((row) => row.map((c) => c)); }

/* ---------- Toast ---------- */
function ensureToastWrap() {
  let w = document.getElementById('toastwrap');
  if (!w) { w = document.createElement('div'); w.id = 'toastwrap'; w.className = 'toastwrap'; document.body.appendChild(w); }
  return w;
}
function toast(msg) {
  const w = ensureToastWrap();
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  w.appendChild(t);
  setTimeout(() => t.remove(), 2500);
}

/* ---------- App state ---------- */
let state = { user: null, route: '#/login' };
let Cache = { routes: [], buses: [] };
let bookingCtx = {
  step: 1, tripId: null, trip: null, seatData: null,
  selected: [], pax: {}, mode: 'individual', groupContact: '',
  applyAll: true, lead: { name: '', age: '', gender: '' },
  advancePaid: '', paymentMethod: 'Cash', pickupPoint: '',
};
let manifestCtx = { route: '', date: todayStr(), tripId: '', trips: [], tripsLoaded: false, data: null, bookedByFilter: '', groupByAgent: true };
let adminCtx = { tab: 'routes', tripDate: todayStr(), trips: [], tripsLoaded: false, usersLoaded: false };
let layoutDraft = null;
let usersCache = [];

function resolvePaidStatus(amountPaid, totalAmount) {
  const paid = Number(amountPaid) || 0;
  const total = Number(totalAmount) || 0;
  if (paid <= 0) return 'Unpaid';
  if (total > 0 && paid + 0.001 >= total) return 'Paid';
  return 'Partial';
}

let searchCtx = { q: '', results: null, loading: false };
let dashboardCtx = { stats: null, loaded: false, loading: false };

/* ---------- Inactivity Auto-Logout (15 Minutes) ---------- */
const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;
let inactivityTimer = null;

function resetInactivityTimer() {
  if (inactivityTimer) clearTimeout(inactivityTimer);
  if (!state.user) return;
  inactivityTimer = setTimeout(() => {
    if (state.user) {
      logout();
      alert('You have been automatically logged out due to 15 minutes of inactivity for security.');
    }
  }, INACTIVITY_TIMEOUT_MS);
}

['mousedown', 'mousemove', 'keydown', 'scroll', 'touchstart', 'click'].forEach((evt) => {
  window.addEventListener(evt, resetInactivityTimer, { passive: true });
});

function nav(path, pushHash = true) {
  if (path.startsWith('#/booking') && !canBook()) { toast('Your role cannot create bookings'); path = '#/dashboard'; }
  if (path.startsWith('#/admin') && !canManage() && !(path === '#/admin/audit-logs' && roleIs('Supervisor'))) {
    toast('Admin access required');
    path = '#/dashboard';
  }
  state.route = path;
  if (pushHash && window.location.hash !== path) {
    window.location.hash = path;
  }
  render();
  window.scrollTo(0, 0);
}
function logout() {
  if (inactivityTimer) { clearTimeout(inactivityTimer); inactivityTimer = null; }
  clearToken();
  state.user = null;
  Cache = { routes: [], buses: [] };
  usersCache = [];
  adminCtx.usersLoaded = false;
  dashboardCtx.loaded = false;
  nav('#/login');
}

async function loadCaches() {
  const [routes, buses] = await Promise.all([api('/routes'), api('/buses')]);
  Cache.routes = routes; Cache.buses = buses;
}

function render() {
  const app = document.getElementById('app');
  if (!state.user) { app.innerHTML = renderLogin(); attachLogin(); return; }
  app.innerHTML = renderShell();
  attachShell();
}

/* ---------- Login ---------- */
function renderLogin() {
  return `
  <div class="center-shell">
    <div class="login-card">
      <div class="login-mark">S</div>
      <h1>Seva Bus Booking</h1>
      <div id="loginErr" class="banner banner-err hidden">Invalid username or password.</div>
      <div class="field"><label for="lu">Username</label><input id="lu" type="text" placeholder="Enter your username"></div>
      <div class="field"><label for="lp">Password</label><input id="lp" type="password" placeholder="Enter your password"></div>
      <button class="btn btn-primary btn-block" id="loginBtn">Login</button>
    </div>
  </div>`;
}
function attachLogin() {
  const doLogin = async () => {
    const u = document.getElementById('lu').value.trim();
    const p = document.getElementById('lp').value;
    const errEl = document.getElementById('loginErr');
    errEl.classList.add('hidden');
    const btn = document.getElementById('loginBtn');
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Logging in…';
    try {
      const data = await api('/auth/login', { method: 'POST', body: JSON.stringify({ username: u, password: p }) });
      setToken(data.token);
      state.user = data.user;
      resetInactivityTimer();
      await loadCaches();
      nav('#/dashboard');
      setTimeout(() => toast(`Welcome back, ${data.user.name}`), 200);
    } catch (e) {
      errEl.textContent = e.message || 'Invalid username or password.';
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled = false; btn.textContent = 'Login';
    }
  };
  document.getElementById('loginBtn').onclick = doLogin;
  document.getElementById('lp').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
}

/* ---------- Shell ---------- */
function renderShell() {
  const r = state.route;
  const linkBtn = (path, label) => `<button class="navlink ${r.startsWith(path) ? 'active' : ''} no-print" data-nav="${path}">${label}</button>`;
  return `
  <div class="topnav no-print">
    <div class="brand" data-nav="#/dashboard"><div class="mark">S</div>Seva Bus</div>
    
    <div class="nav-search no-print" id="navSearchBox">
      <input id="topNavSearch" placeholder="Search PNR or phone..." value="${esc(searchCtx.q || '')}">
      <button id="topNavSearchBtn" title="Search">🔍</button>
    </div>

    <!-- Mobile Action Buttons -->
    <div class="mobile-actions no-print">
      <button type="button" class="mobile-icon-btn" id="mobileSearchToggle" title="Search">🔍</button>
      <button type="button" class="mobile-icon-btn" id="mobileMenuToggle" title="Menu">☰</button>
    </div>

    <div class="navlinks" id="navLinksWrap">
      <div class="mobile-user-card mobile-only-item">
        <div class="mobile-user-name">👤 ${esc(state.user.name)}</div>
        <div class="mobile-user-role">${esc(state.user.role)}</div>
      </div>
      ${linkBtn('#/dashboard', 'Dashboard')}
      ${canBook() ? linkBtn('#/booking', 'Create Booking') : ''}
      ${linkBtn('#/manifest', 'View Manifest')}
      ${linkBtn('#/search', 'Search')}
      ${canManage() ? linkBtn('#/admin/buses', 'Buses & Layouts') : ''}
      ${canManage() ? linkBtn('#/admin/routes-trips', 'Routes & Trips') : ''}
      ${canManage() ? linkBtn('#/admin/users', 'Users') : ''}
      ${(canManage() || roleIs('Supervisor')) ? linkBtn('#/admin/audit-logs', 'Activity Logs') : ''}
      <button type="button" class="navlink mobile-only-item" id="pwaMobileInstallBtn">📲 Install Mobile App</button>
      <button type="button" class="navlink mobile-only-item" id="mobileLogoutBtn" style="color:#DC2626;">🚪 Logout</button>

      <div class="usermenu desktop-only-item">
        <button id="umBtn">${esc(state.user.name)} (${esc(state.user.role)}) ▾</button>
        <div class="usermenu-drop hidden" id="umDrop">
          <button id="pwaInstallMenuBtn">📲 Install App</button>
          <button id="logoutBtn">Logout</button>
        </div>
      </div>
    </div>
  </div>
  <main id="main">${routeContent()}</main>

  <div class="mobile-bottom-bar no-print">
    <button class="mbar-btn ${r === '#/dashboard' ? 'active' : ''}" data-nav="#/dashboard">
      <span class="mbar-icon">📊</span>
      <span class="mbar-text">Dashboard</span>
    </button>
    ${canBook() ? `
    <button class="mbar-btn ${r.startsWith('#/booking') ? 'active' : ''}" data-nav="#/booking">
      <span class="mbar-icon">🎫</span>
      <span class="mbar-text">Book</span>
    </button>` : ''}
    <button class="mbar-btn ${r.startsWith('#/manifest') ? 'active' : ''}" data-nav="#/manifest">
      <span class="mbar-icon">📋</span>
      <span class="mbar-text">Manifest</span>
    </button>
    <button class="mbar-btn ${r.startsWith('#/search') ? 'active' : ''}" data-nav="#/search">
      <span class="mbar-icon">🔍</span>
      <span class="mbar-text">Search</span>
    </button>
    <button class="mbar-btn" id="mobileBottomMenuBtn">
      <span class="mbar-icon">☰</span>
      <span class="mbar-text">Menu</span>
    </button>
  </div>`;
}
function attachShell() {
  const navWrap = document.getElementById('navLinksWrap');
  const menuToggle = document.getElementById('mobileMenuToggle');
  const searchToggle = document.getElementById('mobileSearchToggle');
  const searchBox = document.getElementById('navSearchBox');

  if (menuToggle && navWrap) {
    menuToggle.onclick = (e) => {
      e.stopPropagation();
      navWrap.classList.toggle('mobile-open');
    };
  }

  const bottomMenuBtn = document.getElementById('mobileBottomMenuBtn');
  if (bottomMenuBtn && navWrap) {
    bottomMenuBtn.onclick = (e) => {
      e.stopPropagation();
      navWrap.classList.toggle('mobile-open');
    };
  }

  if (searchToggle && searchBox) {
    searchToggle.onclick = (e) => {
      e.stopPropagation();
      searchBox.classList.toggle('mobile-search-visible');
      if (searchBox.classList.contains('mobile-search-visible')) {
        document.getElementById('topNavSearch')?.focus();
      }
    };
  }

  document.querySelectorAll('[data-nav]').forEach((el) => {
    el.onclick = () => {
      if (navWrap) navWrap.classList.remove('mobile-open');
      nav(el.getAttribute('data-nav') || '#/dashboard');
    };
  });

  document.addEventListener('click', (e) => {
    if (navWrap && !navWrap.contains(e.target) && e.target !== menuToggle) {
      navWrap.classList.remove('mobile-open');
    }
  });

  const umBtn = document.getElementById('umBtn'), umDrop = document.getElementById('umDrop');
  if (umBtn && umDrop) {
    umBtn.onclick = (e) => { e.stopPropagation(); umDrop.classList.toggle('hidden'); };
    document.addEventListener('click', () => umDrop.classList.add('hidden'), { once: true });
  }

  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) logoutBtn.onclick = logout;
  const mobileLogoutBtn = document.getElementById('mobileLogoutBtn');
  if (mobileLogoutBtn) mobileLogoutBtn.onclick = logout;

  const pwaBtn = document.getElementById('pwaInstallMenuBtn');
  if (pwaBtn) pwaBtn.onclick = () => triggerAppInstall();
  const mobilePwaBtn = document.getElementById('pwaMobileInstallBtn');
  if (mobilePwaBtn) mobilePwaBtn.onclick = () => {
    if (navWrap) navWrap.classList.remove('mobile-open');
    triggerAppInstall();
  };

  const topSearchInput = document.getElementById('topNavSearch');
  const topSearchBtn = document.getElementById('topNavSearchBtn');
  const doTopSearch = () => {
    const q = topSearchInput.value.trim();
    if (!q) { toast('Please enter a PNR, phone number, or passenger name'); return; }
    searchCtx.q = q;
    if (searchBox) searchBox.classList.remove('mobile-search-visible');
    if (navWrap) navWrap.classList.remove('mobile-open');
    nav('#/search');
    triggerSearch();
  };
  if (topSearchBtn) topSearchBtn.onclick = doTopSearch;
  if (topSearchInput) topSearchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doTopSearch(); });

  attachRoute();
}

function routeContent() {
  const r = state.route;
  if (r === '#/dashboard') return dashboardView();
  if (r.startsWith('#/booking') && canBook()) return bookingView();
  if (r.startsWith('#/manifest')) return manifestView();
  if (r.startsWith('#/search')) return searchView();
  if (r === '#/admin/buses' && canManage()) return adminBusesView();
  if (r === '#/admin/routes-trips' && canManage()) return adminRoutesTripsView();
  if (r === '#/admin/users' && canManage()) return adminUsersView();
  if (r === '#/admin/audit-logs' && (canManage() || roleIs('Supervisor'))) return auditLogsView();
  return dashboardView();
}
function attachRoute() {
  const r = state.route;
  if (r === '#/dashboard') attachDashboard();
  else if (r.startsWith('#/booking') && canBook()) attachBooking();
  else if (r.startsWith('#/manifest')) attachManifest();
  else if (r.startsWith('#/search')) attachSearch();
  else if (r === '#/admin/buses' && canManage()) attachAdminBuses();
  else if (r === '#/admin/routes-trips' && canManage()) attachAdminRoutesTrips();
  else if (r === '#/admin/users' && canManage()) attachAdminUsers();
  else if (r === '#/admin/audit-logs' && (canManage() || roleIs('Supervisor'))) attachAuditLogs();
}

/* ---------- Ticket Modal & WhatsApp Sharing ---------- */
function shareTicketWhatsapp(booking, trip) {
  const pnr = booking.pnr || '';
  const route = trip?.route_name || booking.route_name || 'Seva Bus';
  const date = fmtDate(trip?.date || booking.trip_date);
  const time = trip?.time || booking.trip_time || '';
  const bus = trip?.bus_name || booking.bus_name || 'Seva Bus';
  const seats = (booking.seats || []).map((s) => s.seat_label).join(', ');
  const passengerNames = (booking.seats || []).map((s) => `${s.passenger_name || 'Passenger'} (${s.seat_label})`).join(', ');
  const total = fmtMoney(booking.total_amount);
  const paid = fmtMoney(booking.amount_paid);
  const status = booking.paid_status || 'Unpaid';
  const due = Math.max(0, Number(booking.total_amount || 0) - Number(booking.amount_paid || 0));
  const pickup = booking.pickup_point ? `\n📍 *Pickup Stop:* ${booking.pickup_point}` : '';

  const lines = [
    '🎫 *SEVA BUS BOOKING PASS*',
    `*PNR:* ${pnr}`,
    `📍 *Route:* ${route}`,
    `📅 *Date & Time:* ${date} at ${time}`,
    `🚌 *Bus:* ${bus}${pickup}`,
    `💺 *Seat(s):* ${seats}`,
    `👤 *Passenger(s):* ${passengerNames}`,
    `💵 *Fare:* ${total} · Paid: ${paid} (${status})${due > 0 ? ` · *Due at Boarding:* ₹${due.toFixed(2)}` : ''}`,
    '',
    '🙏 *Thank you for choosing Seva Bus. Have a safe and pleasant journey!*'
  ];

  const text = lines.join('\n');
  const rawPhone = (booking.seats && booking.seats[0] && booking.seats[0].contact) || booking.group_contact || '';
  const digits = String(rawPhone).replace(/\D/g, '');
  const phoneParam = digits.length >= 10 ? (digits.length === 10 ? '91' + digits : digits) : '';
  const encodedText = encodeURIComponent(text);
  const url = phoneParam
    ? `https://api.whatsapp.com/send?phone=${phoneParam}&text=${encodedText}`
    : `https://api.whatsapp.com/send?text=${encodedText}`;

  window.open(url, '_blank');
}

function openTicketModal(booking, trip) {
  closeModal();
  const seats = booking.seats || [];
  const seatListStr = seats.map((s) => s.seat_label).join(', ');
  const rows = seats.map((s) => `
    <tr>
      <td><b>${esc(s.seat_label)}</b></td>
      <td>${esc(s.passenger_name)}</td>
      <td>${esc(s.age)} / ${esc(s.gender)}</td>
      <td>${esc(s.contact || booking.group_contact || '—')}</td>
    </tr>
  `).join('');

  const bal = Math.max(0, Number(booking.total_amount || 0) - Number(booking.amount_paid || 0));
  const stampClass = booking.paid_status === 'Paid' ? 'stamp-paid' : booking.paid_status === 'Partial' ? 'stamp-partial' : 'stamp-unpaid';

  const div = document.createElement('div');
  div.className = 'modal-backdrop';
  div.innerHTML = `
    <div class="modal modal-wide" style="max-width:580px;">
      <div class="ticket-wrap" id="printableTicket">
        <div class="ticket-stamp ${stampClass}">${esc(booking.paid_status)}</div>
        <div class="ticket-head">
          <div class="ticket-badge">SEVA BUS SERVICE</div>
          <h2 style="margin:4px 0 2px;font-size:20px;">PASSENGER BOARDING PASS</h2>
          <div style="font-family:'IBM Plex Mono',monospace;font-size:14px;color:var(--ink-soft);">PNR: <b style="color:var(--ink);">${esc(booking.pnr)}</b></div>
        </div>

        <div class="ticket-meta">
          <div><b>Route:</b> ${esc(trip.route_name || trip.route || '—')}</div>
          <div><b>Bus:</b> ${esc(trip.bus_name || trip.bus || '—')}</div>
          <div><b>Date:</b> ${fmtDate(trip.date || trip.trip_date)}</div>
          <div><b>Departure:</b> ${esc(trip.time || trip.trip_time)}</div>
          <div><b>Seats (${seats.length}):</b> <span style="font-family:'IBM Plex Mono',monospace;font-weight:600;color:var(--maroon);">${esc(seatListStr)}</span></div>
          <div><b>Booked by:</b> ${esc(booking.booked_by || 'Staff')}</div>
          ${booking.pickup_point ? `<div style="grid-column:span 2;"><b>Pickup Stop:</b> 📍 ${esc(booking.pickup_point)}</div>` : ''}
        </div>

        <div class="table-wrap">
          <table style="margin-bottom:14px;">
            <thead><tr><th>Seat</th><th>Passenger</th><th>Age/Gender</th><th>Contact</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>

        <div class="summary-box" style="margin-top:8px;">
          <span>Fare: <b>${fmtMoney(booking.total_amount)}</b> · Paid: <b>${fmtMoney(booking.amount_paid)}</b></span>
          <span>Balance Due: <b style="color:${bal > 0 ? 'var(--err)' : 'var(--ok)'};">${fmtMoney(bal)}</b></span>
        </div>

        <div class="ticket-qr-wrap">
          <div id="ticketQrArea" class="ticket-qr-box"></div>
          <div style="font-size:11px;color:var(--ink-soft);text-align:right;">
            Scan to verify Boarding Pass<br>
            <b style="color:var(--ink);font-family:'IBM Plex Mono',monospace;">PNR: ${esc(booking.pnr)}</b><br>
            <span>${seats.length} Seat(s) · Status: <b>${esc(booking.paid_status)}</b></span>
          </div>
        </div>
      </div>

      <div class="actions-row no-print" style="justify-content:flex-end;margin-top:18px;gap:8px;">
        <button class="btn btn-whatsapp" id="ticketShareWaBtn" title="Share via WhatsApp">💬 Share WhatsApp</button>
        <button class="btn btn-secondary" id="ticketCloseBtn">Close</button>
        <button class="btn btn-primary" id="ticketPrintBtn">Print Boarding Pass</button>
      </div>
    </div>
  `;
  document.body.appendChild(div);

  if (window.QRCode && document.getElementById('ticketQrArea')) {
    try {
      new QRCode(document.getElementById('ticketQrArea'), {
        text: `SEVA-BUS|PNR:${booking.pnr}|SEATS:${seatListStr}|FARE:${booking.total_amount}|STATUS:${booking.paid_status}`,
        width: 80,
        height: 80,
        colorDark: '#1E293B',
        colorLight: '#FFFFFF',
        correctLevel: QRCode.CorrectLevel.M
      });
    } catch (e) { console.warn('QR render error:', e); }
  }

  const waBtn = document.getElementById('ticketShareWaBtn');
  if (waBtn) waBtn.onclick = () => shareTicketWhatsapp(booking, trip);

  document.getElementById('ticketCloseBtn').onclick = () => div.remove();
  document.getElementById('ticketPrintBtn').onclick = () => window.print();
}

async function cancelBookingPrompt(bookingId, pnr, onComplete) {
  if (!confirm(`Cancel booking ${pnr}? All seats on this booking will be released back to the seat map.`)) return;
  try {
    const res = await api('/bookings/' + bookingId, { method: 'DELETE' });
    toast(res.message || `Booking ${pnr} cancelled`);
    if (onComplete) await onComplete();
  } catch (err) {
    toast(err.message);
  }
}

async function cancelSeatPrompt(bookingId, seatLabel, onComplete) {
  if (!confirm(`Release seat ${seatLabel}? This seat will become available for booking immediately.`)) return;
  try {
    const res = await api('/bookings/' + bookingId + '/seats/' + encodeURIComponent(seatLabel), { method: 'DELETE' });
    toast(res.message || `Seat ${seatLabel} released`);
    if (onComplete) await onComplete();
  } catch (err) {
    toast(err.message);
  }
}

function downloadManifestCsv(trip, bookings) {
  const rows = [];
  rows.push(['Sr', 'Seat', 'Passenger Name', 'Age', 'Gender', 'Phone', 'Pickup Stop', 'PNR', 'Total Fare', 'Amount Paid', 'Balance Due', 'Payment Status', 'Boarded', 'Booked By', 'Role', 'Booking Time']);

  let sr = 1;
  bookings.forEach((b) => {
    const seats = b.seats || [];
    seats.forEach((s) => {
      const bal = Math.max(0, Number(b.total_amount || 0) - Number(b.amount_paid || 0));
      rows.push([
        sr++,
        s.seat_label,
        s.passenger_name,
        s.age,
        s.gender,
        s.contact || b.group_contact || '',
        b.pickup_point || 'Standard',
        b.pnr,
        Number(b.total_amount || 0).toFixed(2),
        Number(b.amount_paid || 0).toFixed(2),
        bal.toFixed(2),
        b.paid_status,
        s.boarded ? 'Yes' : 'No',
        b.booked_by,
        b.booked_by_role || '',
        new Date(b.created_at).toLocaleString('en-IN'),
      ]);
    });
  });

  const csvContent = rows.map((r) => r.map((c) => `"${String(c != null ? c : '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const cleanRoute = (trip.route_name || 'trip').replace(/[^a-zA-Z0-9_-]/g, '_');
  a.href = url;
  a.download = `manifest_${cleanRoute}_${trip.date}_${trip.time}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast('Manifest CSV downloaded');
}

/* ---------- Dashboard ---------- */
function dashboardView() {
  const stats = dashboardCtx.stats;

  let metricsHtml = '';
  if (!dashboardCtx.loaded) {
    metricsHtml = `<div class="panel"><div class="empty"><span class="spin"></span>Loading live dashboard metrics...</div></div>`;
  } else if (stats) {
    metricsHtml = `
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Today's Scheduled Trips</div>
          <div class="stat-val">${stats.tripsCount}</div>
          <div class="stat-sub">${stats.plannedCount} Planned · ${stats.inTransitCount} In-Transit · ${stats.completedCount} Done</div>
        </div>
        <div class="stat-card stat-teal">
          <div class="stat-label">Today's Occupancy</div>
          <div class="stat-val">${stats.occupancyRate}%</div>
          <div class="stat-sub">${stats.totalBooked} booked / ${stats.totalCapacity} capacity (${stats.availableSeats} open)</div>
        </div>
        <div class="stat-card stat-saffron">
          <div class="stat-label">Today's Collections</div>
          <div class="stat-val">${fmtMoney(stats.collectedToday)}</div>
          <div class="stat-sub" style="font-size:11.5px;margin-top:4px;">
            💵 Cash: <b>${fmtMoney(stats.cashCollectedToday || 0)}</b> · 📱 UPI: <b>${fmtMoney(stats.upiCollectedToday || 0)}</b>${(stats.cardCollectedToday || 0) > 0 ? ' · 💳 Card: <b>' + fmtMoney(stats.cardCollectedToday) + '</b>' : ''}
          </div>
          <div class="stat-sub" style="margin-top:2px;">${fmtMoney(stats.dueToday)} pending balance today</div>
        </div>
        <div class="stat-card stat-blue">
          <div class="stat-label">Total Outstanding Dues</div>
          <div class="stat-val">${fmtMoney(stats.totalDueAllTime)}</div>
          <div class="stat-sub">Across all active scheduled trips</div>
        </div>
      </div>
    `;
  }

  let recentHtml = '';
  if (stats && stats.recentBookings && stats.recentBookings.length > 0) {
    const rows = stats.recentBookings.map((b) => {
      const bal = Math.max(0, Number(b.total_amount || 0) - Number(b.amount_paid || 0));
      return `
        <tr>
          <td><span class="pnr">${esc(b.pnr)}</span></td>
          <td>${esc(b.route_name)}</td>
          <td>${fmtDate(b.trip_date)}, ${esc(b.trip_time)}</td>
          <td>${esc(b.bus_name)}</td>
          <td><b>${b.seat_count}</b> seat(s)</td>
          <td>${fmtMoney(b.total_amount)}</td>
          <td>${paidPill(b.paid_status)}</td>
          <td>
            <button class="btn btn-secondary btn-sm" data-quick-ticket="${b.id}">Ticket</button>
            ${(canManage() || roleIs('Supervisor') || b.booked_by_username === state.user.username)
          ? `<button class="btn btn-danger btn-sm" data-quick-cancel="${b.id}" data-pnr="${esc(b.pnr)}">Cancel</button>`
          : ''}
          </td>
        </tr>
      `;
    }).join('');

    recentHtml = `
      <div class="panel no-print" style="margin-top:20px;">
        <div class="panel-head">
          <h3>Recent Bookings</h3>
          <button class="btn btn-secondary btn-sm" data-nav="#/search">Search All Bookings</button>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>PNR</th><th>Route</th><th>Departure</th><th>Bus</th><th>Seats</th><th>Total</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  return `
  <div class="panel-head no-print" style="margin-bottom:12px;">
    <div>
      <h1 class="page-title no-print" style="margin-bottom:2px;">Welcome, ${esc(state.user.name)}</h1>
      <p class="page-sub no-print" style="margin-bottom:0;">${todayStr().split('-').reverse().join('/')} · Role: <b>${esc(state.user.role)}</b></p>
    </div>
    <div style="display:flex;gap:8px;">
      <button class="btn btn-secondary btn-sm" id="refreshDashBtn">Refresh Metrics</button>
      ${canManage() ? `<button class="btn btn-secondary btn-sm" id="dashBackupBtn">Backup DB</button>` : ''}
    </div>
  </div>

  <div class="no-print">${metricsHtml}</div>

  <div class="panel no-print" style="margin-bottom:24px;">
    <div class="panel-head"><h3>Passenger &amp; PNR Quick Lookup</h3></div>
    <div class="formrow">
      <input id="dashSearchInput" placeholder="Enter PNR, 10-digit mobile number, or passenger name..." style="flex:1;">
      <button class="btn btn-primary" id="dashSearchBtn">Quick Search</button>
    </div>
  </div>

  <div class="cardgrid no-print">
    ${canBook() ? `<div class="tile"><h3>Create Booking</h3><p>Book single or group seats with fare &amp; payment status.</p><button class="btn btn-primary" data-nav="#/booking">Create Booking</button></div>` : ''}
    <div class="tile"><h3>View Manifest</h3><p>Seat map with live details, passenger list, CSV export &amp; print.</p><button class="btn btn-primary" data-nav="#/manifest">View Manifest</button></div>
    <div class="tile"><h3>Search Bookings</h3><p>Global lookup by PNR, passenger phone, or name.</p><button class="btn btn-secondary" data-nav="#/search">Search</button></div>
    ${canManage() ? `<div class="tile"><h3>Manage Buses &amp; Layouts</h3><p>Define buses and custom seat layouts.</p><button class="btn btn-secondary" data-nav="#/admin/buses">Manage Buses</button></div>` : ''}
    ${canManage() ? `<div class="tile"><h3>Manage Routes &amp; Trips</h3><p>Schedule trips, start in-transit, complete, or cancel.</p><button class="btn btn-secondary" data-nav="#/admin/routes-trips">Manage Routes &amp; Trips</button></div>` : ''}
    ${canManage() ? `<div class="tile"><h3>Manage Users</h3><p>Create Admin, Agent, or Supervisor accounts from the panel.</p><button class="btn btn-secondary" data-nav="#/admin/users">Manage Users</button></div>` : ''}
  </div>

  ${recentHtml}
  `;
}

async function attachDashboard() {
  document.querySelectorAll('[data-nav]').forEach((el) => el.onclick = () => nav(el.getAttribute('data-nav')));

  if (!dashboardCtx.loaded && !dashboardCtx.loading) {
    dashboardCtx.loading = true;
    try {
      dashboardCtx.stats = await api('/dashboard/stats');
      dashboardCtx.loaded = true;
      render();
    } catch (e) {
      toast(e.message);
    } finally {
      dashboardCtx.loading = false;
    }
  }

  const rfBtn = document.getElementById('refreshDashBtn');
  if (rfBtn) rfBtn.onclick = async () => {
    rfBtn.disabled = true;
    try {
      dashboardCtx.stats = await api('/dashboard/stats');
      dashboardCtx.loaded = true;
      render();
      toast('Metrics updated');
    } catch (e) { toast(e.message); }
    finally { rfBtn.disabled = false; }
  };

  const backupBtn = document.getElementById('dashBackupBtn');
  if (backupBtn) backupBtn.onclick = async () => {
    backupBtn.disabled = true;
    backupBtn.textContent = 'Backing up...';
    try {
      const res = await api('/admin/backup', { method: 'POST' });
      toast(`Backup saved: ${res.backup.fileName}`);
    } catch (e) { toast(e.message); }
    finally { backupBtn.disabled = false; backupBtn.textContent = 'Backup DB'; }
  };

  const doDashSearch = () => {
    const q = document.getElementById('dashSearchInput').value.trim();
    if (!q) { toast('Please enter a PNR, phone number, or name'); return; }
    searchCtx.q = q;
    nav('#/search');
    triggerSearch();
  };

  const dsb = document.getElementById('dashSearchBtn');
  if (dsb) dsb.onclick = doDashSearch;
  const dsi = document.getElementById('dashSearchInput');
  if (dsi) dsi.addEventListener('keydown', (e) => { if (e.key === 'Enter') doDashSearch(); });

  document.querySelectorAll('[data-quick-ticket]').forEach((btn) => {
    btn.onclick = async () => {
      const bId = btn.getAttribute('data-quick-ticket');
      btn.disabled = true;
      try {
        const b = await api('/bookings/' + bId);
        if (b) {
          openTicketModal(b, {
            route_name: b.route_name,
            bus_name: b.bus_name,
            date: b.trip_date,
            time: b.trip_time,
          });
        }
      } catch (e) {
        toast(e.message);
      } finally {
        btn.disabled = false;
      }
    };
  });

  document.querySelectorAll('[data-quick-cancel]').forEach((btn) => {
    btn.onclick = () => {
      const bId = btn.getAttribute('data-quick-cancel');
      const pnr = btn.getAttribute('data-pnr');
      cancelBookingPrompt(bId, pnr, async () => {
        dashboardCtx.stats = await api('/dashboard/stats');
        render();
      });
    };
  });
}

/* ---------- Global Search View ---------- */
async function triggerSearch() {
  if (!searchCtx.q || searchCtx.q.length < 2) {
    searchCtx.results = { bookings: [], cancelled: [] };
    render();
    return;
  }
  searchCtx.loading = true;
  render();
  try {
    const res = await api('/bookings/search?q=' + encodeURIComponent(searchCtx.q));
    searchCtx.results = res;
  } catch (err) {
    toast(err.message);
    searchCtx.results = { bookings: [], cancelled: [] };
  } finally {
    searchCtx.loading = false;
    render();
  }
}

function searchView() {
  const results = searchCtx.results;
  let resultsHtml = '';

  if (searchCtx.loading) {
    resultsHtml = `<div class="panel"><div class="empty"><span class="spin"></span>Searching bookings...</div></div>`;
  } else if (results) {
    const list = results.bookings || [];
    const cancelled = results.cancelled || [];

    if (list.length === 0 && cancelled.length === 0) {
      resultsHtml = `<div class="panel"><div class="empty">No bookings found matching "${esc(searchCtx.q)}". Try searching by PNR (e.g. PNR123456), 10-digit mobile number, or passenger name.</div></div>`;
    } else {
      const activeCards = list.map((b) => {
        const trip = {
          route_name: b.route_name,
          bus_name: b.bus_name,
          date: b.trip_date,
          time: b.trip_time,
          status: b.trip_status,
        };
        const seats = b.seats || [];
        const bal = Math.max(0, Number(b.total_amount || 0) - Number(b.amount_paid || 0));
        const rows = seats.map((s) => `
          <tr>
            <td><b>${esc(s.seat_label)}</b></td>
            <td>${esc(s.passenger_name)}</td>
            <td>${esc(s.age)} · ${esc(s.gender)}</td>
            <td>${esc(s.contact || b.group_contact || '—')}</td>
            <td>
              ${seats.length > 1 && (canManage() || roleIs('Supervisor') || b.booked_by_username === state.user.username)
            ? `<button class="btn btn-danger btn-sm" data-cancel-seat="${b.id}|${esc(s.seat_label)}">Release</button>`
            : ''}
            </td>
          </tr>
        `).join('');

        return `
          <div class="search-card">
            <div class="search-card-head">
              <div>
                <span class="pnr" style="font-size:15px;margin-right:8px;">${esc(b.pnr)}</span>
                <b>${esc(b.route_name)}</b> · ${esc(b.bus_name)} · <span>${fmtDate(b.trip_date)}, ${esc(b.trip_time)}</span>
                <span style="margin-left:8px;">${tripStatusPill(b.trip_status)}</span>
              </div>
              <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
                ${paidPill(b.paid_status)}
                <button class="btn btn-secondary btn-sm" data-view-ticket="${b.id}">Print Pass</button>
                <button class="btn btn-whatsapp btn-sm" data-search-wa="${b.id}">💬 WA</button>
                ${bal > 0 ? `<button class="btn btn-primary btn-sm" data-search-collect="${b.id}" data-due="${bal}">💳 Collect ₹${bal}</button>` : ''}
                ${(canManage() || roleIs('Supervisor') || b.booked_by_username === state.user.username)
            ? `<button class="btn btn-danger btn-sm" data-cancel-b="${b.id}" data-pnr="${esc(b.pnr)}">Cancel Booking</button>`
            : ''}
              </div>
            </div>
            <div style="font-size:13px;color:var(--ink-soft);margin-bottom:8px;">
              Booked by: <b>${esc(b.booked_by)}</b> ${b.booked_by_role ? '(' + esc(b.booked_by_role) + ')' : ''} · Total: <b>${fmtMoney(b.total_amount)}</b> · Paid: <b>${fmtMoney(b.amount_paid)}</b> · Due: <b style="color:${bal > 0 ? 'var(--err)' : 'inherit'};">${fmtMoney(bal)}</b>
              ${b.pickup_point ? ` · Pickup: 📍 <b>${esc(b.pickup_point)}</b>` : ''}
            </div>
            <div class="table-wrap">
              <table>
                <thead><tr><th>Seat</th><th>Passenger Name</th><th>Age / Gender</th><th>Phone</th><th>Action</th></tr></thead>
                <tbody>${rows}</tbody>
              </table>
            </div>
          </div>
        `;
      }).join('');

      const cancelledCards = cancelled.length > 0 ? `
        <div class="panel" style="margin-top:20px;border-color:#F5C6CB;">
          <h3 style="color:var(--err);">Cancelled Bookings History</h3>
          <div class="table-wrap">
            <table>
              <thead><tr><th>PNR</th><th>Route / Bus</th><th>Trip Date</th><th>Cancelled By</th><th>Seats</th><th>Refund Notes</th><th>Cancelled At</th></tr></thead>
              <tbody>
                ${cancelled.map((c) => `
                  <tr>
                    <td><span class="pnr" style="text-decoration:line-through;">${esc(c.pnr)}</span></td>
                    <td>${esc(c.route_name || '—')} (${esc(c.bus_name || '—')})</td>
                    <td>${esc(c.trip_date || '—')} ${esc(c.trip_time || '')}</td>
                    <td>${esc(c.cancelled_by)}</td>
                    <td>${esc(c.seats_list || '—')}</td>
                    <td>${esc(c.refund_notes || '—')}</td>
                    <td>${new Date(c.cancelled_at).toLocaleString('en-IN')}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      ` : '';

      resultsHtml = activeCards + cancelledCards;
    }
  }

  return `
    <h1 class="page-title no-print">Global Passenger &amp; PNR Search</h1>
    <p class="page-sub no-print">Quick lookup across all routes and trips by PNR, passenger mobile number, or name.</p>
    <div class="panel no-print">
      <div class="formrow">
        <div class="field" style="flex:2;min-width:240px;">
          <label for="searchQuery">Search Query</label>
          <input id="searchQuery" placeholder="e.g. PNR123456, 9876543210, or passenger name..." value="${esc(searchCtx.q)}">
        </div>
        <button class="btn btn-primary" id="searchSubmitBtn">Search</button>
      </div>
    </div>
    <div id="searchResults">${resultsHtml}</div>
  `;
}

function attachSearch() {
  const sq = document.getElementById('searchQuery');
  const btn = document.getElementById('searchSubmitBtn');
  const doSearch = () => {
    searchCtx.q = sq.value.trim();
    triggerSearch();
  };
  if (btn) btn.onclick = doSearch;
  if (sq) sq.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

  document.querySelectorAll('[data-view-ticket]').forEach((b) => {
    b.onclick = () => {
      const bId = b.getAttribute('data-view-ticket');
      const booking = (searchCtx.results && searchCtx.results.bookings || []).find((x) => String(x.id) === String(bId));
      if (booking) openTicketModal(booking, { route_name: booking.route_name, bus_name: booking.bus_name, date: booking.trip_date, time: booking.trip_time });
    };
  });

  document.querySelectorAll('[data-search-wa]').forEach((b) => {
    b.onclick = () => {
      const bId = b.getAttribute('data-search-wa');
      const booking = (searchCtx.results && searchCtx.results.bookings || []).find((x) => String(x.id) === String(bId));
      if (booking) shareTicketWhatsapp(booking, { route_name: booking.route_name, bus_name: booking.bus_name, date: booking.trip_date, time: booking.trip_time });
    };
  });

  document.querySelectorAll('[data-search-collect]').forEach((b) => {
    b.onclick = () => {
      const bId = b.getAttribute('data-search-collect');
      const due = Number(b.getAttribute('data-due')) || 0;
      const booking = (searchCtx.results && searchCtx.results.bookings || []).find((x) => String(x.id) === String(bId));
      if (booking) {
        const trip = { route_name: booking.route_name, bus_name: booking.bus_name, date: booking.trip_date, time: booking.trip_time };
        openSpotPaymentModal(booking, trip, due, booking.seats?.[0]?.passenger_name, () => triggerSearch());
      }
    };
  });

  document.querySelectorAll('[data-cancel-b]').forEach((b) => {
    b.onclick = () => {
      const bId = b.getAttribute('data-cancel-b');
      const pnr = b.getAttribute('data-pnr');
      cancelBookingPrompt(bId, pnr, () => triggerSearch());
    };
  });

  document.querySelectorAll('[data-cancel-seat]').forEach((b) => {
    b.onclick = () => {
      const [bId, seatLabel] = b.getAttribute('data-cancel-seat').split('|');
      cancelSeatPrompt(bId, seatLabel, () => triggerSearch());
    };
  });
}

/* ---------- Booking flow ---------- */
function bookingView() { return bookingCtx.step === 1 ? bookingStep1() : bookingStep2(); }

function bookingStep1() {
  const rOpts = Cache.routes.filter((r) => r.active).map((r) => `<option value="${r.id}">${esc(r.name)} (${fmtMoney(r.fare)})</option>`).join('');
  return `
  <h1 class="page-title">Create Booking</h1>
  <div class="panel">
    <h3>Select Trip</h3>
    <div class="formrow">
      <div class="field"><label>Route</label><select id="fRoute"><option value="">Select route</option>${rOpts}</select></div>
      <div class="field"><label>Date</label><input id="fDate" type="date" value="${todayStr()}"></div>
      <button class="btn btn-primary" id="searchBtn">Search</button>
    </div>
  </div>
  <div id="tripListWrap"></div>`;
}

function attachBooking() {
  if (bookingCtx.step === 1) {
    document.getElementById('searchBtn').onclick = async (e) => {
      const btn = e.currentTarget;
      const routeId = document.getElementById('fRoute').value;
      const date = document.getElementById('fDate').value;
      const wrap = document.getElementById('tripListWrap');
      btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Searching…';
      try {
        const qs = new URLSearchParams({ date, status: 'Planned' });
        if (routeId) qs.set('routeId', routeId);
        const trips = await api('/trips?' + qs.toString());
        renderTripList(trips, wrap);
      } catch (err) {
        wrap.innerHTML = `<div class="panel"><div class="banner banner-err">${esc(err.message)}</div></div>`;
      } finally {
        btn.disabled = false; btn.textContent = 'Search';
      }
    };
  } else {
    attachBookingStep2();
  }
}

function renderTripList(trips, wrap) {
  if (trips.length === 0) {
    wrap.innerHTML = `<div class="panel"><h3>Available Trips</h3><div class="empty">No trips found for the selected route and date.</div></div>`;
    return;
  }
  const rows = trips.map((t) => `<tr>
    <td>${esc(t.time)}</td><td>${esc(t.bus_name)}</td><td>${t.availableSeats}</td>
    <td>${fmtMoney(t.fare)}</td>
    <td><button class="btn btn-primary" data-select="${t.id}">Select</button></td>
  </tr>`).join('');
  wrap.innerHTML = `<div class="panel"><h3>Available Trips</h3><div class="table-wrap"><table>
    <thead><tr><th>Departure</th><th>Bus</th><th>Available</th><th>Fare / seat</th><th>Actions</th></tr></thead>
    <tbody>${rows}</tbody></table></div></div>`;
  wrap.querySelectorAll('[data-select]').forEach((b) => b.onclick = async () => {
    const tripId = b.getAttribute('data-select');
    b.disabled = true; b.innerHTML = '<span class="spin"></span>';
    try {
      const [trip, seatData] = await Promise.all([api('/trips/' + tripId), api('/trips/' + tripId + '/seats')]);
      bookingCtx = {
        step: 2, tripId, trip, seatData, selected: [], pax: {},
        mode: 'individual', groupContact: '', applyAll: true,
        lead: { name: '', age: '', gender: '' }, advancePaid: '',
      };
      nav('#/booking');
      toast('Trip selected — choose seats on the map');
    } catch (err) { toast(err.message); b.disabled = false; b.textContent = 'Select'; }
  });
}

function seatMapHtml(grid, booked, selected, interactive) {
  const width = Math.max(...grid.map((r) => r.length), 1);
  const cells = grid.map((row, ri) => row.map((lab, ci) => {
    if (lab == null || lab === '') return `<div class="seat aisle"></div>`;
    if (booked && booked[lab]) return `<div class="seat seat-booked" title="Booked">${esc(lab)}</div>`;
    const isSel = selected && selected.includes(lab);
    if (!interactive) return `<div class="seat seat-avail">${esc(lab)}</div>`;
    return `<div class="seat ${isSel ? 'seat-sel' : 'seat-avail'}" data-seat="${esc(lab)}">${esc(lab)}</div>`;
  }).join('')).join('');
  return `<div class="seatmap-wrap"><div class="seatmap" style="grid-template-columns:repeat(${width},44px)">${cells}</div></div>`;
}

function bookingStep2() {
  const { trip, seatData, mode } = bookingCtx;
  const fare = Number(trip.fare) || 0;
  const total = fare * bookingCtx.selected.length;
  const map = seatMapHtml(seatData.grid, seatData.booked, bookingCtx.selected, true);

  let paxHtml = '';
  if (bookingCtx.selected.length === 0) {
    paxHtml = `<div class="empty">No seats selected. Click seats on the map.</div>`;
  } else if (mode === 'group') {
    paxHtml = `
      <div class="pax-card">
        <h4>Group booking · ${bookingCtx.selected.length} seats (${bookingCtx.selected.map(esc).join(', ')})</h4>
        <div class="field"><label>Contact Phone (required)</label>
          <input id="groupContact" value="${esc(bookingCtx.groupContact)}" placeholder="10-digit mobile number" required>
        </div>
        <label class="checkline"><input type="checkbox" id="applyAll" ${bookingCtx.applyAll ? 'checked' : ''}> Same passenger details on all seats</label>
        ${bookingCtx.applyAll ? `
          <div class="field"><label>Passenger Name</label><input id="leadName" value="${esc(bookingCtx.lead.name)}" placeholder="Lead passenger name"></div>
          <div class="formrow" style="margin-bottom:0;">
            <div class="field"><label>Age</label><input id="leadAge" type="number" value="${esc(bookingCtx.lead.age)}" placeholder="e.g., 35"></div>
            <div class="field"><label>Gender</label>
              <select id="leadGender">
                <option value="">Select</option>
                <option ${bookingCtx.lead.gender === 'Male' ? 'selected' : ''}>Male</option>
                <option ${bookingCtx.lead.gender === 'Female' ? 'selected' : ''}>Female</option>
                <option ${bookingCtx.lead.gender === 'Other' ? 'selected' : ''}>Other</option>
              </select>
            </div>
          </div>` : bookingCtx.selected.map((lab) => {
      const p = bookingCtx.pax[lab] || {};
      return `<div class="pax-card nested"><h4>Seat ${esc(lab)}</h4>
              <div class="field"><label>Passenger Name</label><input data-pax="${esc(lab)}|name" value="${esc(p.name || '')}"></div>
              <div class="formrow" style="margin-bottom:0;">
                <div class="field"><label>Age</label><input data-pax="${esc(lab)}|age" type="number" value="${esc(p.age || '')}"></div>
                <div class="field"><label>Gender</label>
                  <select data-pax="${esc(lab)}|gender">
                    <option value="">Select</option>
                    <option ${p.gender === 'Male' ? 'selected' : ''}>Male</option>
                    <option ${p.gender === 'Female' ? 'selected' : ''}>Female</option>
                    <option ${p.gender === 'Other' ? 'selected' : ''}>Other</option>
                  </select>
                </div>
              </div></div>`;
    }).join('')}
      </div>`;
  } else {
    paxHtml = bookingCtx.selected.map((lab) => {
      const p = bookingCtx.pax[lab] || {};
      return `<div class="pax-card">
        <h4>Seat ${esc(lab)}</h4>
        <div class="field"><label>Passenger Name</label><input data-pax="${esc(lab)}|name" value="${esc(p.name || '')}" placeholder="Enter passenger name"></div>
        <div class="formrow" style="margin-bottom:14px;">
          <div class="field"><label>Age</label><input data-pax="${esc(lab)}|age" type="number" value="${esc(p.age || '')}" placeholder="e.g., 35"></div>
          <div class="field"><label>Gender</label>
            <select data-pax="${esc(lab)}|gender">
              <option value="">Select</option>
              <option ${p.gender === 'Male' ? 'selected' : ''}>Male</option>
              <option ${p.gender === 'Female' ? 'selected' : ''}>Female</option>
              <option ${p.gender === 'Other' ? 'selected' : ''}>Other</option>
            </select>
          </div>
        </div>
        <div class="field" style="margin-bottom:0;"><label>Phone Number (required)</label>
          <input data-pax="${esc(lab)}|contact" value="${esc(p.contact || '')}" placeholder="10-digit mobile number"></div>
      </div>`;
    }).join('');
  }

  const routeObj = Cache.routes.find((r) => r.id === trip.route_id);
  let pickupStops = [];
  if (routeObj && routeObj.pickup_points) {
    try {
      const parsed = JSON.parse(routeObj.pickup_points);
      pickupStops = Array.isArray(parsed) ? parsed : [routeObj.pickup_points];
    } catch {
      pickupStops = String(routeObj.pickup_points).split(',').map((s) => s.trim()).filter(Boolean);
    }
  }

  return `
  <h1 class="page-title">Create Booking – ${esc(trip.route_name)}, ${fmtDate(trip.date)}, ${esc(trip.time)}</h1>
  <div id="bookingErr" class="banner banner-err hidden"></div>
  <div class="mode-toggle">
    <button type="button" class="tabbtn ${mode === 'individual' ? 'active' : ''}" data-mode="individual">Individual</button>
    <button type="button" class="tabbtn ${mode === 'group' ? 'active' : ''}" data-mode="group">Group booking</button>
  </div>
  <div class="booking-grid">
    <div class="panel">
      <h3>Seat Map</h3>
      ${map}
      <div class="legend">
        <span><span class="dot" style="background:var(--seat-avail-bg);border:1.5px solid var(--seat-avail);"></span>Available</span>
        <span><span class="dot" style="background:var(--seat-booked-bg);border:1.5px solid var(--seat-booked);"></span>Booked</span>
        <span><span class="dot" style="background:var(--seat-sel);"></span>Selected</span>
      </div>
    </div>
    <div class="panel">
      <h3>Passenger Details</h3>
      ${paxHtml}
      ${pickupStops.length > 0 ? `
        <div class="field" style="margin-top:14px;">
          <label for="bookingPickup">Boarding / Pick-up Stop</label>
          <select id="bookingPickup">
            <option value="">Main Origin (${esc(trip.source || 'Standard')})</option>
            ${pickupStops.map((s) => `<option value="${esc(s)}" ${bookingCtx.pickupPoint === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
          </select>
        </div>` : ''}
      ${bookingCtx.selected.length ? `
        <div class="pay-box">
          <h4>Payment</h4>
          <div class="summary-box"><span>Seats</span><b>${bookingCtx.selected.length}</b></div>
          <div class="summary-box"><span>Fare / seat</span><b>${fmtMoney(fare)}</b></div>
          <div class="summary-box"><span>Total fare</span><b>${fmtMoney(total)}</b></div>
          <div class="field" style="margin-top:12px;">
            <label>Payment Method</label>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;" id="bookingMethodGroup">
              <button type="button" class="btn btn-secondary ${(!bookingCtx.paymentMethod || bookingCtx.paymentMethod === 'Cash') ? 'active' : ''}" data-paymethod="Cash">💵 Cash</button>
              <button type="button" class="btn btn-secondary ${bookingCtx.paymentMethod === 'UPI' ? 'active' : ''}" data-paymethod="UPI">📱 UPI</button>
              <button type="button" class="btn btn-secondary ${bookingCtx.paymentMethod === 'Card' ? 'active' : ''}" data-paymethod="Card">💳 Card</button>
            </div>
          </div>
          <div class="field" style="margin-top:12px;">
            <label>Advance / amount paid now (₹)</label>
            <input id="advancePaid" type="number" min="0" max="${total}" step="1" value="${esc(bookingCtx.advancePaid)}" placeholder="0 = unpaid, or enter advance">
          </div>
          <div class="summary-box"><span>Balance due</span><b id="balanceDue">${fmtMoney(Math.max(0, total - (Number(bookingCtx.advancePaid) || 0)))}</b></div>
          <div class="summary-box"><span>Status</span><b id="payStatusLabel">${resolvePaidStatus(bookingCtx.advancePaid, total)}</b></div>
          <div class="pay-quick">
            <button type="button" class="btn btn-secondary btn-sm" id="payNone">Unpaid</button>
            <button type="button" class="btn btn-secondary btn-sm" id="payHalf">Half advance</button>
            <button type="button" class="btn btn-secondary btn-sm" id="payFull">Full paid</button>
          </div>
        </div>` : ''}
      <div class="actions-row">
        <button class="btn btn-primary" id="confirmBtn">Confirm Booking</button>
        <button class="btn btn-secondary" id="cancelBtn">Cancel</button>
      </div>
    </div>
  </div>`;
}

function attachBookingStep2() {
  document.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.onclick = () => { bookingCtx.mode = btn.getAttribute('data-mode'); nav('#/booking'); };
  });
  document.querySelectorAll('[data-seat]').forEach((el) => el.onclick = () => {
    const lab = el.getAttribute('data-seat');
    const i = bookingCtx.selected.indexOf(lab);
    if (i >= 0) { bookingCtx.selected.splice(i, 1); delete bookingCtx.pax[lab]; toast(`Seat ${lab} removed`); }
    else { bookingCtx.selected.push(lab); toast(`Seat ${lab} selected`); }
    nav('#/booking');
  });
  document.querySelectorAll('[data-pax]').forEach((el) => {
    const sync = () => {
      const [lab, field] = el.getAttribute('data-pax').split('|');
      bookingCtx.pax[lab] = bookingCtx.pax[lab] || {};
      bookingCtx.pax[lab][field] = el.value;
    };
    el.onchange = sync; el.oninput = sync;
  });
  const gc = document.getElementById('groupContact');
  if (gc) { gc.oninput = () => { bookingCtx.groupContact = gc.value; }; }
  const aa = document.getElementById('applyAll');
  if (aa) aa.onchange = () => { bookingCtx.applyAll = aa.checked; nav('#/booking'); };
  const ln = document.getElementById('leadName');
  if (ln) ln.oninput = () => { bookingCtx.lead.name = ln.value; };
  const la = document.getElementById('leadAge');
  if (la) la.oninput = () => { bookingCtx.lead.age = la.value; };
  const lg = document.getElementById('leadGender');
  if (lg) lg.onchange = () => { bookingCtx.lead.gender = lg.value; };
  const bp = document.getElementById('bookingPickup');
  if (bp) bp.onchange = (e) => { bookingCtx.pickupPoint = e.target.value; };
  const ps = document.getElementById('advancePaid');
  const syncPay = () => {
    const fare = Number(bookingCtx.trip.fare) || 0;
    const total = fare * bookingCtx.selected.length;
    const paid = Number(document.getElementById('advancePaid').value) || 0;
    bookingCtx.advancePaid = document.getElementById('advancePaid').value;
    const bal = document.getElementById('balanceDue');
    const lab = document.getElementById('payStatusLabel');
    if (bal) bal.textContent = fmtMoney(Math.max(0, total - paid));
    if (lab) lab.textContent = resolvePaidStatus(paid, total);
  };
  if (ps) { ps.oninput = syncPay; }
  const setAdvance = (v) => {
    bookingCtx.advancePaid = String(v);
    const el = document.getElementById('advancePaid');
    if (el) el.value = String(v);
    syncPay();
  };
  const fareNow = Number(bookingCtx.trip.fare) || 0;
  const totalNow = fareNow * bookingCtx.selected.length;
  const pn = document.getElementById('payNone');
  if (pn) pn.onclick = () => setAdvance(0);
  const ph = document.getElementById('payHalf');
  if (ph) ph.onclick = () => setAdvance(Math.round(totalNow / 2));
  const pf = document.getElementById('payFull');
  if (pf) pf.onclick = () => setAdvance(totalNow);
  document.querySelectorAll('#bookingMethodGroup [data-paymethod]').forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll('#bookingMethodGroup [data-paymethod]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      bookingCtx.paymentMethod = btn.getAttribute('data-paymethod');
    };
  });
  document.getElementById('cancelBtn').onclick = () => {
    bookingCtx = { step: 1, tripId: null, selected: [], pax: {}, mode: 'individual', groupContact: '', applyAll: true, lead: { name: '', age: '', gender: '' }, advancePaid: '', paymentMethod: 'Cash', pickupPoint: '' };
    nav('#/booking');
  };
  document.getElementById('confirmBtn').onclick = confirmBooking;
}

function showErr(msg) { const el = document.getElementById('bookingErr'); if (el) { el.textContent = msg; el.classList.remove('hidden'); } }

async function confirmBooking() {
  const errEl = document.getElementById('bookingErr');
  errEl.classList.add('hidden');
  if (bookingCtx.selected.length === 0) return showErr('Please select at least one seat.');

  let seats;
  if (bookingCtx.mode === 'group') {
    if (!phoneOk(bookingCtx.groupContact)) return showErr('Enter a valid phone number (at least 10 digits).');
    if (bookingCtx.applyAll) {
      const { name, age, gender } = bookingCtx.lead;
      if (!name || !age || !gender) return showErr('Please fill passenger name, age, and gender.');
      if (age < 0 || age > 120) return showErr('Please enter a valid age (0–120).');
      seats = bookingCtx.selected.map((lab) => ({ label: lab, name, age, gender, contact: bookingCtx.groupContact }));
    } else {
      seats = [];
      for (const lab of bookingCtx.selected) {
        const p = bookingCtx.pax[lab];
        if (!p || !p.name || !p.age || !p.gender) return showErr(`Please fill details for seat ${lab}.`);
        if (p.age < 0 || p.age > 120) return showErr('Please enter a valid age (0–120).');
        seats.push({ label: lab, name: p.name, age: p.age, gender: p.gender, contact: bookingCtx.groupContact });
      }
    }
  } else {
    seats = [];
    for (const lab of bookingCtx.selected) {
      const p = bookingCtx.pax[lab];
      if (!p || !p.name || !p.age || !p.gender || !p.contact) return showErr('Please fill all required fields including phone number.');
      if (!phoneOk(p.contact)) return showErr(`Enter a valid phone number for seat ${lab}.`);
      if (p.age < 0 || p.age > 120) return showErr('Please enter a valid age (0–120).');
      seats.push({ label: lab, ...p });
    }
  }

  const fare = Number(bookingCtx.trip.fare) || 0;
  const total = fare * seats.length;
  const advance = Number(bookingCtx.advancePaid);
  const amountPaid = Number.isNaN(advance) || bookingCtx.advancePaid === '' ? 0 : advance;
  if (amountPaid < 0) return showErr('Advance cannot be negative.');
  if (amountPaid > total) return showErr('Advance cannot exceed total fare.');

  const btn = document.getElementById('confirmBtn');
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Confirming…';
  try {
    const data = await api('/bookings', {
      method: 'POST',
      body: JSON.stringify({
        tripId: bookingCtx.tripId,
        seats,
        isGroup: bookingCtx.mode === 'group',
        groupContact: bookingCtx.groupContact,
        amountPaid,
        pickupPoint: bookingCtx.pickupPoint || null,
        paymentMethod: bookingCtx.paymentMethod || 'Cash',
      }),
    });
    showConfirmModal(data, seats);
  } catch (err) {
    if (err.status === 409) {
      const seatData = await api('/trips/' + bookingCtx.tripId + '/seats');
      bookingCtx.seatData = seatData;
      bookingCtx.selected = bookingCtx.selected.filter((l) => !seatData.booked[l]);
      nav('#/booking');
    }
    showErr(err.message);
  } finally {
    const b = document.getElementById('confirmBtn');
    if (b) { b.disabled = false; b.textContent = 'Confirm Booking'; }
  }
}

function showConfirmModal(data, seats) {
  const { trip } = bookingCtx;
  const rows = seats.map((s) => `<tr><td>${esc(s.label)}</td><td>${esc(s.name)}</td><td>${esc(s.age)}</td><td>${esc(s.gender)}</td><td>${esc(s.contact)}</td></tr>`).join('');
  const div = document.createElement('div');
  div.className = 'modal-backdrop';
  div.innerHTML = `<div class="modal">
    <h2>Booking Confirmed</h2>
    <p style="margin:6px 0 14px;font-size:13.5px;">PNR <span class="pnr">${esc(data.pnr)}</span></p>
    <p style="font-size:13.5px;color:var(--ink-soft);margin:0 0 4px;">Trip: ${esc(trip.route_name)}, ${fmtDate(trip.date)}, ${esc(trip.time)}</p>
    <p style="font-size:13.5px;color:var(--ink-soft);margin:0 0 4px;">Booked by: ${esc(state.user.name)} (${esc(state.user.role)})</p>
    ${data.pickupPoint ? `<p style="font-size:13.5px;color:var(--ink-soft);margin:0 0 4px;">Pickup Stop: 📍 <b>${esc(data.pickupPoint)}</b></p>` : ''}
    <p style="font-size:13.5px;color:var(--ink-soft);margin:0 0 14px;">Total: ${fmtMoney(data.totalAmount)} · Paid now: ${fmtMoney(data.amountPaid)} · Balance: ${fmtMoney(Math.max(0, data.totalAmount - data.amountPaid))} · ${esc(data.paidStatus)}</p>
    <div class="table-wrap"><table><thead><tr><th>Seat</th><th>Name</th><th>Age</th><th>Gender</th><th>Phone</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div style="margin-top:18px;display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;">
      <button class="btn btn-whatsapp" id="modalShareWaBtn">💬 Share WhatsApp</button>
      <button class="btn btn-secondary" id="modalTicketBtn">Print Boarding Pass</button>
      <button class="btn btn-primary" id="modalOk">Done</button>
    </div>
  </div>`;
  document.body.appendChild(div);

  const confirmObj = {
    pnr: data.pnr,
    total_amount: data.totalAmount,
    amount_paid: data.amountPaid,
    paid_status: data.paidStatus,
    booked_by: state.user.name,
    pickup_point: data.pickupPoint,
    seats: seats.map((s) => ({ seat_label: s.label, passenger_name: s.name, age: s.age, gender: s.gender, contact: s.contact })),
  };

  const waBtn = document.getElementById('modalShareWaBtn');
  if (waBtn) waBtn.onclick = () => shareTicketWhatsapp(confirmObj, trip);

  document.getElementById('modalTicketBtn').onclick = () => {
    openTicketModal(confirmObj, trip);
  };

  document.getElementById('modalOk').onclick = () => {
    div.remove();
    bookingCtx = { step: 1, tripId: null, selected: [], pax: {}, mode: 'individual', groupContact: '', applyAll: true, lead: { name: '', age: '', gender: '' }, advancePaid: '', paymentMethod: 'Cash', pickupPoint: '' };
    dashboardCtx.loaded = false;
    nav('#/dashboard');
  };
}

/* ---------- Manifest ---------- */
function manifestView() {
  const rOpts = Cache.routes.map((r) => `<option value="${r.id}" ${manifestCtx.route === String(r.id) ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
  const tOpts = (manifestCtx.trips || []).map((t) => `<option value="${t.id}" ${manifestCtx.tripId === String(t.id) ? 'selected' : ''}>${esc(t.time)} – ${esc(t.bus_name)}</option>`).join('');
  let body = '';
  if (manifestCtx.data) body = renderManifestBody(manifestCtx.data);
  else if (manifestCtx.tripsLoaded && manifestCtx.trips.length === 0) body = `<div class="panel no-print"><div class="empty">No trips found for the selected filters.</div></div>`;

  return `
  <h1 class="page-title no-print">View Manifest</h1>
  <div class="panel no-print">
    <h3>Select Trip for Manifest</h3>
    <div class="formrow">
      <div class="field"><label>Route (optional)</label><select id="mRoute"><option value="">All routes</option>${rOpts}</select></div>
      <div class="field"><label>Date</label><input id="mDate" type="date" value="${manifestCtx.date}"></div>
      <div class="field"><label>Trip</label><select id="mTrip"><option value="">Select trip</option>${tOpts}</select></div>
      <button class="btn btn-primary" id="loadBtn">Load Manifest</button>
    </div>
  </div>
  ${body}`;
}

function paidPill(status) {
  if (status === 'Paid') return '<span class="pill pill-ok">Paid</span>';
  if (status === 'Partial') return '<span class="pill pill-warn">Advance</span>';
  return '<span class="pill pill-err">Unpaid</span>';
}

function renderManifestBody({ trip, seatData, bookings }) {
  let list = bookings;
  if (manifestCtx.bookedByFilter) {
    list = bookings.filter((b) => b.booked_by_username === manifestCtx.bookedByFilter || b.booked_by === manifestCtx.bookedByFilter);
  }
  const agents = [...new Set(bookings.map((b) => b.booked_by_username || b.booked_by).filter(Boolean))];
  const total = seatData.seatCount || countSeats(seatData.grid);
  const totalBookedSeats = bookings.reduce((n, b) => n + b.seats.length, 0);
  const boardedCount = bookings.reduce((n, b) => n + b.seats.filter((s) => s.boarded).length, 0);
  const pctBoarded = totalBookedSeats > 0 ? Math.round((boardedCount / totalBookedSeats) * 100) : 0;
  const width = Math.max(...seatData.grid.map((r) => r.length), 1);

  const seatCells = seatData.grid.map((row) => row.map((lab) => {
    if (lab == null || lab === '') return `<div class="seat aisle"></div>`;
    const s = seatData.booked[lab];
    if (s) {
      const isB = !!s.boarded;
      return `<div class="mseat mseat-booked ${isB ? 'mseat-boarded' : ''}">${esc(lab)}${isB ? ' ✓' : ''}<div class="tooltip">Seat: ${esc(lab)}<br>Passenger: ${esc(s.passenger_name)}<br>Status: ${isB ? 'Boarded' : 'Not Boarded'}<br>Age: ${esc(s.age)} · ${esc(s.gender)}<br>Phone: ${esc(s.contact || '—')}<br>PNR: ${esc(s.pnr)}<br>Booked by: ${esc(s.booked_by)}${s.booked_by_role ? ' (' + esc(s.booked_by_role) + ')' : ''}<br>${esc(s.paid_status || '')} · paid ${fmtMoney(s.amount_paid || 0)}</div></div>`;
    }
    return `<div class="mseat mseat-avail">${esc(lab)}</div>`;
  }).join('')).join('');

  function bookingRowsHtml(items, startSr) {
    let sr = startSr;
    return items.flatMap((b) => b.seats.map((s) => {
      sr += 1;
      const bal = Math.max(0, Number(b.total_amount || 0) - Number(b.amount_paid || 0));
      const canCancelThis = canManage() || roleIs('Supervisor') || b.booked_by_username === state.user.username;
      return `<tr>
        <td>${sr}</td>
        <td><b>${esc(s.seat_label)}</b></td>
        <td><b>${esc(s.passenger_name)}</b></td>
        <td>${esc(s.age || '—')} / ${esc(s.gender || '—')}</td>
        <td>${esc(s.contact || '—')}</td>
        <td>${b.pickup_point ? `<span style="display:inline-block;padding:2px 7px;border-radius:4px;font-size:11.5px;font-weight:600;background:#E0F2FE;color:#0369A1;">📍 ${esc(b.pickup_point)}</span>` : '<span class="muted" style="font-size:12px;">Standard</span>'}</td>
        <td><span class="pnr">${esc(b.pnr)}</span></td>
        <td>
          <div><b>${fmtMoney(b.total_amount)}</b></div>
          <div class="muted" style="font-size:11px;">Paid: ${fmtMoney(b.amount_paid)} · Due: ${fmtMoney(bal)}</div>
          <div style="margin-top:2px;">${paidPill(b.paid_status)}</div>
          ${bal > 0 ? `<button class="btn btn-primary btn-sm no-print" style="margin-top:4px;font-size:11px;padding:3px 7px;" data-collect-due="${b.id}" data-due="${bal}" data-pax="${esc(s.passenger_name)}" data-pnr="${esc(b.pnr)}">💳 Collect ₹${bal}</button>` : ''}
        </td>
        <td>
          ${s.boarded ? `
            <div>
              <span class="pill pill-ok" style="font-size:11.5px;padding:2px 8px;">✓ Boarded</span>
              <button class="btn btn-secondary btn-sm no-print" data-unboard-seat="${s.id}" data-pnr="${esc(b.pnr)}" data-seat="${esc(s.seat_label)}" style="padding:1px 5px;font-size:10.5px;margin-left:4px;" title="Undo boarding">Undo</button>
              ${s.boarded_at ? `<div class="muted" style="font-size:10.5px;margin-top:2px;">${new Date(s.boarded_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}${s.boarded_by ? ' · ' + esc(s.boarded_by) : ''}</div>` : ''}
            </div>` : `
            <button class="btn btn-secondary btn-sm no-print" data-board-seat="${s.id}" data-bid="${b.id}" data-due="${bal}" data-pax="${esc(s.passenger_name)}" data-pnr="${esc(b.pnr)}" data-seat="${esc(s.seat_label)}" style="font-weight:600;padding:4px 9px;font-size:11.5px;">Board ➔</button>`}
        </td>
        <td class="no-print">
          <div style="display:flex;gap:4px;flex-wrap:wrap;">
            <button class="btn btn-secondary btn-sm" data-manifest-ticket="${b.id}" title="Print Boarding Pass">Pass</button>
            <button class="btn btn-whatsapp btn-sm" data-manifest-wa="${b.id}" title="Share via WhatsApp">💬 WA</button>
            ${b.seats.length > 1 && canCancelThis
          ? `<button class="btn btn-danger btn-sm" data-manifest-cancel-seat="${b.id}|${esc(s.seat_label)}" title="Cancel this seat only">Seat</button>`
          : ''}
            ${canCancelThis
          ? `<button class="btn btn-danger btn-sm" data-manifest-cancel="${b.id}" data-pnr="${esc(b.pnr)}" title="Cancel entire booking">Cancel</button>`
          : ''}
          </div>
        </td>
      </tr>`;
    })).join('');
  }

  let listHtml = '';
  if (list.length === 0) {
    listHtml = `<div class="empty">No bookings found for this trip${manifestCtx.bookedByFilter ? ' / filter' : ''}.</div>`;
  } else if (manifestCtx.groupByAgent && !manifestCtx.bookedByFilter) {
    const groups = {};
    list.forEach((b) => {
      const key = b.booked_by_username || b.booked_by || 'Unknown';
      if (!groups[key]) groups[key] = { label: `${b.booked_by || key}${b.booked_by_role ? ' (' + b.booked_by_role + ')' : ''}`, items: [] };
      groups[key].items.push(b);
    });
    let sr = 0;
    listHtml = Object.keys(groups).map((key) => {
      const g = groups[key];
      const seatN = g.items.reduce((n, b) => n + b.seats.length, 0);
      const html = bookingRowsHtml(g.items, sr);
      sr += seatN;
      return `<div class="agent-group">
        <div class="agent-group-head"><b>${esc(g.label)}</b><span>${seatN} seat(s) · @${esc(key)}</span></div>
        <div class="table-wrap"><table class="manifest-table">
          <thead><tr><th>Sr.</th><th>Seat</th><th>Name</th><th>Age/Gen</th><th>Phone</th><th>Pickup Stop</th><th>PNR</th><th>Amount & Balance</th><th>Boarding</th><th class="no-print">Actions</th></tr></thead>
          <tbody>${html}</tbody>
        </table></div>
      </div>`;
    }).join('');
  } else {
    listHtml = `<div class="table-wrap"><table class="manifest-table">
      <thead><tr><th>Sr.</th><th>Seat</th><th>Name</th><th>Age/Gen</th><th>Phone</th><th>Pickup Stop</th><th>PNR</th><th>Amount & Balance</th><th>Boarding</th><th class="no-print">Actions</th></tr></thead>
      <tbody>${bookingRowsHtml(list, 0)}</tbody>
    </table></div>`;
  }

  const collected = bookings.reduce((n, b) => n + Number(b.amount_paid || 0), 0);
  const cashCollected = bookings.filter((b) => !b.payment_method || b.payment_method === 'Cash').reduce((n, b) => n + Number(b.amount_paid || 0), 0);
  const upiCollected = bookings.filter((b) => b.payment_method === 'UPI').reduce((n, b) => n + Number(b.amount_paid || 0), 0);
  const cardCollected = bookings.filter((b) => b.payment_method === 'Card').reduce((n, b) => n + Number(b.amount_paid || 0), 0);
  const due = bookings.reduce((n, b) => n + Math.max(0, Number(b.total_amount || 0) - Number(b.amount_paid || 0)), 0);

  return `
  <div id="printArea">
    <div class="print-only print-header">
      <h1>Seva Bus Booking — Manifest</h1>
      <p>${esc(trip.route_name)} · ${esc(trip.bus_name)} · ${fmtDate(trip.date)}, ${esc(trip.time)}</p>
    </div>
    <div class="manifest-banner">
      <span><b>${esc(trip.route_name)}</b></span><span>${esc(trip.bus_name)}</span><span>${fmtDate(trip.date)}, ${esc(trip.time)}</span>
      <span>Total Seats: ${total}</span><span>Booked: ${totalBookedSeats}</span><span>Available: ${total - totalBookedSeats}</span>
      <span>Boarded: <b>${boardedCount} / ${totalBookedSeats}</b> (${pctBoarded}%)</span>
      <span>Collected: <b>${fmtMoney(collected)}</b> <span class="muted" style="font-size:11.5px;">(Cash: <b>${fmtMoney(cashCollected)}</b> · UPI: <b>${fmtMoney(upiCollected)}</b>${cardCollected > 0 ? ' · Card: <b>' + fmtMoney(cardCollected) + '</b>' : ''})</span></span>
      <span>Due: ${fmtMoney(due)}</span>
    </div>
    <div class="boarding-progress-bar no-print">
      <div class="boarding-progress-fill" style="width:${pctBoarded}%"></div>
    </div>
    <div class="formrow no-print" style="margin-bottom:14px;">
      <div class="field"><label>Filter by booked-by</label>
        <select id="mBookedBy"><option value="">All staff</option>
          ${agents.map((a) => `<option value="${esc(a)}" ${manifestCtx.bookedByFilter === a ? 'selected' : ''}>${esc(a)}</option>`).join('')}
        </select>
      </div>
      <label class="checkline" style="margin:0;"><input type="checkbox" id="mGroupBy" ${manifestCtx.groupByAgent ? 'checked' : ''}> Separate by booked-by</label>
      <button class="btn btn-secondary" id="exportCsvBtn">Export CSV</button>
      <button class="btn btn-secondary" id="printBtn">Print Manifest</button>
    </div>
    <div class="booking-grid print-stack">
      <div class="panel"><h3>Seat Map</h3>
        <div class="seatmap" style="grid-template-columns:repeat(${width},40px)">${seatCells}</div>
        <div class="legend no-print">
          <span><span class="dot" style="background:var(--seat-avail-bg);border:1.5px solid var(--seat-avail);"></span>Available</span>
          <span><span class="dot" style="background:var(--seat-booked-bg);border:1.5px solid var(--seat-booked);"></span>Booked</span>
        </div>
      </div>
      <div class="panel"><h3>Passenger List ${manifestCtx.groupByAgent && !manifestCtx.bookedByFilter ? '(by staff)' : ''}</h3>
        ${listHtml}
      </div>
    </div>
  </div>`;
}

async function loadTripOptions() {
  const qs = new URLSearchParams({ date: manifestCtx.date });
  if (manifestCtx.route) qs.set('routeId', manifestCtx.route);
  try { manifestCtx.trips = await api('/trips?' + qs.toString()); }
  catch { manifestCtx.trips = []; }
  manifestCtx.tripsLoaded = true;
}

async function attachManifest() {
  if (!manifestCtx.tripsLoaded) { await loadTripOptions(); nav('#/manifest'); return; }
  const mRoute = document.getElementById('mRoute');
  if (mRoute) mRoute.onchange = async (e) => { manifestCtx.route = e.target.value; manifestCtx.tripId = ''; manifestCtx.data = null; await loadTripOptions(); nav('#/manifest'); };
  const mDate = document.getElementById('mDate');
  if (mDate) mDate.onchange = async (e) => { manifestCtx.date = e.target.value; manifestCtx.tripId = ''; manifestCtx.data = null; await loadTripOptions(); nav('#/manifest'); };
  const mTrip = document.getElementById('mTrip');
  if (mTrip) mTrip.onchange = (e) => { manifestCtx.tripId = e.target.value; };
  const loadBtn = document.getElementById('loadBtn');
  if (loadBtn) loadBtn.onclick = async (e) => {
    const btn = e.currentTarget;
    const sel = document.getElementById('mTrip');
    if (!sel.value) { toast('Select a trip to load its manifest'); return; }
    manifestCtx.tripId = sel.value;
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Loading…';
    try {
      const [trip, seatData, bookings] = await Promise.all([
        api('/trips/' + manifestCtx.tripId),
        api('/trips/' + manifestCtx.tripId + '/seats'),
        api('/bookings?tripId=' + manifestCtx.tripId),
      ]);
      manifestCtx.data = { trip, seatData, bookings };
      nav('#/manifest');
    } catch (err) { toast(err.message); btn.disabled = false; btn.textContent = 'Load Manifest'; }
  };
  const mBookedBy = document.getElementById('mBookedBy');
  if (mBookedBy) mBookedBy.onchange = (e) => { manifestCtx.bookedByFilter = e.target.value; nav('#/manifest'); };
  const mGroupBy = document.getElementById('mGroupBy');
  if (mGroupBy) mGroupBy.onchange = (e) => { manifestCtx.groupByAgent = e.target.checked; nav('#/manifest'); };
  const pb = document.getElementById('printBtn');
  if (pb) pb.onclick = () => window.print();

  const exportBtn = document.getElementById('exportCsvBtn');
  if (exportBtn && manifestCtx.data) {
    exportBtn.onclick = () => downloadManifestCsv(manifestCtx.data.trip, manifestCtx.data.bookings);
  }

  const reloadManifest = async () => {
    try {
      const [trip, seatData, bookings] = await Promise.all([
        api('/trips/' + manifestCtx.tripId),
        api('/trips/' + manifestCtx.tripId + '/seats'),
        api('/bookings?tripId=' + manifestCtx.tripId),
      ]);
      manifestCtx.data = { trip, seatData, bookings };
      dashboardCtx.loaded = false;
      nav('#/manifest');
    } catch (err) { toast('Error updating manifest: ' + err.message); }
  };

  document.querySelectorAll('[data-board-seat]').forEach((btn) => {
    btn.onclick = async () => {
      const seatId = btn.getAttribute('data-board-seat');
      const bId = btn.getAttribute('data-bid');
      const due = Number(btn.getAttribute('data-due')) || 0;
      const pax = btn.getAttribute('data-pax');
      const seat = btn.getAttribute('data-seat');

      const booking = (manifestCtx.data.bookings || []).find((x) => String(x.id) === String(bId));

      if (due > 0 && booking) {
        promptBoardWithDue(booking, manifestCtx.data.trip, seatId, seat, due, pax, reloadManifest);
      } else {
        btn.disabled = true;
        try {
          await api('/manifest/board', { method: 'POST', body: JSON.stringify({ seatId, boarded: 1 }) });
          toast(`Seat ${seat} marked boarded`);
          await reloadManifest();
        } catch (e) { toast(e.message); btn.disabled = false; }
      }
    };
  });

  document.querySelectorAll('[data-unboard-seat]').forEach((btn) => {
    btn.onclick = async () => {
      const seatId = btn.getAttribute('data-unboard-seat');
      const seat = btn.getAttribute('data-seat');
      btn.disabled = true;
      try {
        await api('/manifest/board', { method: 'POST', body: JSON.stringify({ seatId, boarded: 0 }) });
        toast(`Seat ${seat} boarding unmarked`);
        await reloadManifest();
      } catch (e) { toast(e.message); btn.disabled = false; }
    };
  });

  document.querySelectorAll('[data-collect-due]').forEach((btn) => {
    btn.onclick = () => {
      const bId = btn.getAttribute('data-collect-due');
      const due = Number(btn.getAttribute('data-due')) || 0;
      const pax = btn.getAttribute('data-pax');
      const booking = (manifestCtx.data.bookings || []).find((x) => String(x.id) === String(bId));
      if (booking) {
        openSpotPaymentModal(booking, manifestCtx.data.trip, due, pax, reloadManifest);
      }
    };
  });

  document.querySelectorAll('[data-manifest-wa]').forEach((btn) => {
    btn.onclick = () => {
      const bId = btn.getAttribute('data-manifest-wa');
      const booking = (manifestCtx.data.bookings || []).find((x) => String(x.id) === String(bId));
      if (booking) shareTicketWhatsapp(booking, manifestCtx.data.trip);
    };
  });

  document.querySelectorAll('[data-manifest-ticket]').forEach((btn) => {
    btn.onclick = () => {
      const bId = btn.getAttribute('data-manifest-ticket');
      const booking = (manifestCtx.data.bookings || []).find((x) => String(x.id) === String(bId));
      if (booking) openTicketModal(booking, manifestCtx.data.trip);
    };
  });

  document.querySelectorAll('[data-manifest-cancel]').forEach((btn) => {
    btn.onclick = () => {
      const bId = btn.getAttribute('data-manifest-cancel');
      const pnr = btn.getAttribute('data-pnr');
      cancelBookingPrompt(bId, pnr, async () => {
        await reloadManifest();
      });
    };
  });

  document.querySelectorAll('[data-manifest-cancel-seat]').forEach((btn) => {
    btn.onclick = () => {
      const [bId, seatLabel] = btn.getAttribute('data-manifest-cancel-seat').split('|');
      cancelSeatPrompt(bId, seatLabel, async () => {
        await reloadManifest();
      });
    };
  });
}

function promptBoardWithDue(booking, trip, seatId, seatLabel, due, paxName, reloadManifest) {
  closeModal();
  const div = document.createElement('div');
  div.className = 'modal-backdrop';
  div.innerHTML = `
    <div class="modal modal-form" style="max-width:420px;">
      <h2 style="margin-top:0;">⚠️ Balance Pending</h2>
      <p style="font-size:13.5px;color:var(--ink);line-height:1.5;">
        Passenger <b>${esc(paxName)}</b> (Seat <b>${esc(seatLabel)}</b>, PNR <span class="pnr">${esc(booking.pnr)}</span>) has an outstanding balance of <b>${fmtMoney(due)}</b>.
      </p>
      <div style="background:#FFFBEB;border:1px solid #FDE68A;padding:10px 12px;border-radius:6px;font-size:12.5px;color:#92400E;margin:12px 0 16px;">
        💡 You can collect the payment right now (via Cash, UPI QR, or Card) and board automatically, or proceed with boarding only.
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;">
        <button class="btn btn-primary" id="promptCollectBtn" style="justify-content:center;">💳 Collect ${fmtMoney(due)} & Board</button>
        <button class="btn btn-secondary" id="promptBoardOnlyBtn" style="justify-content:center;">✓ Board Without Collecting</button>
        <button class="btn btn-secondary" id="promptCancelBtn" style="justify-content:center;opacity:0.75;">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(div);

  div.querySelector('#promptCollectBtn').onclick = () => {
    div.remove();
    openSpotPaymentModal(booking, trip, due, paxName, reloadManifest);
  };

  div.querySelector('#promptBoardOnlyBtn').onclick = async () => {
    div.remove();
    try {
      await api('/manifest/board', { method: 'POST', body: JSON.stringify({ seatId, boarded: 1 }) });
      toast(`Seat ${seatLabel} marked boarded`);
      await reloadManifest();
    } catch (e) { toast(e.message); }
  };

  div.querySelector('#promptCancelBtn').onclick = () => div.remove();
}

function openSpotPaymentModal(booking, trip, defaultDue, passengerName, onComplete) {
  closeModal();
  const div = document.createElement('div');
  div.className = 'modal-backdrop';
  div.id = 'spotPaymentModal';

  const initialDue = Math.max(1, Math.round(Number(defaultDue) || 0));
  let selectedMethod = 'Cash';

  div.innerHTML = `
    <div class="modal modal-form spot-pay-card" style="max-width:440px;">
      <h2 style="margin-top:0;">💳 Spot Balance Collection</h2>
      <p style="color:var(--ink-soft);font-size:13px;margin:-4px 0 14px;">
        PNR: <b class="pnr">${esc(booking.pnr)}</b> · ${esc(passengerName || 'Passenger')}
      </p>
      <div id="spotPayErr" class="banner banner-err hidden"></div>

      <div style="background:#F8FAFC;border:1px solid #E2E8F0;padding:12px 14px;border-radius:8px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:center;">
        <div>
          <div style="font-size:11.5px;color:#64748B;text-transform:uppercase;font-weight:600;">Balance Due</div>
          <div style="font-size:22px;font-weight:700;color:var(--primary);">${fmtMoney(defaultDue)}</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:11.5px;color:#64748B;">Total Booking</div>
          <div style="font-size:14px;font-weight:600;">${fmtMoney(booking.total_amount)}</div>
          <div style="font-size:11.5px;color:#10B981;">Paid: ${fmtMoney(booking.amount_paid)}</div>
        </div>
      </div>

      <div class="field">
        <label for="spotPayAmount">Amount to Collect (₹)</label>
        <input type="number" id="spotPayAmount" min="1" max="${defaultDue}" step="1" value="${initialDue}" required>
      </div>

      <div class="field">
        <label>Payment Mode</label>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;" id="spotMethodGroup">
          <button type="button" class="btn btn-secondary active" data-method="Cash">💵 Cash</button>
          <button type="button" class="btn btn-secondary" data-method="UPI">📱 UPI</button>
          <button type="button" class="btn btn-secondary" data-method="Card">💳 Card</button>
        </div>
      </div>

      <label class="checkline" style="margin:14px 0 18px;background:#F1F5F9;padding:8px 10px;border-radius:6px;">
        <input type="checkbox" id="spotMarkBoarded" checked>
        <span><b>Mark passenger as Boarded</b> upon payment</span>
      </label>

      <div style="display:flex;justify-content:flex-end;gap:8px;">
        <button type="button" class="btn btn-secondary" id="spotPayCancel">Cancel</button>
        <button type="button" class="btn btn-primary" id="spotPaySubmit">Confirm & Collect</button>
      </div>
    </div>
  `;

  document.body.appendChild(div);

  const amountInput = div.querySelector('#spotPayAmount');
  const errBanner = div.querySelector('#spotPayErr');
  const submitBtn = div.querySelector('#spotPaySubmit');

  div.querySelectorAll('#spotMethodGroup button').forEach((btn) => {
    btn.onclick = () => {
      div.querySelectorAll('#spotMethodGroup button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      selectedMethod = btn.getAttribute('data-method');
    };
  });

  div.querySelector('#spotPayCancel').onclick = () => div.remove();

  submitBtn.onclick = async () => {
    const amt = Number(amountInput.value);
    const markBoarded = div.querySelector('#spotMarkBoarded').checked;
    errBanner.classList.add('hidden');

    if (Number.isNaN(amt) || amt <= 0) {
      errBanner.textContent = 'Please enter a valid amount.';
      errBanner.classList.remove('hidden');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="spin"></span>Processing…';

    try {
      await api('/bookings/' + booking.id + '/pay-balance', {
        method: 'POST',
        body: JSON.stringify({
          amount: amt,
          paymentMethod: selectedMethod,
          markBoarded,
        }),
      });
      toast(`Collected ₹${amt} via ${selectedMethod}!`);
      div.remove();
      if (onComplete) await onComplete();
    } catch (err) {
      errBanner.textContent = err.message || 'Payment collection failed.';
      errBanner.classList.remove('hidden');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Confirm & Collect';
    }
  };
}

/* ---------- Activity & Cancellation Audit Logs View ---------- */
let auditLogsCtx = { logs: [], filter: '', loading: false, loaded: false };

async function loadAuditLogs() {
  auditLogsCtx.loading = true;
  try {
    auditLogsCtx.logs = await api('/audit-logs?limit=200');
    auditLogsCtx.loaded = true;
  } catch (err) {
    toast('Error loading audit logs: ' + err.message);
  } finally {
    auditLogsCtx.loading = false;
  }
}

function auditBadgeClass(action) {
  const act = String(action || '').toUpperCase();
  if (act.includes('CANCEL')) return 'audit-badge audit-cancelled';
  if (act.includes('BOARD')) return 'audit-badge audit-boarded';
  if (act.includes('PAY') || act.includes('BALANCE')) return 'audit-badge audit-payment';
  if (act.includes('UPDATE')) return 'audit-badge audit-updated';
  return 'audit-badge audit-created';
}

function formatAuditDetails(raw) {
  if (!raw) return '—';
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (typeof obj !== 'object' || obj == null) return esc(String(raw));
    const parts = [];
    if (obj.seats) parts.push(`Seats: <b>${esc(Array.isArray(obj.seats) ? obj.seats.join(', ') : obj.seats)}</b>`);
    if (obj.amount != null) parts.push(`Amount: <b>${fmtMoney(obj.amount)}</b>`);
    if (obj.paymentMethod) parts.push(`Method: ${esc(obj.paymentMethod)}`);
    if (obj.pickupPoint) parts.push(`Pickup: 📍 ${esc(obj.pickupPoint)}`);
    if (obj.pnr) parts.push(`PNR: <b>${esc(obj.pnr)}</b>`);
    if (obj.passenger) parts.push(`Pax: ${esc(obj.passenger)}`);
    if (obj.collector) parts.push(`Collector: ${esc(obj.collector)}`);
    if (obj.reason) parts.push(`Reason: ${esc(obj.reason)}`);
    if (obj.name) parts.push(`Name: ${esc(obj.name)}`);
    if (obj.fare != null) parts.push(`Fare: ${fmtMoney(obj.fare)}`);
    if (parts.length > 0) return parts.join(' · ');
    return esc(JSON.stringify(obj));
  } catch {
    return esc(String(raw));
  }
}

function auditLogsView() {
  const logs = auditLogsCtx.logs || [];
  const q = (auditLogsCtx.filter || '').trim().toLowerCase();
  const filtered = q
    ? logs.filter((l) =>
        String(l.action || '').toLowerCase().includes(q) ||
        String(l.performed_by || '').toLowerCase().includes(q) ||
        String(l.entity_id || '').toLowerCase().includes(q) ||
        String(l.details || '').toLowerCase().includes(q)
      )
    : logs;

  const totalLogs = logs.length;
  const bookingCount = logs.filter((l) => l.action && l.action.includes('BOOKING_CREATED')).length;
  const cancelCount = logs.filter((l) => l.action && l.action.includes('CANCEL')).length;
  const boardCount = logs.filter((l) => l.action && l.action.includes('BOARD')).length;
  const payCount = logs.filter((l) => l.action && (l.action.includes('PAY') || l.action.includes('BALANCE'))).length;

  const rows = filtered.map((l) => `
    <tr>
      <td style="white-space:nowrap;font-size:12px;color:var(--ink-soft);">${new Date(l.created_at).toLocaleString('en-IN')}</td>
      <td><span class="${auditBadgeClass(l.action)}">${esc(l.action)}</span></td>
      <td><b>${esc(l.entity_type)}</b> ${l.entity_id ? `· <span class="pnr" style="font-size:12px;">${esc(l.entity_id)}</span>` : ''}</td>
      <td style="font-size:12.5px;">${formatAuditDetails(l.details)}</td>
      <td><b>${esc(l.performed_by)}</b> <span class="muted" style="font-size:11px;">(${esc(l.role)})</span></td>
    </tr>
  `).join('');

  return `
  <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:14px;">
    <h1 class="page-title" style="margin:0;">Activity & Cancellation Logs</h1>
    <div style="display:flex;gap:8px;">
      <button class="btn btn-secondary" id="refreshAuditBtn">🔄 Refresh</button>
    </div>
  </div>

  <div class="kpi-grid" style="margin-bottom:16px;">
    <div class="kpi-card"><div class="kpi-num">${totalLogs}</div><div class="kpi-lbl">Total Events Logged</div></div>
    <div class="kpi-card"><div class="kpi-num">${bookingCount}</div><div class="kpi-lbl">Bookings Created</div></div>
    <div class="kpi-card"><div class="kpi-num">${cancelCount}</div><div class="kpi-lbl">Cancellations</div></div>
    <div class="kpi-card"><div class="kpi-num">${boardCount}</div><div class="kpi-lbl">Boarding Events</div></div>
    <div class="kpi-card"><div class="kpi-num">${payCount}</div><div class="kpi-lbl">Balance Collections</div></div>
  </div>

  <div class="panel">
    <div class="formrow" style="margin-bottom:12px;">
      <div class="field" style="flex:1;">
        <input id="auditSearchInput" placeholder="Filter by action, user, PNR, or keyword..." value="${esc(auditLogsCtx.filter || '')}">
      </div>
      ${auditLogsCtx.filter ? '<button class="btn btn-secondary" id="clearAuditFilterBtn">Clear</button>' : ''}
    </div>

    ${filtered.length === 0 ? `<div class="empty">No audit logs matching "${esc(auditLogsCtx.filter)}"</div>` : `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Timestamp</th>
            <th>Action</th>
            <th>Entity</th>
            <th>Details</th>
            <th>Performed By</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`}
  </div>
  `;
}

async function attachAuditLogs() {
  if (!auditLogsCtx.loaded && !auditLogsCtx.loading) {
    await loadAuditLogs();
    const main = document.getElementById('main');
    if (main) {
      main.innerHTML = auditLogsView();
      attachAuditLogs();
    }
    return;
  }

  const sInput = document.getElementById('auditSearchInput');
  if (sInput) {
    sInput.oninput = (e) => {
      auditLogsCtx.filter = e.target.value;
      const main = document.getElementById('main');
      if (main) {
        main.innerHTML = auditLogsView();
        attachAuditLogs();
      }
    };
  }

  const clearBtn = document.getElementById('clearAuditFilterBtn');
  if (clearBtn) {
    clearBtn.onclick = () => {
      auditLogsCtx.filter = '';
      const main = document.getElementById('main');
      if (main) {
        main.innerHTML = auditLogsView();
        attachAuditLogs();
      }
    };
  }

  const refBtn = document.getElementById('refreshAuditBtn');
  if (refBtn) {
    refBtn.onclick = async () => {
      refBtn.disabled = true;
      refBtn.innerHTML = '<span class="spin"></span>';
      await loadAuditLogs();
      const main = document.getElementById('main');
      if (main) {
        main.innerHTML = auditLogsView();
        attachAuditLogs();
      }
    };
  }
}

/* ---------- Admin: shared modal helpers ---------- */
function closeModal() {
  document.querySelectorAll('.modal-backdrop').forEach((el) => el.remove());
}

function openFormModal({ title, bodyHtml, submitLabel, onSubmit, wide }) {
  closeModal();
  const div = document.createElement('div');
  div.className = 'modal-backdrop';
  div.innerHTML = `<div class="modal modal-form ${wide ? 'modal-wide' : ''}">
    <h2>${title}</h2>
    <div id="formErr" class="banner banner-err hidden"></div>
    <form id="adminForm">${bodyHtml}
      <div class="actions-row" style="justify-content:flex-end;margin-top:20px;">
        <button type="button" class="btn btn-secondary" id="formCancel">Cancel</button>
        <button type="submit" class="btn btn-primary" id="formSubmit">${submitLabel}</button>
      </div>
    </form>
  </div>`;
  document.body.appendChild(div);
  div.addEventListener('click', (e) => { if (e.target === div) closeModal(); });
  document.getElementById('formCancel').onclick = closeModal;
  document.getElementById('adminForm').onsubmit = async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('formErr');
    const btn = document.getElementById('formSubmit');
    errEl.classList.add('hidden');
    btn.disabled = true;
    const prev = btn.textContent;
    btn.innerHTML = '<span class="spin"></span>Saving…';
    try {
      await onSubmit();
      closeModal();
    } catch (err) {
      errEl.textContent = err.message || 'Could not save.';
      errEl.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = prev;
    }
  };
}

function statusPill(active) {
  return active ? '<span class="pill pill-ok">Active</span>' : '<span class="pill pill-off">Inactive</span>';
}
function tripStatusPill(status) {
  if (status === 'Planned') return '<span class="pill pill-ok">Planned</span>';
  if (status === 'In-Transit') return '<span class="pill pill-transit">In-Transit</span>';
  if (status === 'Completed') return '<span class="pill pill-done">Completed</span>';
  if (status === 'Cancelled') return '<span class="pill pill-err">Cancelled</span>';
  return `<span class="pill pill-off">${esc(status)}</span>`;
}

/* ---------- Admin: Buses + custom layout ---------- */
function adminBusesView() {
  const rows = Cache.buses.map((b) => `
    <tr>
      <td>${esc(b.name)}</td>
      <td>${esc(b.pattern || 'custom')}</td>
      <td>${b.seatCount || b.cols} seats · ${b.rows} rows</td>
      <td>${statusPill(b.active)}</td>
      <td>
        <button class="btn btn-secondary btn-sm" data-edit-bus="${b.id}">Edit</button>
        <button class="btn btn-secondary btn-sm" data-layout-bus="${b.id}">Layout</button>
        <button class="btn btn-danger btn-sm" data-del-bus="${b.id}">Delete</button>
      </td>
    </tr>`).join('') || `<tr><td colspan="5" class="empty">No buses yet.</td></tr>`;
  return `
  <h1 class="page-title">Manage Buses &amp; Layouts</h1>
  <p class="page-sub">Define buses and design custom seat layouts (click seats to toggle aisle).</p>
  <div class="panel">
    <div class="panel-head">
      <h3>Buses</h3>
      <button class="btn btn-primary" id="addBusBtn">Add Bus</button>
    </div>
    <div style="overflow-x:auto;"><table>
      <thead><tr><th>Name</th><th>Pattern</th><th>Capacity</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`;
}

function attachAdminBuses() {
  document.getElementById('addBusBtn').onclick = () => openBusForm(null);
  document.querySelectorAll('[data-edit-bus]').forEach((btn) => {
    btn.onclick = () => {
      const bus = Cache.buses.find((b) => String(b.id) === btn.getAttribute('data-edit-bus'));
      if (bus) openBusForm(bus);
    };
  });
  document.querySelectorAll('[data-layout-bus]').forEach((btn) => {
    btn.onclick = () => {
      const bus = Cache.buses.find((b) => String(b.id) === btn.getAttribute('data-layout-bus'));
      if (bus) openLayoutEditor(bus);
    };
  });
  document.querySelectorAll('[data-del-bus]').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.getAttribute('data-del-bus');
      if (!confirm('Delete this bus? If it has scheduled trips, you will be prompted to force delete.')) return;
      btn.disabled = true;
      try {
        await api('/buses/' + id, { method: 'DELETE' });
        toast('Bus deleted');
        await loadCaches();
        nav('#/admin/buses');
      } catch (err) {
        if (err.status === 409 && err.data && err.data.needsForce) {
          if (confirm(err.message + '\n\nForce delete bus, trips, and bookings?')) {
            try {
              await api('/buses/' + id + '?force=1', { method: 'DELETE' });
              toast('Bus force-deleted');
              await loadCaches();
              adminCtx.tripsLoaded = false;
              dashboardCtx.loaded = false;
              nav('#/admin/buses');
              return;
            } catch (e2) { toast(e2.message); }
          }
        } else {
          toast(err.message);
        }
        btn.disabled = false;
      }
    };
  });
}

function openBusForm(bus) {
  const isEdit = !!bus;
  const currentPattern = bus ? (bus.pattern || '2+2') : '2+2';
  const isStandardPreset = ['2+2', '2+1', '1+2', '1+1', '3+2', '2+3', '1+1+1', '2+2+1'].includes(currentPattern);
  const presetValue = isStandardPreset ? currentPattern : 'custom';

  openFormModal({
    title: isEdit ? 'Edit Bus' : 'Add Bus',
    submitLabel: isEdit ? 'Save Changes' : 'Create Bus',
    bodyHtml: `
      <div class="field"><label for="busName">Bus Name</label><input id="busName" required value="${bus ? esc(bus.name) : ''}" placeholder="e.g., Seva Super Express"></div>
      <div class="formrow" style="margin-bottom:12px;">
        <div class="field"><label for="busRows">Rows (1–20)</label><input id="busRows" type="number" min="1" max="20" required value="${bus ? bus.rows : 5}"></div>
        <div class="field"><label for="busPattern">Seat Pattern</label>
          <select id="busPattern">
            <option value="2+2" ${presetValue === '2+2' ? 'selected' : ''}>2+2 (Standard 4-abreast)</option>
            <option value="2+1" ${presetValue === '2+1' ? 'selected' : ''}>2+1 (Luxury 3-abreast)</option>
            <option value="1+2" ${presetValue === '1+2' ? 'selected' : ''}>1+2 (Single left, double right)</option>
            <option value="1+1" ${presetValue === '1+1' ? 'selected' : ''}>1+1 (VIP Executive)</option>
            <option value="3+2" ${presetValue === '3+2' ? 'selected' : ''}>3+2 (High-capacity 5-abreast)</option>
            <option value="2+3" ${presetValue === '2+3' ? 'selected' : ''}>2+3 (High-capacity)</option>
            <option value="1+1+1" ${presetValue === '1+1+1' ? 'selected' : ''}>1+1+1 (Individual Pod / Sleeper)</option>
            <option value="2+2+1" ${presetValue === '2+2+1' ? 'selected' : ''}>2+2+1 (Double Aisle Shuttle)</option>
            <option value="custom" ${presetValue === 'custom' ? 'selected' : ''}>Custom Pattern...</option>
          </select>
        </div>
      </div>
      <div id="busCustomPatternWrap" class="field ${presetValue === 'custom' ? '' : 'hidden'}" style="margin-bottom:12px;">
        <label for="busCustomPattern">Custom Pattern Formula</label>
        <input id="busCustomPattern" placeholder="e.g. 2+1, 1+2, 1+1+1, 3+2, 2+2+1" value="${esc(currentPattern)}">
        <span class="muted">Numbers represent seat blocks, '+' represents an aisle gap.</span>
      </div>
      <div class="formrow" style="margin-bottom:12px;">
        <div class="field">
          <label for="busNumbering">Numbering Scheme</label>
          <select id="busNumbering">
            <option value="row-letter">Row Letters (1A, 1B, 1C...)</option>
            <option value="seq">Sequential Numbers (1, 2, 3...)</option>
            <option value="letter-row">Letter First (A1, A2, B1...)</option>
            <option value="sleeper">Berths (S1, S2, S3...)</option>
          </select>
        </div>
        <div class="field" style="display:flex;align-items:center;padding-top:20px;">
          <label class="checkline"><input type="checkbox" id="busRearBench"> Full Rear Bench (continuous last row)</label>
        </div>
      </div>
      ${isEdit ? `<label class="checkline"><input type="checkbox" id="busActive" ${bus.active ? 'checked' : ''}> Active</label>` : ''}
      <p class="form-hint">After creating, click <b>Layout</b> anytime to customize individual seats, labels, aisles, and columns.</p>`,
    onSubmit: async () => {
      const name = document.getElementById('busName').value.trim();
      const rows = Number(document.getElementById('busRows').value);
      const patternChoice = document.getElementById('busPattern').value;
      const customPatternVal = (document.getElementById('busCustomPattern')?.value || '').trim();
      const resolvedPattern = patternChoice === 'custom' ? (customPatternVal || '2+2') : patternChoice;
      const rearBench = document.getElementById('busRearBench')?.checked;
      const numbering = document.getElementById('busNumbering')?.value || 'row-letter';

      if (!name) throw new Error('Bus name is required.');
      if (!Number.isInteger(rows) || rows < 1 || rows > 20) throw new Error('Rows must be between 1 and 20.');

      const layout = (isEdit && bus.layout && bus.pattern === resolvedPattern)
        ? bus.layout
        : defaultLayout(rows, resolvedPattern, { rearBench, numbering });

      const payload = { name, rows, pattern: resolvedPattern, layout };
      if (isEdit) {
        payload.active = document.getElementById('busActive').checked;
        await api('/buses/' + bus.id, { method: 'PATCH', body: JSON.stringify(payload) });
        toast('Bus updated');
      } else {
        await api('/buses', { method: 'POST', body: JSON.stringify(payload) });
        toast('Bus created — open Layout to customize');
      }
      await loadCaches();
      nav('#/admin/buses');
    },
  });

  const patSel = document.getElementById('busPattern');
  const customWrap = document.getElementById('busCustomPatternWrap');
  if (patSel && customWrap) {
    patSel.onchange = () => {
      if (patSel.value === 'custom') {
        customWrap.classList.remove('hidden');
        document.getElementById('busCustomPattern')?.focus();
      } else {
        customWrap.classList.add('hidden');
      }
    };
  }
}

function openSeatEditorModal(r, c, currentLabel, onUpdate, onRemove) {
  const existing = document.getElementById('seatEditorModal');
  if (existing) existing.remove();

  const backdrop = document.createElement('div');
  backdrop.id = 'seatEditorModal';
  backdrop.className = 'modal-backdrop';
  backdrop.style.zIndex = '1100';
  backdrop.innerHTML = `
    <div class="modal" style="max-width:380px;box-shadow:0 8px 30px rgba(0,0,0,.25);">
      <h3 style="margin-top:0;font-size:16px;display:flex;justify-content:space-between;align-items:center;">
        <span>Customize Seat</span>
        <span class="muted" style="font-family:'IBM Plex Mono',monospace;font-size:12px;">R${r + 1} : C${c + 1}</span>
      </h3>
      <div class="field">
        <label for="seatEditLabel">Seat Label / Code</label>
        <input id="seatEditLabel" value="${esc(currentLabel)}" autofocus style="font-weight:700;font-size:16px;letter-spacing:0.04em;">
      </div>
      <div style="font-size:11.5px;color:var(--ink-soft);margin-bottom:6px;">Quick Label Presets:</div>
      <div class="chip-row">
        <button type="button" class="chip-btn" data-chip="VIP">VIP</button>
        <button type="button" class="chip-btn" data-chip="Guide">Guide</button>
        <button type="button" class="chip-btn" data-chip="Driver">Driver</button>
        <button type="button" class="chip-btn" data-chip="D1">D1</button>
        <button type="button" class="chip-btn" data-chip="Ladies">Ladies</button>
        <button type="button" class="chip-btn" data-chip="Staff">Staff</button>
        <button type="button" class="chip-btn" data-chip="${r + 1}A">${r + 1}A</button>
        <button type="button" class="chip-btn" data-chip="${r + 1}B">${r + 1}B</button>
      </div>
      <div class="actions-row" style="margin-top:16px;justify-content:space-between;">
        <button type="button" class="btn btn-danger btn-sm" id="seatEditRemove">Turn to Aisle</button>
        <div style="display:flex;gap:6px;">
          <button type="button" class="btn btn-secondary btn-sm" id="seatEditCancel">Cancel</button>
          <button type="button" class="btn btn-primary btn-sm" id="seatEditSave">Apply</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);
  const input = document.getElementById('seatEditLabel');
  input.focus();
  input.select();

  backdrop.querySelectorAll('[data-chip]').forEach((btn) => {
    btn.onclick = () => {
      input.value = btn.getAttribute('data-chip');
      input.focus();
    };
  });

  const close = () => backdrop.remove();
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.getElementById('seatEditCancel').onclick = close;
  document.getElementById('seatEditRemove').onclick = () => {
    close();
    onRemove();
  };
  document.getElementById('seatEditSave').onclick = () => {
    const val = input.value.trim();
    if (!val) { toast('Seat label cannot be empty'); return; }
    close();
    onUpdate(val);
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('seatEditSave').click();
    } else if (e.key === 'Escape') {
      close();
    }
  };
}

function openLayoutEditor(bus) {
  layoutDraft = cloneLayout(bus.layout || defaultLayout(bus.rows, bus.pattern));
  let currentPattern = bus.pattern || '2+2';
  const rowsCount = () => layoutDraft.length;

  openFormModal({
    title: `Custom Seat Layout — ${esc(bus.name)}`,
    submitLabel: 'Save Layout',
    wide: true,
    bodyHtml: `
      <div class="layout-toolbar">
        <div class="field" style="margin:0;min-width:130px;"><label for="layoutPreset">Preset Pattern</label>
          <select id="layoutPreset">
            <option value="2+2">2+2 (Standard)</option>
            <option value="2+1">2+1 (Luxury)</option>
            <option value="1+2">1+2 (Single / Double)</option>
            <option value="1+1">1+1 (VIP Single)</option>
            <option value="3+2">3+2 (5-abreast)</option>
            <option value="2+3">2+3 (5-abreast)</option>
            <option value="1+1+1">1+1+1 (Pod / Sleeper)</option>
            <option value="2+2+1">2+2+1 (Double Aisle)</option>
            <option value="custom">Custom Pattern</option>
          </select>
        </div>
        <div class="field" style="margin:0;min-width:120px;"><label for="layoutPatternInput">Pattern Formula</label>
          <input id="layoutPatternInput" value="${esc(currentPattern)}" placeholder="e.g. 2+1, 1+2, 1+1+1">
        </div>
        <div class="field" style="margin:0;min-width:80px;"><label for="layoutRows">Rows</label>
          <input id="layoutRows" type="number" min="1" max="20" value="${rowsCount()}">
        </div>
        <div class="field" style="margin:0;min-width:140px;"><label for="layoutNumbering">Numbering</label>
          <select id="layoutNumbering">
            <option value="row-letter">Row Letters (1A, 1B)</option>
            <option value="seq">Sequential (1, 2, 3...)</option>
            <option value="letter-row">Letter First (A1, A2)</option>
            <option value="sleeper">Berths (S1, S2...)</option>
          </select>
        </div>
        <div class="field" style="margin:0;display:flex;align-items:center;padding-bottom:8px;">
          <label class="checkline" style="font-size:12px;cursor:pointer;"><input type="checkbox" id="layoutRearBench"> Rear Bench</label>
        </div>
        <button type="button" class="btn btn-primary" id="rebuildLayout" style="white-space:nowrap;">⚡ Generate Layout</button>
      </div>

      <div class="layout-actions-bar">
        <button type="button" class="btn btn-secondary btn-sm" id="btnLayoutAddRow">+ Add Row (Rear)</button>
        <button type="button" class="btn btn-secondary btn-sm" id="btnLayoutAddCol">+ Add Column (Right)</button>
        <button type="button" class="btn btn-secondary btn-sm" id="btnLayoutDelCol">- Column (Right)</button>
        <button type="button" class="btn btn-secondary btn-sm" id="btnLayoutFlip">↔️ Flip Left/Right</button>
        <button type="button" class="btn btn-secondary btn-sm" id="btnLayoutRenumber">🔄 Auto Re-number</button>
        <button type="button" class="btn btn-secondary btn-sm" id="btnLayoutClearAisles">🗑️ Clear to Aisles</button>
        <button type="button" class="btn btn-secondary btn-sm" id="btnLayoutFillSeats">💺 Fill All Seats</button>
      </div>

      <div class="layout-meta-bar" id="layoutMetaBar">
        <div class="layout-badges" id="layoutBadges"></div>
        <div id="layoutAlert" class="layout-alert hidden"></div>
      </div>

      <div class="layout-bus" id="layoutPreview"></div>
      <p class="form-hint" style="margin-top:10px;">
        💡 <b>Click seat</b> to edit label or presets · <b>Shift+Click or Right-Click</b> seat to make aisle · <b>Click (+)</b> to add seat · <b>×</b> on row to delete row.
      </p>`,
    onSubmit: async () => {
      const seatsCount = countSeats(layoutDraft);
      if (seatsCount < 1) throw new Error('Layout must contain at least one seat.');
      const dupes = findDuplicateSeatLabels(layoutDraft);
      if (dupes.length > 0) {
        throw new Error(`Duplicate seat label(s) detected: ${dupes.join(', ')}. Use Auto Re-number or rename duplicates.`);
      }
      const patternVal = (document.getElementById('layoutPatternInput')?.value || currentPattern).trim() || 'custom';
      await api('/buses/' + bus.id, {
        method: 'PATCH',
        body: JSON.stringify({ name: bus.name, pattern: patternVal, layout: layoutDraft, active: !!bus.active }),
      });
      toast('Custom seat layout saved successfully');
      await loadCaches();
      nav('#/admin/buses');
    },
  });

  const patternInput = document.getElementById('layoutPatternInput');
  const presetSelect = document.getElementById('layoutPreset');
  const numberingSelect = document.getElementById('layoutNumbering');
  const rearBenchCheck = document.getElementById('layoutRearBench');

  // Match preset select initial value
  if (['2+2', '2+1', '1+2', '1+1', '3+2', '2+3', '1+1+1', '2+2+1'].includes(currentPattern)) {
    presetSelect.value = currentPattern;
  } else {
    presetSelect.value = 'custom';
  }

  presetSelect.onchange = () => {
    if (presetSelect.value !== 'custom') {
      patternInput.value = presetSelect.value;
    }
  };

  patternInput.oninput = () => {
    const val = patternInput.value.trim();
    if (['2+2', '2+1', '1+2', '1+1', '3+2', '2+3', '1+1+1', '2+2+1'].includes(val)) {
      presetSelect.value = val;
    } else {
      presetSelect.value = 'custom';
    }
  };

  const renderPreview = () => {
    const wrap = document.getElementById('layoutPreview');
    const badgesWrap = document.getElementById('layoutBadges');
    const alertEl = document.getElementById('layoutAlert');
    if (!wrap) return;

    const dupes = findDuplicateSeatLabels(layoutDraft);
    const dupeSet = new Set(dupes);

    if (dupes.length > 0) {
      alertEl.innerHTML = `⚠️ Duplicate seats: <b>${esc(dupes.slice(0, 4).join(', '))}${dupes.length > 4 ? '…' : ''}</b>`;
      alertEl.classList.remove('hidden');
    } else {
      alertEl.classList.add('hidden');
    }

    const currentSeats = countSeats(layoutDraft);
    const currentRows = layoutDraft.length;
    const currentWidth = layoutWidth(layoutDraft);
    badgesWrap.innerHTML = `
      <span class="layout-badge">💺 ${currentSeats} Seats</span>
      <span class="layout-badge">📐 ${currentRows} Rows × ${currentWidth} Cols</span>
      <span class="layout-badge">🚌 ${esc(patternInput.value || 'Custom')}</span>
    `;
    document.getElementById('layoutRows').value = currentRows;

    const rowsHtml = layoutDraft.map((row, ri) => {
      const cells = row.map((lab, ci) => {
        if (lab == null || lab === '') {
          return `<button type="button" class="layout-cell layout-aisle" data-r="${ri}" data-c="${ci}" title="Click to add seat">+</button>`;
        }
        const isDupe = dupeSet.has(String(lab).trim());
        return `<button type="button" class="layout-cell layout-seat ${isDupe ? 'seat-dupe' : ''}" data-r="${ri}" data-c="${ci}" title="Seat ${esc(lab)}: Click to customize, Shift+Click to make aisle">${esc(lab)}</button>`;
      }).join('');
      return `
        <div class="layout-row">
          <span class="layout-row-label">R${ri + 1}</span>
          <div class="layout-row-seats">${cells}</div>
          <div class="layout-row-actions">
            <button type="button" class="layout-row-del" data-del-row="${ri}" title="Remove row ${ri + 1}">×</button>
          </div>
        </div>`;
    }).join('');

    wrap.innerHTML = `
      <div class="layout-bus-front">
        <div class="front-feature">🚪 Passenger Entrance</div>
        <div style="font-size:12px;font-weight:700;">FRONT / CABIN</div>
        <div class="front-feature">🛞 Driver Cabin</div>
      </div>
      <div class="layout-rows-container">${rowsHtml}</div>
      <div class="layout-rear">🚌 BUS REAR / BUMPER</div>
    `;

    // Seat / Aisle Click Handlers
    wrap.querySelectorAll('.layout-cell').forEach((el) => {
      const r = Number(el.getAttribute('data-r'));
      const c = Number(el.getAttribute('data-c'));

      el.onclick = (e) => {
        e.preventDefault();
        const isAisle = layoutDraft[r][c] == null || layoutDraft[r][c] === '';

        if (isAisle) {
          // Add seat with smart auto-label
          const style = numberingSelect.value;
          let seatInRow = 0;
          for (let i = 0; i <= c; i++) {
            if (layoutDraft[r][i] != null && layoutDraft[r][i] !== '') seatInRow++;
          }
          let newLab = '';
          if (style === 'seq') {
            newLab = String(countSeats(layoutDraft) + 1);
          } else if (style === 'letter-row') {
            newLab = String.fromCharCode(65 + seatInRow) + (r + 1);
          } else if (style === 'sleeper') {
            newLab = 'S' + (countSeats(layoutDraft) + 1);
          } else {
            newLab = (r + 1) + String.fromCharCode(65 + seatInRow);
          }
          layoutDraft[r][c] = newLab;
          renderPreview();
        } else {
          // If shift or alt key held, quick toggle to aisle!
          if (e.shiftKey || e.altKey) {
            layoutDraft[r][c] = null;
            renderPreview();
            return;
          }
          // Otherwise open rich seat editor
          openSeatEditorModal(
            r,
            c,
            layoutDraft[r][c],
            (newLabel) => {
              layoutDraft[r][c] = newLabel;
              renderPreview();
            },
            () => {
              layoutDraft[r][c] = null;
              renderPreview();
            }
          );
        }
      };

      // Right-click quick toggle to aisle
      el.oncontextmenu = (e) => {
        e.preventDefault();
        if (layoutDraft[r][c] != null && layoutDraft[r][c] !== '') {
          layoutDraft[r][c] = null;
          renderPreview();
        }
      };

      // Double-click quick prompt
      el.ondblclick = (e) => {
        e.preventDefault();
        if (layoutDraft[r][c] == null || layoutDraft[r][c] === '') return;
        const next = prompt('Edit Seat Label:', layoutDraft[r][c]);
        if (next && next.trim()) {
          layoutDraft[r][c] = next.trim();
          renderPreview();
        }
      };
    });

    // Delete row buttons
    wrap.querySelectorAll('[data-del-row]').forEach((btn) => {
      btn.onclick = () => {
        if (layoutDraft.length <= 1) { toast('Bus must have at least one row'); return; }
        const ri = Number(btn.getAttribute('data-del-row'));
        layoutDraft.splice(ri, 1);
        renderPreview();
      };
    });
  };

  renderPreview();

  // Generator Action
  document.getElementById('rebuildLayout').onclick = () => {
    const rows = Number(document.getElementById('layoutRows').value) || 5;
    const pat = patternInput.value.trim() || '2+2';
    const rearBench = rearBenchCheck.checked;
    const numbering = numberingSelect.value;
    if (rows < 1 || rows > 20) { toast('Rows must be 1–20'); return; }
    currentPattern = pat;
    layoutDraft = defaultLayout(rows, pat, { rearBench, numbering });
    renderPreview();
    toast(`Layout generated from pattern ${pat}`);
  };

  // Add Row
  document.getElementById('btnLayoutAddRow').onclick = () => {
    if (layoutDraft.length >= 20) { toast('Maximum 20 rows reached'); return; }
    const cols = layoutWidth(layoutDraft);
    const newRow = [];
    const rIdx = layoutDraft.length + 1;
    // Clone pattern of previous row if exists
    if (layoutDraft.length > 0) {
      const prev = layoutDraft[layoutDraft.length - 1];
      let seatInRow = 0;
      for (let ci = 0; ci < prev.length; ci++) {
        if (prev[ci] != null && prev[ci] !== '') {
          newRow.push(rIdx + String.fromCharCode(65 + seatInRow));
          seatInRow++;
        } else {
          newRow.push(null);
        }
      }
    } else {
      for (let i = 0; i < cols; i++) newRow.push(rIdx + String.fromCharCode(65 + i));
    }
    layoutDraft.push(newRow);
    renderPreview();
    toast('Row added at rear');
  };

  // Add Column
  document.getElementById('btnLayoutAddCol').onclick = () => {
    const cols = layoutWidth(layoutDraft);
    if (cols >= 12) { toast('Maximum 12 columns reached'); return; }
    layoutDraft.forEach((row) => row.push(null));
    renderPreview();
    toast('Aisle column added to right');
  };

  // Remove Column
  document.getElementById('btnLayoutDelCol').onclick = () => {
    const cols = layoutWidth(layoutDraft);
    if (cols <= 1) { toast('Need at least 1 column'); return; }
    const hasSeatsInLastCol = layoutDraft.some((row) => row.length === cols && row[cols - 1] != null && row[cols - 1] !== '');
    if (hasSeatsInLastCol && !confirm('Rightmost column contains seats. Remove column anyway?')) return;
    layoutDraft.forEach((row) => { if (row.length === cols) row.pop(); });
    renderPreview();
    toast('Column removed');
  };

  // Flip Left/Right
  document.getElementById('btnLayoutFlip').onclick = () => {
    layoutDraft.forEach((row) => row.reverse());
    renderPreview();
    toast('Layout flipped horizontally');
  };

  // Auto Re-number
  document.getElementById('btnLayoutRenumber').onclick = () => {
    const style = numberingSelect.value;
    layoutDraft = renumberLayout(layoutDraft, style);
    renderPreview();
    toast(`Seats re-numbered cleanly (${style})`);
  };

  // Clear to Aisles
  document.getElementById('btnLayoutClearAisles').onclick = () => {
    if (!confirm('Turn all seats into aisles?')) return;
    layoutDraft = layoutDraft.map((row) => row.map(() => null));
    renderPreview();
    toast('All seats cleared to aisles');
  };

  // Fill All Seats
  document.getElementById('btnLayoutFillSeats').onclick = () => {
    const style = numberingSelect.value;
    let seq = 1;
    layoutDraft = layoutDraft.map((row, ri) => {
      return row.map((cell, ci) => {
        if (style === 'seq') return String(seq++);
        if (style === 'letter-row') return String.fromCharCode(65 + ci) + (ri + 1);
        if (style === 'sleeper') return 'S' + (seq++);
        return (ri + 1) + String.fromCharCode(65 + ci);
      });
    });
    renderPreview();
    toast('All cells filled with seats');
  };
}

/* ---------- Admin: Routes & Trips ---------- */
function adminRoutesTripsView() {
  const tab = adminCtx.tab;
  return `
  <h1 class="page-title">Manage Routes &amp; Trips</h1>
  <p class="page-sub">Create routes with fare, schedule trips, or delete unused routes.</p>
  <div class="tabbar">
    <button class="tabbtn ${tab === 'routes' ? 'active' : ''}" data-tab="routes">Routes</button>
    <button class="tabbtn ${tab === 'trips' ? 'active' : ''}" data-tab="trips">Trips</button>
  </div>
  ${tab === 'routes' ? adminRoutesPanel() : adminTripsPanel()}`;
}

function adminRoutesPanel() {
  const rows = Cache.routes.map((r) => `
    <tr>
      <td>${esc(r.name)}</td>
      <td>${esc(r.source)} → ${esc(r.destination)}</td>
      <td>${fmtMoney(r.fare)}</td>
      <td>${statusPill(r.active)}</td>
      <td>
        <button class="btn btn-secondary btn-sm" data-edit-route="${r.id}">Edit</button>
        <button class="btn btn-danger btn-sm" data-del-route="${r.id}">Delete</button>
      </td>
    </tr>`).join('') || `<tr><td colspan="5" class="empty">No routes yet.</td></tr>`;
  return `
  <div class="panel">
    <div class="panel-head">
      <h3>Routes</h3>
      <button class="btn btn-primary" id="addRouteBtn">Add Route</button>
    </div>
    <div style="overflow-x:auto;"><table>
      <thead><tr><th>Name</th><th>Path</th><th>Fare</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`;
}

function adminTripsPanel() {
  const trips = adminCtx.trips || [];
  const rows = trips.map((t) => `
    <tr>
      <td>${esc(t.time)}</td>
      <td>${esc(t.route_name)}</td>
      <td>${esc(t.bus_name)}</td>
      <td>${t.bookedSeats}/${t.totalSeats}</td>
      <td>${fmtMoney(t.fare)}</td>
      <td>${tripStatusPill(t.status)}</td>
      <td>
        ${t.status === 'Planned' ? `<button class="btn btn-secondary btn-sm" data-trip-status="${t.id}|In-Transit" title="Start trip">Start</button> ` : ''}
        ${t.status === 'In-Transit' ? `<button class="btn btn-secondary btn-sm" data-trip-status="${t.id}|Completed" title="Mark trip completed">Complete</button> ` : ''}
        ${(t.status === 'Planned' || t.status === 'In-Transit')
      ? `<button class="btn btn-danger btn-sm" data-cancel-trip="${t.id}">Cancel</button> `
      : ''}
        <button class="btn btn-danger btn-sm" data-del-trip="${t.id}">Delete</button>
      </td>
    </tr>`).join('') || `<tr><td colspan="7" class="empty">No trips for this date.</td></tr>`;
  return `
  <div class="panel">
    <div class="panel-head">
      <h3>Trips</h3>
      <button class="btn btn-primary" id="addTripBtn">Schedule Trip</button>
    </div>
    <div class="formrow" style="margin-bottom:16px;">
      <div class="field"><label for="adminTripDate">Date</label><input id="adminTripDate" type="date" value="${adminCtx.tripDate}"></div>
      <button class="btn btn-secondary" id="reloadTripsBtn">Refresh</button>
    </div>
    <div style="overflow-x:auto;"><table>
      <thead><tr><th>Time</th><th>Route</th><th>Bus</th><th>Booked</th><th>Fare</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`;
}

async function loadAdminTrips() {
  const qs = new URLSearchParams({ date: adminCtx.tripDate });
  try { adminCtx.trips = await api('/trips?' + qs.toString()); }
  catch { adminCtx.trips = []; }
  adminCtx.tripsLoaded = true;
}

async function attachAdminRoutesTrips() {
  document.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.onclick = async () => {
      adminCtx.tab = btn.getAttribute('data-tab');
      if (adminCtx.tab === 'trips' && !adminCtx.tripsLoaded) await loadAdminTrips();
      nav('#/admin/routes-trips');
    };
  });

  if (adminCtx.tab === 'routes') {
    document.getElementById('addRouteBtn').onclick = () => openRouteForm(null);
    document.querySelectorAll('[data-edit-route]').forEach((btn) => {
      btn.onclick = () => {
        const route = Cache.routes.find((r) => String(r.id) === btn.getAttribute('data-edit-route'));
        if (route) openRouteForm(route);
      };
    });
    document.querySelectorAll('[data-del-route]').forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.getAttribute('data-del-route');
        if (!confirm('Delete this route? If it has trips, you will be asked to force-delete them too.')) return;
        btn.disabled = true;
        try {
          await api('/routes/' + id, { method: 'DELETE' });
          toast('Route deleted');
          await loadCaches();
          nav('#/admin/routes-trips');
        } catch (err) {
          if (err.status === 409 && err.data && err.data.needsForce) {
            if (confirm(err.message + '\n\nForce delete route, trips, and bookings?')) {
              try {
                await api('/routes/' + id + '?force=1', { method: 'DELETE' });
                toast('Route force-deleted');
                await loadCaches();
                adminCtx.tripsLoaded = false;
                nav('#/admin/routes-trips');
                return;
              } catch (e2) { toast(e2.message); }
            }
          } else {
            toast(err.message);
          }
          btn.disabled = false;
        }
      };
    });
    return;
  }

  if (!adminCtx.tripsLoaded) {
    await loadAdminTrips();
    nav('#/admin/routes-trips');
    return;
  }

  document.getElementById('addTripBtn').onclick = () => openTripForm();
  document.getElementById('reloadTripsBtn').onclick = async () => {
    await loadAdminTrips();
    nav('#/admin/routes-trips');
    toast('Trips refreshed');
  };
  document.getElementById('adminTripDate').onchange = async (e) => {
    adminCtx.tripDate = e.target.value;
    await loadAdminTrips();
    nav('#/admin/routes-trips');
  };
  document.querySelectorAll('[data-trip-status]').forEach((btn) => {
    btn.onclick = async () => {
      const [id, nextStatus] = btn.getAttribute('data-trip-status').split('|');
      btn.disabled = true;
      try {
        await api('/trips/' + id + '/status', { method: 'PATCH', body: JSON.stringify({ status: nextStatus }) });
        toast(`Trip marked as ${nextStatus}`);
        await loadAdminTrips();
        dashboardCtx.loaded = false;
        nav('#/admin/routes-trips');
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
      }
    };
  });

  document.querySelectorAll('[data-cancel-trip]').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm('Cancel this trip? Agents will no longer be able to book seats on it.')) return;
      btn.disabled = true;
      try {
        await api('/trips/' + btn.getAttribute('data-cancel-trip') + '/cancel', { method: 'PATCH' });
        toast('Trip cancelled');
        await loadAdminTrips();
        dashboardCtx.loaded = false;
        nav('#/admin/routes-trips');
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
      }
    };
  });
  document.querySelectorAll('[data-del-trip]').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.getAttribute('data-del-trip');
      if (!confirm('Delete this trip permanently?')) return;
      btn.disabled = true;
      try {
        await api('/trips/' + id, { method: 'DELETE' });
        toast('Trip deleted');
        await loadAdminTrips();
        nav('#/admin/routes-trips');
      } catch (err) {
        if (err.status === 409 && err.data && err.data.needsForce) {
          if (confirm(err.message + '\n\nForce delete trip and all its bookings?')) {
            try {
              await api('/trips/' + id + '?force=1', { method: 'DELETE' });
              toast('Trip force-deleted');
              await loadAdminTrips();
              nav('#/admin/routes-trips');
              return;
            } catch (e2) { toast(e2.message); }
          }
        } else {
          toast(err.message);
        }
        btn.disabled = false;
      }
    };
  });
}

function openRouteForm(route) {
  const isEdit = !!route;
  let pickupsDisplay = '';
  if (route && route.pickup_points) {
    try {
      const parsed = JSON.parse(route.pickup_points);
      pickupsDisplay = Array.isArray(parsed) ? parsed.join(', ') : route.pickup_points;
    } catch {
      pickupsDisplay = route.pickup_points;
    }
  }

  openFormModal({
    title: isEdit ? 'Edit Route' : 'Add Route',
    submitLabel: isEdit ? 'Save Changes' : 'Create Route',
    bodyHtml: `
      <div class="field"><label for="routeName">Route Name</label><input id="routeName" required value="${route ? esc(route.name) : ''}" placeholder="e.g., Temple A → Town B"></div>
      <div class="formrow" style="margin-bottom:14px;">
        <div class="field"><label for="routeSource">Source</label><input id="routeSource" required value="${route ? esc(route.source) : ''}" placeholder="From"></div>
        <div class="field"><label for="routeDest">Destination</label><input id="routeDest" required value="${route ? esc(route.destination) : ''}" placeholder="To"></div>
      </div>
      <div class="field"><label for="routeFare">Fare per seat (₹)</label><input id="routeFare" type="number" min="0" step="1" required value="${route ? Number(route.fare || 0) : 150}"></div>
      <div class="field"><label for="routePickups">Boarding / Pick-up Stops (Optional, comma-separated)</label>
        <input id="routePickups" value="${esc(pickupsDisplay)}" placeholder="e.g., Gate 2 Metro - 6:00 AM, Mor Chowk - 6:15 AM">
      </div>
      ${isEdit ? `<label class="checkline"><input type="checkbox" id="routeActive" ${route.active ? 'checked' : ''}> Active</label>` : ''}`,
    onSubmit: async () => {
      const name = document.getElementById('routeName').value.trim();
      const source = document.getElementById('routeSource').value.trim();
      const destination = document.getElementById('routeDest').value.trim();
      const fare = Number(document.getElementById('routeFare').value);
      const pickupsRaw = document.getElementById('routePickups').value.trim();
      const pickupPoints = pickupsRaw ? pickupsRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];

      if (!name || !source || !destination) throw new Error('All fields are required.');
      if (Number.isNaN(fare) || fare < 0) throw new Error('Enter a valid fare.');
      const payload = { name, source, destination, fare, pickupPoints };
      if (isEdit) {
        payload.active = document.getElementById('routeActive').checked;
        await api('/routes/' + route.id, { method: 'PATCH', body: JSON.stringify(payload) });
        toast('Route updated');
      } else {
        await api('/routes', { method: 'POST', body: JSON.stringify(payload) });
        toast('Route created');
      }
      await loadCaches();
      adminCtx.tab = 'routes';
      nav('#/admin/routes-trips');
    },
  });
}

function openTripForm() {
  const routeOpts = Cache.routes.filter((r) => r.active).map((r) => `<option value="${r.id}">${esc(r.name)} (${fmtMoney(r.fare)})</option>`).join('');
  const busOpts = Cache.buses.filter((b) => b.active).map((b) => `<option value="${b.id}">${esc(b.name)} (${b.seatCount || b.cols} seats)</option>`).join('');
  if (!routeOpts || !busOpts) {
    toast('Add at least one active route and bus first');
    return;
  }
  openFormModal({
    title: 'Schedule Trip',
    submitLabel: 'Create Trip',
    bodyHtml: `
      <div class="field"><label for="tripRoute">Route</label><select id="tripRoute" required><option value="">Select route</option>${routeOpts}</select></div>
      <div class="field"><label for="tripBus">Bus</label><select id="tripBus" required><option value="">Select bus</option>${busOpts}</select></div>
      <div class="formrow" style="margin-bottom:0;">
        <div class="field"><label for="tripDate">Date</label><input id="tripDate" type="date" required value="${adminCtx.tripDate || todayStr()}"></div>
        <div class="field"><label for="tripTime">Departure Time</label><input id="tripTime" type="time" required value="06:00"></div>
      </div>`,
    onSubmit: async () => {
      const routeId = document.getElementById('tripRoute').value;
      const busId = document.getElementById('tripBus').value;
      const date = document.getElementById('tripDate').value;
      const time = document.getElementById('tripTime').value;
      if (!routeId || !busId || !date || !time) throw new Error('All fields are required.');
      await api('/trips', { method: 'POST', body: JSON.stringify({ routeId: Number(routeId), busId: Number(busId), date, time }) });
      toast('Trip scheduled');
      adminCtx.tab = 'trips';
      adminCtx.tripDate = date;
      adminCtx.tripsLoaded = false;
      await loadAdminTrips();
      nav('#/admin/routes-trips');
    },
  });
}

/* ---------- Admin: Users ---------- */
function adminUsersView() {
  const rows = (usersCache || []).map((u) => `
    <tr>
      <td>${esc(u.name)}</td>
      <td>${esc(u.username)}</td>
      <td><span class="pill ${u.role === 'Admin' ? 'pill-err' : u.role === 'Supervisor' ? 'pill-warn' : 'pill-ok'}">${esc(u.role)}</span></td>
      <td>
        <button class="btn btn-secondary btn-sm" data-edit-user="${u.id}">Edit</button>
        ${String(u.id) !== String(state.user.id) ? `<button class="btn btn-danger btn-sm" data-del-user="${u.id}">Delete</button>` : ''}
      </td>
    </tr>`).join('') || `<tr><td colspan="4" class="empty">No users loaded.</td></tr>`;
  return `
  <h1 class="page-title">Manage Users</h1>
  <p class="page-sub">Create staff accounts from the panel — Admin, Agent, or Supervisor.</p>
  <div class="panel">
    <div class="panel-head">
      <h3>Users</h3>
      <button class="btn btn-primary" id="addUserBtn">Add User</button>
    </div>
    <div style="overflow-x:auto;"><table>
      <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Actions</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`;
}

async function loadUsers() {
  usersCache = await api('/users');
}

async function attachAdminUsers() {
  if (!adminCtx.usersLoaded) {
    try {
      await loadUsers();
      adminCtx.usersLoaded = true;
      nav('#/admin/users');
      return;
    } catch (err) { toast(err.message); return; }
  }
  document.getElementById('addUserBtn').onclick = () => openUserForm(null);
  document.querySelectorAll('[data-edit-user]').forEach((btn) => {
    btn.onclick = () => {
      const user = usersCache.find((u) => String(u.id) === btn.getAttribute('data-edit-user'));
      if (user) openUserForm(user);
    };
  });
  document.querySelectorAll('[data-del-user]').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm('Delete this user? They will no longer be able to log in.')) return;
      btn.disabled = true;
      try {
        await api('/users/' + btn.getAttribute('data-del-user'), { method: 'DELETE' });
        toast('User deleted');
        await loadUsers();
        nav('#/admin/users');
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
      }
    };
  });
}

function openUserForm(user) {
  const isEdit = !!user;
  openFormModal({
    title: isEdit ? 'Edit User' : 'Add User',
    submitLabel: isEdit ? 'Save Changes' : 'Create User',
    bodyHtml: `
      <div class="field"><label>Full name</label><input id="userName" required value="${user ? esc(user.name) : ''}" placeholder="e.g., A. Sharma"></div>
      <div class="field"><label>Username</label><input id="userUsername" required value="${user ? esc(user.username) : ''}" placeholder="login id" ${isEdit ? 'disabled' : ''}></div>
      <div class="field"><label>Role</label>
        <select id="userRole">
          <option value="Agent" ${!user || user.role === 'Agent' ? 'selected' : ''}>Agent — booking + manifest</option>
          <option value="Supervisor" ${user && user.role === 'Supervisor' ? 'selected' : ''}>Supervisor — manifest + payments</option>
          <option value="Admin" ${user && user.role === 'Admin' ? 'selected' : ''}>Admin — full access</option>
        </select>
      </div>
      <div class="field"><label>${isEdit ? 'New password (leave blank to keep)' : 'Password'}</label>
        <input id="userPassword" type="password" ${isEdit ? '' : 'required'} placeholder="min 4 characters"></div>`,
    onSubmit: async () => {
      const name = document.getElementById('userName').value.trim();
      const username = document.getElementById('userUsername').value.trim();
      const role = document.getElementById('userRole').value;
      const password = document.getElementById('userPassword').value;
      if (!name || !username) throw new Error('Name and username are required.');
      if (isEdit) {
        const payload = { name, role };
        if (password) payload.password = password;
        const updated = await api('/users/' + user.id, { method: 'PATCH', body: JSON.stringify(payload) });
        if (state.user && String(state.user.id) === String(user.id)) {
          state.user.name = updated.name;
          state.user.role = updated.role;
          renderNav();
        }
        toast('User updated');
      } else {
        if (!password || password.length < 4) throw new Error('Password must be at least 4 characters.');
        await api('/users', { method: 'POST', body: JSON.stringify({ name, username, role, password }) });
        toast('User created');
      }
      await loadUsers();
      nav('#/admin/users');
    },
  });
}

/* ---------- Bootstrap ---------- */
(async function init() {
  const token = getToken();
  if (token) {
    try {
      const { user } = await api('/me');
      state.user = user;
      resetInactivityTimer();
      await loadCaches();
      const initialRoute = window.location.hash || '#/dashboard';
      nav(initialRoute, false);
      return;
    } catch { clearToken(); }
  }
  state.route = '#/login';
  render();
})();

window.addEventListener('hashchange', () => {
  const h = window.location.hash || '#/dashboard';
  if (state.user && state.route !== h) {
    nav(h, false);
  }
});

/* ---------- Mobile PWA & Service Worker ---------- */
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  showPwaBanner();
});

function showPwaBanner() {
  if (document.getElementById('pwaBanner') || !deferredInstallPrompt) return;
  const banner = document.createElement('div');
  banner.id = 'pwaBanner';
  banner.className = 'pwa-banner no-print';
  banner.innerHTML = `
    <div class="pwa-banner-text">
      <img src="/icon.svg" class="pwa-banner-icon" alt="Seva App">
      <div><b>Install Seva Mobile App</b><div style="font-size:11px;opacity:0.8;">One-tap access on your home screen</div></div>
    </div>
    <div class="pwa-banner-actions">
      <button class="pwa-install-btn" id="pwaInstallBtn">Install</button>
      <button class="pwa-close-btn" id="pwaCloseBtn" title="Dismiss">×</button>
    </div>
  `;
  document.body.appendChild(banner);
  document.getElementById('pwaInstallBtn').onclick = triggerAppInstall;
  document.getElementById('pwaCloseBtn').onclick = () => banner.remove();
}

async function triggerAppInstall() {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    if (outcome === 'accepted') {
      const banner = document.getElementById('pwaBanner');
      if (banner) banner.remove();
    }
    deferredInstallPrompt = null;
  } else {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    if (isIOS) {
      alert("To install on iPhone/iPad:\n1. Tap the Share button (box with arrow)\n2. Select 'Add to Home Screen' ➕");
    } else {
      toast("To install on phone: Open in Chrome, tap (⋮) Menu and choose 'Install App' or 'Add to Home screen'");
    }
  }
}

if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.log('SW registration error:', err));
  });
}
