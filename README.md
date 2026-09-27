# Seva Bus Booking

A production-grade, internal bus seva booking and fleet management web application: staff authentication, live dashboard analytics, interactive seat-map booking with passenger details, global PNR/phone search, printable boarding passes, CSV and printable manifests, booking cancellation & seat release, trip lifecycle control, and automated SQLite backups.

Node.js/Express API backed by SQLite (`better-sqlite3`), with a zero-build HTML/CSS/JS frontend (no bundler, no framework dependencies).

---

## Tech Stack

- **Backend:** Node.js, Express, SQLite (`better-sqlite3` with WAL mode & foreign keys), JWT auth (`jsonwebtoken`), password hashing (`bcryptjs`), rate limiting (`express-rate-limit`).
- **Frontend:** Responsive Vanilla HTML5/CSS3/ES6, hash-based SPA router with full browser history support (`location.hash` & `hashchange`), zero build step.
- **Database:** Single SQLite database file (`data/seva.db`), auto-created, auto-migrated, and seeded on first run.

---

## Getting Started Locally

Requires Node.js 18+.

```bash
# 1. Install dependencies
npm install

# 2. Configure environment variables
cp .env.example .env
# Edit JWT_SECRET in .env to a long, random secret key

# 3. Start the server
npm start
```

Open **http://localhost:4000** in your browser. The database and demo accounts are created and seeded automatically.

### Demo Credentials

| Username | Password | Role | Permissions |
|---|---|---|---|
| `admin` | `admin` | **Admin** | Full access: buses, seat layouts, routes, trips, bookings, manifests, payments, user management, and DB backups |
| `agent` | `agent` | **Agent** | Trip search, seat-map booking, boarding passes, view manifest, and cancel own bookings |
| `supervisor` | `supervisor` | **Supervisor** | View manifests, update cash/partial/full payments, search PNRs, and cancel bookings |

> **Security Reminder:** Always change default passwords and set a unique `JWT_SECRET` in `.env` before public or production deployment.

---

## Features Implemented

### 1. Live Dashboard Metrics
- **Scheduled Trips Today:** Total trips count with status breakdown (`Planned`, `In-Transit`, `Completed`, `Cancelled`).
- **Real-Time Occupancy:** Booked seats vs. total bus capacity with visual occupancy percentage.
- **Revenue & Collections:** Cash collected today, pending dues for today's departures, and total outstanding balances across active trips.
- **Quick Lookup:** Instant passenger/PNR lookup directly from the dashboard.
- **Recent Bookings Feed:** Real-time list of latest bookings with one-click Boarding Pass view and Cancellation.

### 2. Global PNR / Phone / Passenger Search (`#/search`)
- Search by **PNR** (e.g. `PNR360688`), **10-digit mobile number**, or **passenger name**.
- Displays full booking card with route, bus, departure time, trip status, and per-seat passenger list.
- Quick actions: **Print Boarding Pass**, **Update Payment** (Admin/Supervisor), and **Cancel Booking**.
- Includes a permanent **Cancelled Bookings Audit Log** displaying who cancelled, timestamps, seats freed, and refund notes.

### 3. Booking Cancellation & Instant Seat Release
- **Full Booking Cancellation:** Cancels the booking, releases all assigned seats back to the seat map instantly, logs the action to `cancelled_bookings`, and removes the reservation from the manifest.
- **Single Seat Release:** In multi-seat bookings, cancel an individual seat while automatically recalculating total fare, adjusting amount paid/due, and updating payment status.
- Available from the **Search View**, **Manifest View**, and **Dashboard**.

### 4. Printable Passenger Boarding Pass / E-Ticket
- Clean boarding pass layout with PNR barcode box, trip details, departure time, seat list, passenger info, and dynamic payment stamp (`PAID`, `PARTIAL`, `UNPAID`).
- One-click printing via `window.print()` with `@media print` styling.

### 5. Manifest with CSV Export & Printing
- **Live Seat Map:** Visual seat map with hover tooltips showing passenger name, age, phone, and booking staff.
- **Filter & Grouping:** Group passengers by the agent who booked them or filter by specific staff.
- **Export CSV:** One-click download of the complete passenger manifest formatted for Excel and offline drivers.
- **Payment Controls:** Instant one-click toggle between `Unpaid`, `Half Advance`, and `Full Paid`.

### 6. Trip Status Lifecycle (`Planned` → `In-Transit` → `Completed`)
- Admins can manage trip stages:
  - **Start Trip:** Changes status to `In-Transit`.
  - **Complete Trip:** Marks trip as `Completed` once the bus arrives.
  - **Cancel Trip:** Closes trip for any further bookings.
- Color-coded status badges across all views.

### 7. Database Online Backup
- Run automated backups via CLI:
  ```bash
  npm run backup
  ```
  Creates a timestamped snapshot in `data/backups/seva-backup-YYYYMMDD_HHmmss.db` using SQLite's online backup API without locking active connections.
- Admins can also trigger instant backups from the web UI with a single click.

### 8. Security & URL Routing
- **Rate Limiting:** `express-rate-limit` enabled on `/api/auth/login` to thwart password brute-force attempts.
- **Browser History & Hash Routing:** Seamless navigation with browser Back/Forward support and bookmarkable URL routes.
- **DB-Level Concurrency:** `UNIQUE(trip_id, seat_label)` prevents race-condition double-booking.

### 9. Custom Seat Layout & Pattern Generator (`Manage Buses & Layouts`)
- **Arbitrary Custom Patterns:** Generate any seating arrangement via formula:
  - Standard Presets: `2+2`, `2+1`, `1+2`, `1+1` (VIP), `3+2`, `2+3`, `1+1+1` (Sleeper/Pod), `2+2+1` (Double Aisle).
  - Custom Pattern input: type any formula (e.g. `1+2`, `1+1+1`, `3+1`) where numbers represent seats and `+` represents an aisle.
