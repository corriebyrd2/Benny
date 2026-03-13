const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, '..', 'benny.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initTables();
  }
  return db;
}

function initTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      icon TEXT DEFAULT '',
      perks TEXT DEFAULT '[]',
      price_cents INTEGER NOT NULL,
      price_label TEXT NOT NULL,
      is_featured INTEGER DEFAULT 0,
      display_order INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      stripe_price_id TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      caption TEXT DEFAULT '',
      layout TEXT DEFAULT 'normal',
      display_order INTEGER DEFAULT 0,
      show_on_homepage INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT DEFAULT '',
      dog_name TEXT NOT NULL,
      service_id INTEGER,
      service_name TEXT NOT NULL,
      preferred_dates TEXT DEFAULT '',
      message TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      payment_status TEXT DEFAULT 'unpaid',
      stripe_payment_id TEXT DEFAULT '',
      amount_cents INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE SET NULL
    );
  `);

  // Seed default admin if none exists
  const adminCount = db.prepare('SELECT COUNT(*) as count FROM admins').get();
  if (adminCount.count === 0) {
    const email = process.env.ADMIN_EMAIL || 'admin@bennyandthepets.com';
    const password = process.env.ADMIN_PASSWORD || 'changeme123';
    const hash = bcrypt.hashSync(password, 10);
    db.prepare('INSERT INTO admins (email, password_hash) VALUES (?, ?)').run(email, hash);
  }

  // Seed default services if none exist
  const serviceCount = db.prepare('SELECT COUNT(*) as count FROM services').get();
  if (serviceCount.count === 0) {
    const insert = db.prepare(`
      INSERT INTO services (name, description, icon, perks, price_cents, price_label, is_featured, display_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const seedServices = db.transaction(() => {
      insert.run('Overnight Boarding',
        'Cozy suites with bedtime stories (yes, really) and midnight check-ins. Your pup sleeps like royalty.',
        '&#127968;',
        JSON.stringify(['Private suites', 'Evening walk included', 'Breakfast & dinner']),
        4500, 'From $45/night', 0, 1);

      insert.run('Doggy Daycare',
        'A full day of socialization, play, and structured activities. Your dog will come home happily exhausted!',
        '&#9728;&#65039;',
        JSON.stringify(['Supervised group play', 'Nap time included', 'Photo updates']),
        3000, 'From $30/day', 1, 2);

      insert.run('Spa & Grooming',
        'Bath time shouldn\'t be a battle. Our gentle groomers make every pup feel pampered and pretty.',
        '&#128704;',
        JSON.stringify(['Bath & blow-dry', 'Nail trimming', 'Coat brushing']),
        3500, 'From $35/session', 0, 3);

      insert.run('Training Sessions',
        'Positive reinforcement training that makes learning fun. From basics to impressive tricks!',
        '&#127939;',
        JSON.stringify(['1-on-1 sessions', 'Certified trainers', 'Progress reports']),
        5000, 'From $50/session', 0, 4);
    });

    seedServices();
  }
}

module.exports = { getDb };
