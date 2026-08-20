const express = require('express');
const { query } = require('../database');
const cache = require('../cache');
const { authenticateToken, requirePermission, logAudit } = require('../auth');
const {
  BILLING_UNITS,
  BOOKING_MODES,
  normalizeBillingUnit,
  normalizeBookingMode,
  normalizeCurrency,
  publicService
} = require('../pricing');

const router = express.Router();

// URL-safe slug for /services/:slug detail pages. Derived from the name rather
// than stored so a rename can't leave a stale slug pointing at nothing.
function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function parsePerks(service) {
  if (Array.isArray(service.perks)) return service.perks;
  try {
    const parsed = JSON.parse(service.perks || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// The one place a services row becomes an API object. Price labels are computed
// (never stored) and `perks` is always an array.
function shape(row) {
  const service = publicService(row);
  return { ...service, perks: parsePerks(service), slug: slugify(service.name) };
}

// Cached. This is the catalogue behind the marketing cards, the service pages,
// the footer, the enquiry form's options and the public /api/services — several
// reads per page view of a table that changes when an administrator edits it,
// which invalidates this entry (see server/cache.js).
//
// Money does NOT come from here. Bookings and payments load the service by id
// straight from the database, so a price change can never be applied to a
// charge from a cached row.
const listPublicServices = cache.register('services:public', ['services'], async () => {
  const { rows } = await query(
    'SELECT * FROM services WHERE active = TRUE ORDER BY display_order ASC, id ASC'
  );
  return rows.map(shape);
});

async function findPublicServiceBySlug(slug) {
  const services = await listPublicServices();
  return services.find(s => s.slug === slug) || null;
}

// Public: every publicly-visible service, each carrying its own booking_mode so
// marketing and booking surfaces are driven by one catalog. A service the
// business can't currently deliver is either 'inquiry', 'unavailable', or
// active = FALSE — it is never advertised as immediately bookable.
router.get('/', async (req, res, next) => {
  try {
    res.json(await listPublicServices());
  } catch (err) {
    next(err);
  }
});

// Admin: Get all services (including inactive)
router.get('/all', authenticateToken, requirePermission('read'), async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM services ORDER BY display_order ASC, id ASC');
    res.json(rows.map(shape));
  } catch (err) {
    next(err);
  }
});

function validateWrite(body, { partial }) {
  const errors = [];
  const has = k => body[k] !== undefined && body[k] !== null;

  if (!partial || has('name')) {
    if (typeof body.name !== 'string' || !body.name.trim()) errors.push('name is required');
  }
  if (!partial || has('description')) {
    if (typeof body.description !== 'string' || !body.description.trim()) {
      errors.push('description is required');
    }
  }
  if (!partial || has('price_cents')) {
    const cents = Number(body.price_cents);
    if (!Number.isInteger(cents) || cents < 0) {
      errors.push('price_cents must be a non-negative integer number of cents');
    }
  }
  if (has('billing_unit') && !BILLING_UNITS.includes(body.billing_unit)) {
    errors.push(`billing_unit must be one of: ${BILLING_UNITS.join(', ')}`);
  }
  if (has('booking_mode') && !BOOKING_MODES.includes(body.booking_mode)) {
    errors.push(`booking_mode must be one of: ${BOOKING_MODES.join(', ')}`);
  }
  if (has('perks') && !Array.isArray(body.perks)) {
    errors.push('perks must be an array of strings');
  }
  // price_label is computed from price_cents/billing_unit. Accepting one here
  // would reintroduce exactly the drift migration 0014 removed.
  if (body.price_label !== undefined) {
    errors.push('price_label is derived from price_cents and billing_unit and cannot be set');
  }
  return errors;
}

// Admin: Create a service
router.post('/', authenticateToken, requirePermission('write'), async (req, res, next) => {
  try {
    const errors = validateWrite(req.body, { partial: false });
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });

    const {
      name, description, icon, perks, price_cents, is_featured,
      display_order, stripe_price_id, billing_unit, booking_mode, price_is_from, currency
    } = req.body;

    const { rows } = await query(
      `INSERT INTO services
         (name, description, icon, perks, price_cents, is_featured, display_order,
          stripe_price_id, billing_unit, booking_mode, price_is_from, currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        name.trim(), description.trim(), icon || '',
        JSON.stringify(perks || []),
        Number(price_cents),
        !!is_featured, display_order || 0,
        stripe_price_id || '',
        normalizeBillingUnit(billing_unit),
        normalizeBookingMode(booking_mode),
        price_is_from === undefined ? true : !!price_is_from,
        normalizeCurrency(currency)
      ]
    );

    await logAudit(req.admin.id, req.admin.email, 'create', 'services', rows[0].id.toString(), 'success');
    res.status(201).json({ id: rows[0].id, message: 'Service created', service: shape(rows[0]) });
  } catch (err) {
    next(err);
  }
});

// Admin: Update a service
router.put('/:id', authenticateToken, requirePermission('write'), async (req, res, next) => {
  try {
    const errors = validateWrite(req.body, { partial: true });
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });

    const {
      name, description, icon, perks, price_cents, is_featured, display_order,
      active, stripe_price_id, billing_unit, booking_mode, price_is_from, currency
    } = req.body;

    const { rows } = await query(
      `UPDATE services SET
         name = COALESCE($1, name),
         description = COALESCE($2, description),
         icon = COALESCE($3, icon),
         perks = COALESCE($4, perks),
         price_cents = COALESCE($5, price_cents),
         is_featured = COALESCE($6, is_featured),
         display_order = COALESCE($7, display_order),
         active = COALESCE($8, active),
         stripe_price_id = COALESCE($9, stripe_price_id),
         billing_unit = COALESCE($10, billing_unit),
         booking_mode = COALESCE($11, booking_mode),
         price_is_from = COALESCE($12, price_is_from),
         currency = COALESCE($13, currency),
         updated_at = NOW()
       WHERE id = $14
       RETURNING *`,
      [
        name ?? null,
        description ?? null,
        icon ?? null,
        perks ? JSON.stringify(perks) : null,
        price_cents ?? null,
        is_featured !== undefined ? !!is_featured : null,
        display_order ?? null,
        active !== undefined ? !!active : null,
        stripe_price_id ?? null,
        billing_unit !== undefined ? normalizeBillingUnit(billing_unit) : null,
        booking_mode !== undefined ? normalizeBookingMode(booking_mode) : null,
        price_is_from !== undefined ? !!price_is_from : null,
        currency !== undefined ? normalizeCurrency(currency) : null,
        req.params.id
      ]
    );

    if (!rows[0]) return res.status(404).json({ error: 'Service not found' });

    await logAudit(req.admin.id, req.admin.email, 'update', 'services', req.params.id, 'success');
    res.json({ message: 'Service updated', service: shape(rows[0]) });
  } catch (err) {
    next(err);
  }
});

// Admin: Delete a service
router.delete('/:id', authenticateToken, requirePermission('delete'), async (req, res, next) => {
  try {
    await query('DELETE FROM services WHERE id = $1', [req.params.id]);
    await logAudit(req.admin.id, req.admin.email, 'delete', 'services', req.params.id, 'success');
    res.json({ message: 'Service deleted' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.listPublicServices = listPublicServices;
module.exports.findPublicServiceBySlug = findPublicServiceBySlug;
module.exports.slugify = slugify;
module.exports.shape = shape;
