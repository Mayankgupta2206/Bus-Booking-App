# Seva Bus Booking & Fleet Management Platform

A production-grade, internal bus seva booking, fleet operations, and ticketing platform. Features include real-time dashboard analytics, interactive seat-map booking with passenger details, dynamic role-based power delegation (RBAC), global PNR/phone search, dedicated passenger digital boarding passes with QR codes, camera QR boarding scanner, spot cash/UPI balance payments, printable manifests, trip lifecycle management, and Turso Cloud SQLite 24/7 deployment on Vercel.

---

## 🚀 Key Highlights & Architectural Features

### 1. ⚡ Dynamic Permissions & Powers System (RBAC)
- **Granular Operational Powers:** Admin can dynamically grant or revoke any of the **10 specific powers** for any staff member in real-time:
  1. `can_book`: Create bookings, reserve seats, and select pickup stops.
  2. `can_cancel`: Cancel bookings, release individual or group seats, and process refunds.
  3. `can_collect_payment`: Collect spot cash/UPI balance payments at bus boarding.
  4. `can_manifest`: Access passenger manifests, check-in passengers, and use the camera QR boarding scanner.
  5. `can_manage_routes`: Create, edit, and delete routes, pickup points, and seat fares.
  6. `can_manage_trips`: Schedule departures, assign buses, and update trip lifecycle status.
  7. `can_manage_buses`: Build custom bus seat layouts (2+2, 2+1, sleeper) and manage the fleet.
  8. `can_view_logs`: Inspect real-time audit logs and staff activity trails.
  9. `can_manage_users`: Create staff accounts and dynamically delegate permissions.
  10. `can_manage_settings`: Configure public passenger domain, company branding, and support phone.
- **Admin UI Delegation:**
  - One-click **"⚡ Manage Powers"** modal in Users view (`#/admin/users`).
  - iOS-style toggle switches for each capability with descriptions.
  - **Quick Presets:** `👑 Full Admin`, `🎟️ Booking Agent`, `📋 Conductor / Supervisor`, `Clear All`.
- **Live Server Enforcement:** Permissions are enforced in real-time on every API request via `requirePerm(permKey)` middleware.

### 2. 🛡️ Dedicated Passenger Pass & 100% URL Isolation (Option 1 & 2)
- **Zero Login Exposure:** Passengers accessing digital tickets never see the staff/admin portal or login screen.
- **Standalone Passenger Pass (`/ticket` / `/pass` / `public/ticket.html`):**
  - High-performance, lightweight page containing zero staff/admin code.
  - Displays passenger details, route, bus, departure time, seat list, payment stamp, and scannable QR verification code.
  - Integrated with **"Print / Save PDF"** and in-page **"Search Another Pass"** without page reloads.
- **Dedicated Public Domain Support (Option 1 & 2):**
  - In Admin Settings (`#/admin/settings`), set the **Public Passenger Boarding Pass Domain** (e.g. `https://seva-pass.vercel.app`).
  - All **WhatsApp ticket share links** automatically send:  
    `https://seva-pass.vercel.app/ticket?pnr=PNR712019`
  - Even if a passenger strips the URL down to the root (`https://seva-pass.vercel.app/`), they only see the clean **"Find Your Boarding Pass"** lookup screen. The login screen does not exist on the public domain!

### 3. ☁️ Turso Cloud SQLite & 24/7 Vercel Deployment
- **Zero Sleep Time / Zero Cold Start Delays:** Connected to **Turso Cloud SQLite** (`libsql`) over persistent cloud replicas, eliminating server sleep issues common with free-tier container platforms.
- **Serverless Ready:** Built-in Vercel Serverless Function routing (`api/index.js`, `api/[...path].js`, `vercel.json`) compatible with Node.js 24 runtime and `/tmp` filesystem replication.
- **Local Fallback:** Automatically switches to local `better-sqlite3` WAL mode when running offline or without cloud credentials.

### 4. 📷 Live Camera QR Scanner & Spot Payments
- **Manifest Boarding Scanner:** Conductors and supervisors can tap **"📷 Scan QR Ticket"** to open the real-time camera scanner with green reticle animations and audio-visual verification feedback.
- **Spot Balance Payment at Boarding:** Record cash or UPI balance payments directly from the boarding gate or manifest modal. Automatically updates `amount_paid` and status (`Paid`, `Partial`).

