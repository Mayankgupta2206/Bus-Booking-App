require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const api = require('./api');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, '..', 'public'), {
  etag: false,
  maxAge: 0,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    }
    if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));
app.use(express.json());
app.use('/api', api);
app.use(api);

// Dedicated Standalone Passenger Ticket Route (no staff code exposed)
app.get('/ticket', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'ticket.html'));
});

// SPA fallback so refreshing on any client-side route still loads the app
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

const PORT = process.env.PORT || 4000;
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Seva Bus Booking server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
