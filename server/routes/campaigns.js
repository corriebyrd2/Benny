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

// Admin: create + immediately send a Single Send to the marketing list(s).
router.post('/', authenticateToken, requirePermission('write'), async (req, res) => {
  const subject = typeof req.body?.subject === 'string' ? req.body.subject.trim() : '';
  const html = typeof req.body?.html === 'string' ? req.body.html.trim() : '';
  const plain = typeof req.body?.plain === 'string' ? req.body.plain.trim() : '';
  // SendGrid requires a unique name per SingleSend — fall back to subject + timestamp.
  const name = (typeof req.body?.name === 'string' && req.body.name.trim())
    || `${subject} — ${new Date().toISOString()}`;

  if (!subject || subject.length > 200) {
    return res.status(400).json({ error: 'Subject is required (max 200 chars)' });
  }
  if (!html || html.length > 100_000) {
    return res.status(400).json({ error: 'HTML body is required (max 100k chars)' });
  }

  try {
    const result = await mailer.sendMarketingCampaign({ name, subject, html, plain });
    await logAudit(req.admin.id, req.admin.email, 'send', 'campaign', result.id || null, 'success');
    res.status(202).json({ message: 'Campaign scheduled', ...result });
  } catch (err) {
    await logAudit(req.admin.id, req.admin.email, 'send', 'campaign', null, `failed: ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