### 5. 🚌 Bus Layout Designer & Custom Pattern Builder
- Generate any seating arrangement via mathematical formulas: `2+2`, `2+1`, `1+2`, `1+1` (VIP), `3+2`, `1+1+1` (Sleeper/Pod).
- Interactive cabin editor: customize seat codes, flip left/right, add rear benches, renumber seats sequentially or by letter, and detect duplicate seat labels automatically.

---

## 🛠️ Tech Stack

- **Backend:** Node.js, Express, Turso Cloud SQLite (`@libsql/client` / `libsql`) with `better-sqlite3` local fallback, JWT authentication (`jsonwebtoken`), bcrypt password hashing (`bcryptjs`), rate limiting (`express-rate-limit`).
- **Frontend:** Pure Vanilla HTML5 / CSS3 / ES6, zero-build single-page application (SPA) with hash-based routing (`location.hash`), responsive mobile viewport, PWA manifest and service worker.
- **Deployments:** Vercel Serverless Functions + Turso Cloud SQLite.

---

## 💻 Getting Started Locally

Requires **Node.js 18+** (recommended Node.js 20+ or 24+).

### 1. Clone & Install Dependencies
```bash
git clone https://github.com/Mayankgupta2206/Bus-Booking-App.git
cd Bus-Booking-App
npm install
```

### 2. Configure Environment Variables
Create a `.env` file in the project root:
```env
PORT=4000
JWT_SECRET=your-super-secret-jwt-key-here

# Optional: Turso Cloud SQLite (Leave empty to use local data/seva.db)
TURSO_DATABASE_URL=libsql://your-db-name.turso.io
TURSO_AUTH_TOKEN=your-turso-auth-token
```

### 3. Start the Development Server
```bash
npm start
```
Open **http://localhost:4000** in your browser. Demo seed accounts and sample routes/buses are generated automatically on first run.

---

## 🔑 Default Credentials

| Username | Password | Base Role | Default Powers |
|---|---|---|---|
| `admin` | `Admin@321` | **Admin** | Full access: All 10 powers enabled by default |
| `agent` | `Agent321` | **Agent** | Booking creation & own booking cancellation |
| `supervisor` | `Supervisor321` | **Supervisor** | Manifest view, QR scanner, spot cash collection, cancellation |

*(Admin can modify or customize powers for any user at any time from the Users & Powers panel).*

---

## 🌐 Deploying to Vercel

