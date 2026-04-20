const express = require('express');
const { query } = require('../database');
const { authenticateToken, requirePermission, logAudit } = require('../auth');
const mailer = require('../email');

const router = express.Router();

// Admin: audience size — powers the "X recipients" hint in the UI.
router.get('/stats', authenticateToken, requirePermission('read'), async (req, res) => {
  const { rows } = await query('SELECT COUNT(*)::int AS count FROM subscribers');
  res.json({ subscriberCount: rows[0].count });
});

// Admin: send an email to every captured subscriber via SendGrid Mail Send (BCC).
router.post('/', authenticateToken, requirePermission('write'), async (req, res) => {
  const subject = typeof req.body?.subject === 'string' ? req.body.subject.trim() : '';
  const html = typeof req.body?.html === 'string' ? req.body.html.trim() : '';
  const plain = typeof req.body?.plain === 'string' ? req.body.plain.trim() : '';

  if (!subject || subject.length > 200) {
    return res.status(400).json({ error: 'Subject is required (max 200 chars)' });
  }
  if (!html || html.length > 100_000) {
    return res.status(400).json({ error: 'HTML body is required (max 100k chars)' });
  }

  try {
    const { rows } = await query('SELECT email FROM subscribers ORDER BY id');
    const recipients = rows.map(r => r.email);
    const result = await mailer.sendMarketingCampaign({ subject, html, plain, recipients });
    await logAudit(req.admin.id, req.admin.email, 'send', 'campaign', null,
      `${result.status}: ${result.recipientCount} recipients`);
    res.status(202).json({ message: 'Campaign sent', ...result });
  } catch (err) {
    // SendGrid's useful detail lives in err.response.body.errors, not err.message.
    const sgErrors = err.response?.body?.errors;
    const detail = Array.isArray(sgErrors)
      ? sgErrors.map(e => e.message).join('; ')
      : err.message;
    console.error('[campaigns] send failed:', err.response?.body || err);
    await logAudit(req.admin.id, req.admin.email, 'send', 'campaign', null, `failed: ${detail}`);
    res.status(502).json({ error: detail });
  }
});

module.exports = router;
