const crypto = require('crypto');
const express = require('express');
const { query } = require('../database');
const { authenticateToken, requirePermission } = require('../auth');

const router = express.Router();

const SIGNATURE_HEADER = 'x-twilio-email-event-webhook-signature';
const TIMESTAMP_HEADER = 'x-twilio-email-event-webhook-timestamp';
const PUBLIC_KEY = process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY || '';
const IS_PROD = (process.env.NODE_ENV || 'development') === 'production';

const BOOKING_STATUS_BY_EVENT = {
  processed: 'processed',
  delivered: 'delivered',
  deferred: 'deferred',
  bounce: 'bounced',
  dropped: 'dropped',
  spamreport: 'spam_report',
  unsubscribe: 'unsubscribed',
  group_unsubscribe: 'unsubscribed'
};

function publicKeyObject() {
  if (!PUBLIC_KEY) return null;
  const key = PUBLIC_KEY.includes('BEGIN PUBLIC KEY')
    ? PUBLIC_KEY.replace(/\\n/g, '\n')
    : `-----BEGIN PUBLIC KEY-----\n${PUBLIC_KEY.match(/.{1,64}/g)?.join('\n') || PUBLIC_KEY}\n-----END PUBLIC KEY-----`;
  return crypto.createPublicKey(key);
}

function verifySignature(rawBody, signature, timestamp) {
  if (!PUBLIC_KEY) return !IS_PROD;
  if (!rawBody || !signature || !timestamp) return false;

  try {
    const verifier = crypto.createVerify('SHA256');
    // SendGrid signs the timestamp concatenated with the exact raw request body.
    verifier.update(timestamp);
    verifier.update(rawBody);
    verifier.end();
    return verifier.verify(publicKeyObject(), Buffer.from(signature, 'base64'));
  } catch (err) {
    console.error('[sendgrid-events] signature verification failed:', err.message);
    return false;
  }
}

function eventTimestamp(event) {
  const ts = Number(event.timestamp);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return new Date(ts * 1000);
}

function pickBookingId(event) {
  const raw = event.booking_id || event.custom_args?.booking_id || event.unique_args?.booking_id;
  const id = parseInt(raw, 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function pickEmailType(event) {
  return String(event.email_type || event.custom_args?.email_type || event.unique_args?.email_type || '').slice(0, 100);
}

function deliveryError(event) {
  return String(event.reason || event.response || event.status || '').slice(0, 1000);
}

async function persistEvent(event) {
  const eventType = String(event.event || '').slice(0, 100);
  if (!eventType) return { inserted: false, reason: 'missing_event_type' };

  const bookingId = pickBookingId(event);
  const email = String(event.email || '').slice(0, 254);
  const emailType = pickEmailType(event);
  const timestamp = eventTimestamp(event);
  const rawSgEventId = event.sg_event_id || event.sg_event_id_url_safe || event.event_id;
  const sgEventId = rawSgEventId
    ? String(rawSgEventId).slice(0, 500)
    : crypto.createHash('sha256').update(JSON.stringify({
      event: eventType,
      email,
      bookingId,
      emailType,
      timestamp: event.timestamp,
      sgMessageId: event.sg_message_id || ''
    })).digest('hex');

  const { rows } = await query(
    `INSERT INTO email_events (
       sg_event_id, sg_message_id, event_type, email, booking_id, email_type,
       reason, response, url, user_agent, ip, event_timestamp, raw_event
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (sg_event_id) DO NOTHING
     RETURNING id`,
    [
      sgEventId,
      String(event.sg_message_id || '').slice(0, 500),
      eventType,
      email,
      bookingId,
      emailType,
      String(event.reason || '').slice(0, 1000),
      String(event.response || '').slice(0, 1000),
      String(event.url || '').slice(0, 2000),
      String(event.useragent || event.user_agent || '').slice(0, 1000),
      String(event.ip || '').slice(0, 100),
      timestamp,
      JSON.stringify(event)
    ]
  );

  const inserted = rows.length > 0;
  if (!inserted) return { inserted: false, reason: 'duplicate' };

  const bookingStatus = BOOKING_STATUS_BY_EVENT[eventType];
  if (bookingId && bookingStatus) {
    await query(
      `UPDATE bookings SET
         email_delivery_status = $1,
         email_delivery_last_event = $2,
         email_delivery_last_error = $3,
         email_delivery_status_at = COALESCE($4, NOW()),
         updated_at = NOW()
       WHERE id = $5`,
      [bookingStatus, eventType, deliveryError(event), timestamp, bookingId]
    );
  }

  if (email) {
    await query(
      `UPDATE subscribers SET
         sendgrid_status = CASE
           WHEN $1 IN ('bounce', 'dropped') THEN 'suppressed'
           WHEN $1 IN ('unsubscribe', 'group_unsubscribe') THEN 'unsubscribed'
           WHEN $1 = 'delivered' THEN 'delivered'
           ELSE sendgrid_status
         END,
         unsubscribed_at = CASE
           WHEN $1 IN ('unsubscribe', 'group_unsubscribe') THEN COALESCE($2, NOW())
           ELSE unsubscribed_at
         END,
         sendgrid_synced_at = NOW(),
         last_email_event = $1,
         last_email_event_at = COALESCE($2, NOW())
       WHERE LOWER(email) = LOWER($3)`,
      [eventType, timestamp, email]
    );
  }

  return { inserted: true };
}


router.get('/booking/:id', authenticateToken, requirePermission('read'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, sg_event_id, sg_message_id, event_type, email, booking_id, email_type,
              reason, response, event_timestamp, created_at
       FROM email_events
       WHERE booking_id = $1
       ORDER BY COALESCE(event_timestamp, created_at) DESC, id DESC
       LIMIT 100`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || []));
    const signature = req.header(SIGNATURE_HEADER);
    const timestamp = req.header(TIMESTAMP_HEADER);

    if (!verifySignature(rawBody, signature, timestamp)) {
      return res.status(401).json({ error: 'Invalid SendGrid webhook signature' });
    }

    let events;
    try {
      events = JSON.parse(rawBody.toString('utf8'));
    } catch (err) {
      return res.status(400).json({ error: 'Invalid JSON payload' });
    }

    if (!Array.isArray(events)) {
      return res.status(400).json({ error: 'SendGrid event payload must be an array' });
    }

    let inserted = 0;
    for (const event of events) {
      const result = await persistEvent(event || {});
      if (result.inserted) inserted += 1;
    }

    res.status(202).json({ received: events.length, inserted });
  } catch (err) {
    next(err);
  }
});

module.exports = { router, verifySignature, persistEvent };
