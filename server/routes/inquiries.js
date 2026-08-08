const express = require('express');
const crypto = require('crypto');
const { query } = require('../database');
const { authenticateToken, requirePermission, logAudit } = require('../auth');
const mailer = require('../email');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const VALID_STATUS = new Set(['new', 'in_progress', 'answered', 'spam']);

function hashIp(ip) {
  if (!ip) return '';
  return crypto.createHmac('sha256', process.env.JWT_SECRET || '')
    .update(String(ip)).digest('hex').slice(0, 32);
}

function field(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

// Public: submit an enquiry.
//
// This is the route a visitor takes when they are not ready to create an
// account — the "guest inquiry" path the site previously lacked entirely.
router.post('/', async (req, res, next) => {
  try {
    const name = field(req.body?.name, 120);
    const email = field(req.body?.email, 254);
    const phone = field(req.body?.phone, 40);
    const message = field(req.body?.message, 4000);
    const serviceId = parseInt(req.body?.service_id, 10);

    // Honeypot. A field hidden from humans that only a bot fills in. Answer 200
    // so the bot believes it succeeded and does not retry with a variation.
    if (field(req.body?.website, 200)) {
      return res.status(200).json({ message: 'Thanks — we will be in touch.' });
    }

    const errors = [];
    if (!name) errors.push('Please tell us your name');
    if (!email || !EMAIL_RE.test(email)) errors.push('Please give us a valid email address so we can reply');
    if (!message || message.length < 10) errors.push('Please tell us a little about what you need');
    if (errors.length) {
      return res.status(400).json({ error: errors.join('. ') });
    }

    let serviceName = '';
    if (Number.isInteger(serviceId)) {
      const { rows } = await query('SELECT name FROM services WHERE id = $1', [serviceId]);
      if (rows[0]) serviceName = rows[0].name;
    }

    const { rows } = await query(
      `INSERT INTO inquiries (name, email, phone, service_id, service_name, message, ip_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, created_at`,
      [name, email, phone, Number.isInteger(serviceId) ? serviceId : null,
        serviceName, message, hashIp(req.ip)]
    );

    // The database row is the record; email is only the notification, so a
    // mail failure must not lose the enquiry or fail the request.
    try {
      await mailer.sendInquiryToOwner({
        inquiry: { ...rows[0], name, email, phone, message, service_name: serviceName }
      });
    } catch (err) {
      console.error('[inquiry] owner notification failed for', rows[0].id, err.message);
    }

    res.status(201).json({
      id: rows[0].id,
      message: 'Thanks — we have your message and will reply by email.'
    });
  } catch (err) {
    next(err);
  }
});

// Admin: the enquiry queue.
router.get('/', authenticateToken, requirePermission('read'), async (req, res, next) => {
  try {
    const { status } = req.query;
    const params = [];
    let sql = `SELECT id, name, email, phone, service_id, service_name, message,
                      status, handled_at, handled_by, admin_notes, created_at
               FROM inquiries`;
    if (status && VALID_STATUS.has(status)) {
      params.push(status);
      sql += ` WHERE status = $1`;
    }
    sql += ` ORDER BY created_at DESC LIMIT 200`;
    const { rows } = await query(sql, params);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/stats', authenticateToken, requirePermission('read'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT COUNT(*) FILTER (WHERE status = 'new')::int AS new_count,
              COUNT(*)::int AS total
       FROM inquiries`
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Admin: move an enquiry through the queue.
router.put('/:id', authenticateToken, requirePermission('write'), async (req, res, next) => {
  try {
    const { status, admin_notes } = req.body || {};
    if (status !== undefined && !VALID_STATUS.has(status)) {
      return res.status(400).json({
        error: `Invalid status. Must be one of: ${[...VALID_STATUS].join(', ')}`
      });
    }

    const { rows } = await query(
      `UPDATE inquiries SET
         status = COALESCE($1, status),
         admin_notes = COALESCE($2, admin_notes),
         handled_at = CASE WHEN $1 IS NULL OR $1 = 'new' THEN handled_at ELSE NOW() END,
         handled_by = CASE WHEN $1 IS NULL OR $1 = 'new' THEN handled_by ELSE $3 END
       WHERE id = $4
       RETURNING *`,
      [status ?? null, admin_notes ?? null, req.admin.email || '', req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Inquiry not found' });

    await logAudit(req.admin.id, req.admin.email, 'update', 'inquiries', req.params.id, 'success');
    res.json({ message: 'Inquiry updated', inquiry: rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