- **Full Rear Bench:** Option to generate a continuous last row without aisle gaps (standard 5/6-seater rear bench).
- **Seat Numbering Schemes:** Choose between **Row Letters** (`1A, 1B...`), **Sequential Numbers** (`1, 2, 3...`), **Letter First** (`A1, A2, B1...`), or **Berths** (`S1, S2, S3...`).
- **Visual Bus Cabin Editor:**
  - Front cabin header featuring **Driver Cabin** (`🛞`) and **Passenger Entrance** (`🚪`).
  - Click any aisle (`+`) to instantly create a seat with auto-calculated label.
  - Click any seat to open the **Customize Seat Modal** with quick presets (`VIP`, `Guide`, `Driver`, `Ladies`, `D1`, `Staff`) or custom code rename.
  - Shift-click or right-click any seat to quickly convert it into an aisle.
- **Grid Layout Tools:**
  - `+ Add Row (Rear)`: Appends an extra row matching bus pattern.
  - `+ Add Column (Right)` / `- Column (Right)`: Dynamically expand bus width up to 12 columns.
  - `↔️ Flip Left/Right`: Instantly mirror layout horizontally (swaps left and right aisles/seats).
  - `🔄 Auto Re-number`: Automatically re-sequences all non-empty seats cleanly without numbering gaps.
  - `🗑️ Clear to Aisles` / `💺 Fill All Seats`: Fast bulk resets.
- **Live Validation & Duplication Detection:** Displays real-time seats count, grid dimensions, and highlights duplicate seat labels with alert warnings before saving.

---

## API Reference

All endpoints except `/api/auth/login` require `Authorization: Bearer <token>`.

| Method | Path | Role | Description |
|---|---|---|---|
| `POST` | `/api/auth/login` | Public | Rate-limited login: `{username, password}` → `{token, user}` |
| `GET` | `/api/me` | Any | Current authenticated user profile |
| `GET` | `/api/dashboard/stats` | Any | Live dashboard metrics (occupancy, trips, collections, recent bookings) |
| `GET` | `/api/bookings/search` | Any | Global search `?q=...` by PNR, phone number, or passenger name |
| `GET` | `/api/routes` | Any | List all routes |
| `POST` | `/api/routes` | Admin | Create route with name, source, destination, fare |
| `PATCH` | `/api/routes/:id` | Admin | Update route details |
| `DELETE` | `/api/routes/:id` | Admin | Delete route (with force-cascade option) |
| `GET` | `/api/buses` | Any | List all buses with layouts and seat counts |
| `POST` | `/api/buses` | Admin | Create bus with pattern (`2+2`, `2+1`, `custom`) |
| `PATCH` | `/api/buses/:id` | Admin | Update bus details and custom layout grid |
| `DELETE` | `/api/buses/:id` | Admin | Delete bus (with force-cascade option) |
| `GET` | `/api/trips` | Any | Filter trips by `?routeId=`, `?date=`, `?status=` |
| `POST` | `/api/trips` | Admin | Schedule trip for a date and departure time |
| `PATCH` | `/api/trips/:id/status` | Admin | Update lifecycle status (`Planned`, `In-Transit`, `Completed`, `Cancelled`) |
| `PATCH` | `/api/trips/:id/cancel` | Admin | Cancel scheduled trip |
| `DELETE` | `/api/trips/:id` | Admin | Delete trip (with force-cascade option) |
| `GET` | `/api/trips/:id/seats` | Any | Seat grid layout and occupied seat map |
| `POST` | `/api/bookings` | Agent, Admin | Create booking: `{tripId, seats, isGroup, groupContact, amountPaid}` |
| `GET` | `/api/bookings` | Any | Get bookings for manifest `?tripId=` |
| `GET` | `/api/bookings/:id` | Any | Get full booking details and passenger seats |
| `PATCH` | `/api/bookings/:id/payment`| Supervisor, Admin | Update payment amount and status |
| `DELETE` | `/api/bookings/:id` | Owner, Supervisor, Admin | Cancel entire booking and release all seats |
| `DELETE` | `/api/bookings/:id/seats/:label` | Owner, Supervisor, Admin | Cancel individual seat and adjust total amount |
| `POST` | `/api/admin/backup` | Admin | Create instant timestamped SQLite backup |
| `GET` | `/api/admin/backups` | Admin | List available database backup files |
| `GET` | `/api/users` | Admin | List all staff user accounts |
| `POST` | `/api/users` | Admin | Create new staff account (`Admin`, `Agent`, `Supervisor`) |
| `PATCH` | `/api/users/:id` | Admin | Update staff account role or password |
| `DELETE` | `/api/users/:id` | Admin | Delete staff account |

---

## Project Structure

```
seva-bus-booking-app/
├── server/
│   ├── index.js     Express server, static middleware, SPA fallback
│   ├── db.js        SQLite schema, migrations, connection, seed data
│   ├── auth.js      JWT token generation & RBAC route middleware
│   ├── api.js       All REST API endpoints (metrics, search, cancel, backups)
│   └── backup.js    Automated SQLite database backup utility
├── public/
│   ├── index.html   App HTML entry point
│   ├── style.css    Design system, KPI cards, ticket print styles
│   └── app.js       Single-page application client, routing & views
├── data/
│   ├── seva.db      SQLite database file (gitignored)
│   └── backups/     Timestamped database backups
├── .env.example     Environment template
├── package.json     Dependencies & npm scripts
└── README.md        Project documentation
```

---

## Database Backups

Run manual or scheduled cron backups via:
```bash
npm run backup
```
Backups are saved to `data/backups/seva-backup-<timestamp>.db`.
