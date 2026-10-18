require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const api = require('./api');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, '..', 'public'), {
  etag: true,
  maxAge: '1h',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    }
    if (filePath.endsWith('.html')) {
      // HTML is never cached so app updates are immediate
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else {
      // Static JS, CSS, and icons can use conditional ETag and stale-while-revalidate
      res.setHeader('Cache-Control', 'public, max-age=1800, stale-while-revalidate=86400');
    }
  }
}));
const isPassengerMode = process.env.PUBLIC_PASSENGER_MODE === 'true';

app.use((req, res, next) => {
  const host = (req.headers.host || '').toLowerCase();
  req.isPassengerMode = isPassengerMode || host.includes('pass') || host.includes('ticket');
  next();
});

app.use(express.json());
app.use('/api', api);
app.use(api);

// Dedicated Standalone Passenger Ticket Route (no staff code exposed)
app.get(['/ticket', '/pass'], (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'ticket.html'));
});

// Root route: If accessing from Passenger Pass domain, serve ticket.html directly (zero staff code)
app.get('/', (req, res, next) => {
  if (req.isPassengerMode) {
    return res.sendFile(path.join(__dirname, '..', 'public', 'ticket.html'));
  }
  next();
});

// SPA fallback
app.get('*', (req, res) => {
  if (req.isPassengerMode) {
    return res.sendFile(path.join(__dirname, '..', 'public', 'ticket.html'));
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

const { runAutoDriveArchive } = require('./archive');

const PORT = process.env.PORT || 4000;
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Seva Bus Booking server running on http://localhost:${PORT}`);
    // Auto-Drive Archive background check
    setTimeout(async () => {
      try {
        const res = await runAutoDriveArchive();
        if (res.archived && res.archived.length > 0) {
          console.log(`[Auto-Drive Archive] Automatically archived & purged ${res.archived.length} completed past trip(s).`);
        }
      } catch (e) {
        console.warn('[Auto-Drive Archive] Background check notice:', e.message);
      }
    }, 5000);
    setInterval(async () => {
      try {
        await runAutoDriveArchive();
      } catch (e) {}
    }, 6 * 60 * 60 * 1000);
  });
}

module.exports = app;
