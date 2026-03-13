require('dotenv').config();

const express = require('express');
const path = require('path');
const cors = require('cors');
const { loginAdmin } = require('./server/auth');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static files
app.use(express.static(path.join(__dirname), {
  index: 'index.html'
}));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Auth route
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const result = loginAdmin(email, password);
  if (!result) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  res.json(result);
});

// API Routes
app.use('/api/services', require('./server/routes/services'));
app.use('/api/photos', require('./server/routes/photos'));
app.use('/api/bookings', require('./server/routes/bookings'));
app.use('/api/payments', require('./server/routes/payments'));

// Admin portal route
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Dashboard stats for admin
const { authenticateToken, requirePermission } = require('./server/auth');
app.get('/api/dashboard/stats', authenticateToken, requirePermission('read'), (req, res) => {
  const { getDb } = require('./server/database');
  const db = getDb();

  const totalBookings = db.prepare('SELECT COUNT(*) as count FROM bookings').get().count;
  const pendingBookings = db.prepare("SELECT COUNT(*) as count FROM bookings WHERE status = 'pending'").get().count;
  const confirmedBookings = db.prepare("SELECT COUNT(*) as count FROM bookings WHERE status = 'confirmed'").get().count;
  const totalPhotos = db.prepare('SELECT COUNT(*) as count FROM photos').get().count;
  const activeServices = db.prepare('SELECT COUNT(*) as count FROM services WHERE active = 1').get().count;
  const paidBookings = db.prepare("SELECT COUNT(*) as count FROM bookings WHERE payment_status = 'paid'").get().count;
  const totalRevenue = db.prepare("SELECT COALESCE(SUM(amount_cents), 0) as total FROM bookings WHERE payment_status = 'paid'").get().total;
  const recentBookings = db.prepare('SELECT * FROM bookings ORDER BY created_at DESC LIMIT 5').all();

  res.json({
    totalBookings,
    pendingBookings,
    confirmedBookings,
    totalPhotos,
    activeServices,
    paidBookings,
    totalRevenue,
    recentBookings
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Benny and the Pets server running on http://localhost:${PORT}`);
  console.log(`Admin portal: http://localhost:${PORT}/admin`);
});