### Step 1: Deploy Main Admin / Staff Portal
1. Push your repository to GitHub.
2. Import the repository in [Vercel](https://vercel.com).
3. Set the Environment Variables:
   - `JWT_SECRET`: A secure random secret string.
   - `TURSO_DATABASE_URL`: `libsql://<your-turso-db>.turso.io`
   - `TURSO_AUTH_TOKEN`: `<your-turso-token>`
4. Click **Deploy**. Your staff dashboard will be live at `https://<your-project>.vercel.app`.

### Step 2: (Option 1) Deploy Dedicated Public Passenger Portal
1. In Vercel, click **Add New...** -> **Project**.
2. Select the same repository and click **Import**.
3. Set Project Name to `seva-pass` (or any passenger-friendly domain).
4. Set Environment Variables:
   - Same `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`.
   - Add: `PUBLIC_PASSENGER_MODE` = `true`
5. Click **Deploy**. Your isolated passenger portal will be live at `https://seva-pass.vercel.app`.
6. Open your Admin Portal -> **⚙️ Settings**, enter `https://seva-pass.vercel.app` in **Public Passenger Domain**, and click **Save**.

---

## 📡 REST API Reference

All endpoints except public pass lookup and login require `Authorization: Bearer <token>`.

### Public Endpoints
| Method | Path | Description |
|---|---|---|
| `POST` | `/api/auth/login` | Staff authentication with IP rate limiting |
| `GET` | `/api/public/pass/:pnr` | Public passenger pass verification (no login required) |
| `GET` | `/api/settings/public` | Public settings (passenger pass domain, company name, helpline) |

### Authenticated & RBAC Endpoints
| Method | Path | Required Power / Role | Description |
|---|---|---|---|
| `GET` | `/api/me` | Authenticated | Profile & real-time user permissions |
| `GET` | `/api/dashboard/stats` | Authenticated | Real-time occupancy, revenue, and active departures |
| `GET` | `/api/bookings/search` | Authenticated | Global search by PNR, phone number, or passenger name |
| `POST` | `/api/bookings` | `can_book` | Create new seat booking |
| `DELETE` | `/api/bookings/:id` | `can_cancel` | Cancel booking and release all seats to inventory |
| `DELETE` | `/api/bookings/:id/seats/:label` | `can_cancel` | Release individual seat from group booking |
| `POST` | `/api/bookings/:id/pay-balance` | `can_collect_payment` | Record spot cash/UPI payment at boarding |
| `POST` | `/api/manifest/board` | `can_manifest` | Check in passenger / mark boarded via QR or manual tap |
| `GET` | `/api/routes` | Authenticated | List all active routes and fares |
| `POST` | `/api/routes` | `can_manage_routes` | Create route with stops and pricing |
| `PATCH` | `/api/routes/:id` | `can_manage_routes` | Update route details |
| `DELETE` | `/api/routes/:id` | `can_manage_routes` | Delete route (with cascade protection) |
| `GET` | `/api/buses` | Authenticated | List fleet buses and custom seat grids |
| `POST` | `/api/buses` | `can_manage_buses` | Register new bus and layout |
| `PATCH` | `/api/buses/:id` | `can_manage_buses` | Update bus details and seat layout |
| `DELETE` | `/api/buses/:id` | `can_manage_buses` | Remove bus from fleet |
| `GET` | `/api/trips` | Authenticated | Filter trips by route, date, and status |
| `POST` | `/api/trips` | `can_manage_trips` | Schedule new trip |
| `PATCH` | `/api/trips/:id/status` | `can_manage_trips` | Update trip status (`Planned`, `In-Transit`, `Completed`, `Cancelled`) |
| `DELETE` | `/api/trips/:id` | `can_manage_trips` | Delete scheduled trip |
| `GET` | `/api/audit-logs` | `can_view_logs` | Retrieve real-time activity and audit trail |
| `GET` | `/api/users` | `can_manage_users` | List staff accounts and active powers |
| `POST` | `/api/users` | `can_manage_users` | Create staff account with assigned powers |
| `PATCH` | `/api/users/:id` | `can_manage_users` | Update staff profile, role, or password |
| `PATCH` | `/api/users/:id/permissions` | `can_manage_users` | Dynamically update user's operational powers |
| `DELETE` | `/api/users/:id` | `can_manage_users` | Remove staff account |
| `GET` | `/api/settings` | `can_manage_settings` | Get all system configuration keys |
| `POST` | `/api/settings` | `can_manage_settings` | Update passenger pass URL and company configuration |

---

## 📂 Project Directory Structure

```
seva-bus-booking-app/
├── api/
│   ├── [...path].js     Vercel serverless catch-all function handler
│   └── index.js         Vercel serverless root function handler
├── server/
│   ├── index.js         Express application, static assets, and passenger mode routing
│   ├── db.js            Turso Cloud SQLite connection, schema, migrations, and helpers
│   ├── auth.js          JWT authentication and real-time requirePerm middleware
│   ├── api.js           REST API routes (auth, bookings, manifest, users, settings)
│   └── backup.js        Local SQLite backup snapshot utility
├── public/
│   ├── index.html       Staff Portal single-page application entry point
│   ├── ticket.html      Standalone Public Passenger Boarding Pass & PNR lookup
│   ├── style.css        Design system, responsive cards, modals, and print layouts
│   ├── app.js           SPA client application, dynamic powers modal, and view routing
│   ├── icon.svg         PWA app icon
│   └── sw.js            Service worker for offline PWA capabilities
├── data/
│   ├── seva.db          Local SQLite database file (used when offline/local)
│   └── backups/         Timestamped local database backup snapshots
├── vercel.json          Vercel routing and serverless function rewrites
├── package.json         Project dependencies, Node.js engine, and scripts
└── README.md            Complete project documentation
```

---

## 📄 License & Credits

Developed with ❤️ for Seva Bus operations. Built for performance, security, and reliability.
