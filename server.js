require('dotenv').config();

const express = require('express');
const path = require('path');
const cors = require('cors');
const { loginAdmin } = require('./server/auth');
const { registerCustomer, loginCustomer, authenticateCustomer } = require('./server/customerAuth');

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

// Customer auth routes
app.post('/api/customer/register', (req, res) => {
  const { name, email, password, phone, dog_name } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password are required' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const result = registerCustomer(name, email, password, phone, dog_name);
  if (result.error) {
    return res.status(409).json({ error: result.error });
  }

  res.status(201).json(result);
});

app.post('/api/customer/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const result = loginCustomer(email, password);
  if (!result) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  res.json(result);
});

app.get('/api/customer/profile', authenticateCustomer, (req, res) => {
  const { getDb } = require('./server/database');
  const db = getDb();
  const customer = db.prepare('SELECT id, name, email, phone, dog_name, created_at FROM customers WHERE id = ?').get(req.customer.id);
  if (!customer) {
    return res.status(404).json({ error: 'Customer not found' });
  }
  res.json(customer);
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

// Customer booking portal route
app.get('/my-bookings', (req, res) => {
  res.sendFile(path.join(__dirname, 'customer.html'));
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
  console.log(`Customer portal: http://localhost:${PORT}/my-bookings`);
});
