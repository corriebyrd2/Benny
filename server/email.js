const sgMail = require('@sendgrid/mail');

const API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL;
const FROM_NAME = process.env.SENDGRID_FROM_NAME || 'Benny and the Pets';
const OWNER_EMAIL = process.env.OWNER_NOTIFICATION_EMAIL || process.env.ADMIN_EMAIL;
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');

let configured = false;
if (API_KEY && FROM_EMAIL) {
  sgMail.setApiKey(API_KEY);
  configured = true;
} else {
  console.warn('[email] SendGrid not configured — notifications will be skipped. Set SENDGRID_API_KEY and SENDGRID_FROM_EMAIL.');
}

// Default transport calls SendGrid. Tests can override via setTransport().
let transport = {
  async send(msg) {
    if (!configured) return;
    await sgMail.send(msg);
  }
};

function setTransport(t) {
  transport = t;
}

// SendGrid's Mail Send API caps total recipients (to+cc+bcc) at 1000 per call.
// We batch under that with headroom for the single "to" address.
const BCC_BATCH_SIZE = 900;

async function sendMarketingCampaign({ subject, html, plain, recipients }) {
  if (!configured) return { status: 'skipped', reason: 'not_configured', recipientCount: 0 };

  // SendGrid rejects a personalization where the same address appears in both
  // "to" and "bcc", or where "bcc" has duplicates. Normalize + dedupe, and drop
  // FROM_EMAIL from the bcc list (it's already the "to").
  const fromLower = (FROM_EMAIL || '').toLowerCase();
  const seen = new Set();
  const list = [];
  for (const r of Array.isArray(recipients) ? recipients : []) {
    const email = typeof r === 'string' ? r.trim() : '';
    const key = email.toLowerCase();
    if (!email || !key || key === fromLower || seen.has(key)) continue;
    seen.add(key);
    list.push(email);
  }
  if (!list.length) return { status: 'skipped', reason: 'no_recipients', recipientCount: 0 };

  let sent = 0;
  for (let i = 0; i < list.length; i += BCC_BATCH_SIZE) {
    const batch = list.slice(i, i + BCC_BATCH_SIZE);
    try {
      await transport.send({
        to: FROM_EMAIL,
        bcc: batch,
        from: { email: FROM_EMAIL, name: FROM_NAME },
        subject,
        text: plain || undefined,
        html
      });
    } catch (err) {
      console.error('[email] campaign batch failed:', subject,
        'batch_size=', batch.length,
        'from=', FROM_EMAIL,
        'detail=', err.response?.body || err.message);
      throw err;
    }
    sent += batch.length;
  }
  return { status: 'sent', recipientCount: sent };
}

function formatMoney(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Strip CR/LF/NUL — SendGrid's HTTP API encodes JSON, so a newline in a name
// or subject can't directly forge a header today. This is defense-in-depth in
// case the transport ever changes (e.g. raw SMTP), and it also keeps subject
// lines tidy when a user posts a "name" with embedded line breaks.
function oneLine(s) {
  return String(s ?? '').replace(/[\r\n\0]/g, '').trim().slice(0, 500);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isValidRecipient(addr) {
  return typeof addr === 'string' && addr.length <= 254 && !/[\r\n\0]/.test(addr) && EMAIL_RE.test(addr);
}

function bookingSummary(booking) {
  const lines = [
    `Booking #${booking.id}`,
    `Service: ${booking.service_name}`,
    `Dog: ${booking.dog_name}`,
    `Amount: ${formatMoney(booking.amount_cents)}`
  ];
  if (booking.preferred_dates) lines.push(`Preferred dates: ${booking.preferred_dates}`);
  return lines;
}

function bookingHtmlBlock(booking) {
  return `
    <table style="border-collapse:collapse;margin:16px 0;">
      <tr><td style="padding:4px 12px 4px 0;color:#666;">Booking</td><td>#${booking.id}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#666;">Service</td><td>${escapeHtml(booking.service_name)}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#666;">Dog</td><td>${escapeHtml(booking.dog_name)}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#666;">Amount</td><td>${formatMoney(booking.amount_cents)}</td></tr>
      ${booking.preferred_dates ? `<tr><td style="padding:4px 12px 4px 0;color:#666;">Dates</td><td>${escapeHtml(booking.preferred_dates)}</td></tr>` : ''}
    </table>
  `;
}

function customerPortalLink() {
  return PUBLIC_URL ? `${PUBLIC_URL}/my-bookings` : null;
}

async function send({ to, subject, html, text }) {
  if (!to) {
    console.warn(`[email] skipped (no recipient): ${subject}`);
    return;
  }
  if (!isValidRecipient(to)) {
    console.warn(`[email] skipped (invalid recipient): ${subject} → ${to}`);
    return;
  }
  try {
    await transport.send({
      to,
      from: { email: FROM_EMAIL || 'noreply@example.test', name: FROM_NAME },
      subject: oneLine(subject),
      text,
      html
    });
  } catch (err) {
    const detail = err.response?.body?.errors || err.message;
    console.error('[email] send failed:', subject, '→', to, detail);
  }
}

async function sendNewBookingToOwner({ booking }) {
  if (!OWNER_EMAIL) return;
  const link = PUBLIC_URL ? `${PUBLIC_URL}/admin` : null;
  const textLines = [
    'A new booking request just came in.',
    '',
    ...bookingSummary(booking),
    `From: ${booking.owner_name} <${booking.email}>`,
    booking.phone ? `Phone: ${booking.phone}` : null,
    booking.message ? `Message: ${booking.message}` : null,
    '',
    link ? `Manage: ${link}` : null
  ].filter(Boolean);

  await send({
    to: OWNER_EMAIL,
    subject: `New booking request — ${booking.service_name} for ${booking.dog_name}`,
    text: textLines.join('\n'),
    html: `
      <p>A new booking request just came in.</p>
      ${bookingHtmlBlock(booking)}
      <p><strong>From:</strong> ${escapeHtml(booking.owner_name)} &lt;${escapeHtml(booking.email)}&gt;${booking.phone ? ` &middot; ${escapeHtml(booking.phone)}` : ''}</p>
      ${booking.message ? `<p><strong>Message:</strong> ${escapeHtml(booking.message)}</p>` : ''}
      ${link ? `<p><a href="${link}">Open admin portal</a></p>` : ''}
    `
  });
}

async function sendBookingReceivedToCustomer({ booking }) {
  const link = customerPortalLink();
  await send({
    to: booking.email,
    subject: `We got your booking request for ${booking.dog_name}`,
    text: [
      `Hi ${booking.owner_name || 'there'},`,
      '',
      `Thanks for booking with Benny and the Pets! We've received your request and will confirm shortly.`,
      '',
      ...bookingSummary(booking),
      '',
      link ? `View your booking: ${link}` : null
    ].filter(Boolean).join('\n'),
    html: `
      <p>Hi ${escapeHtml(booking.owner_name || 'there')},</p>
      <p>Thanks for booking with Benny and the Pets! We've received your request and will confirm shortly.</p>
      ${bookingHtmlBlock(booking)}
      ${link ? `<p><a href="${link}">View your booking</a></p>` : ''}
    `
  });
}

async function sendBookingApprovedToCustomer({ booking }) {
  const link = customerPortalLink();
  await send({
    to: booking.email,
    subject: `Your booking for ${booking.dog_name} is confirmed`,
    text: [
      `Hi ${booking.owner_name || 'there'},`,
      '',
      `Good news — your booking is confirmed. Payment details will follow.`,
      '',
      ...bookingSummary(booking),
      '',
      link ? `View your booking: ${link}` : null
    ].filter(Boolean).join('\n'),
    html: `
      <p>Hi ${escapeHtml(booking.owner_name || 'there')},</p>
      <p>Good news — your booking is <strong>confirmed</strong>. Payment details will follow.</p>
      ${bookingHtmlBlock(booking)}
      ${link ? `<p><a href="${link}">View your booking</a></p>` : ''}
    `
  });
}

async function sendBookingCancelledToCustomer({ booking, reason }) {
  const link = customerPortalLink();
  await send({
    to: booking.email,
    subject: `Your booking for ${booking.dog_name} was cancelled`,
    text: [
      `Hi ${booking.owner_name || 'there'},`,
      '',
      `Your booking has been cancelled.`,
      reason ? `Reason: ${reason}` : null,
      '',
      ...bookingSummary(booking),
      '',
      link ? `Contact us or view details: ${link}` : null
    ].filter(Boolean).join('\n'),
    html: `
      <p>Hi ${escapeHtml(booking.owner_name || 'there')},</p>
      <p>Your booking has been <strong>cancelled</strong>.</p>
      ${reason ? `<p><strong>Reason:</strong> ${escapeHtml(reason)}</p>` : ''}
      ${bookingHtmlBlock(booking)}
      ${link ? `<p><a href="${link}">View details</a></p>` : ''}
    `
  });
}

async function sendPaymentLinkToCustomer({ booking, checkoutUrl }) {
  await send({
    to: booking.email,
    subject: `Payment link for your booking (${booking.dog_name})`,
    text: [
      `Hi ${booking.owner_name || 'there'},`,
      '',
      `Please complete your payment for the booking below.`,
      '',
      ...bookingSummary(booking),
      '',
      `Pay securely: ${checkoutUrl}`
    ].join('\n'),
    html: `
      <p>Hi ${escapeHtml(booking.owner_name || 'there')},</p>
      <p>Please complete your payment for the booking below.</p>
      ${bookingHtmlBlock(booking)}
      <p><a href="${checkoutUrl}" style="display:inline-block;background:#ff6b9d;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Pay ${formatMoney(booking.amount_cents)}</a></p>
      <p style="color:#666;font-size:12px;">Or copy and paste this link: ${escapeHtml(checkoutUrl)}</p>
    `
  });
}

async function sendPaymentReceivedToCustomer({ booking }) {
  const link = customerPortalLink();
  await send({
    to: booking.email,
    subject: `Payment received — booking #${booking.id}`,
    text: [
      `Hi ${booking.owner_name || 'there'},`,
      '',
      `We've received your payment of ${formatMoney(booking.amount_cents)}. Thank you!`,
      '',
      ...bookingSummary(booking),
      '',
      link ? `View your booking: ${link}` : null
    ].filter(Boolean).join('\n'),
    html: `
      <p>Hi ${escapeHtml(booking.owner_name || 'there')},</p>
      <p>We've received your payment of <strong>${formatMoney(booking.amount_cents)}</strong>. Thank you!</p>
      ${bookingHtmlBlock(booking)}
      ${link ? `<p><a href="${link}">View your booking</a></p>` : ''}
    `
  });
}

async function sendPasswordResetToCustomer({ to, name, resetLink }) {
  const greeting = name ? `Hi ${escapeHtml(name)},` : 'Hi there,';
  await send({
    to,
    subject: 'Reset your Benny and the Pets password',
    text: [
      name ? `Hi ${name},` : 'Hi there,',
      '',
      'We received a request to reset your password. Click the link below to choose a new one. This link expires in 1 hour.',
      '',
      resetLink,
      '',
      `If you didn't request this, you can safely ignore this email — your password won't change.`
    ].join('\n'),
    html: `
      <p>${greeting}</p>
      <p>We received a request to reset your password. Click the button below to choose a new one. This link expires in <strong>1 hour</strong>.</p>
      <p><a href="${resetLink}" style="display:inline-block;background:#ff6b9d;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Reset password</a></p>
      <p style="color:#666;font-size:12px;">Or copy and paste this link: ${escapeHtml(resetLink)}</p>
      <p style="color:#666;font-size:12px;">If you didn't request this, you can safely ignore this email — your password won't change.</p>
    `
  });
}

async function sendPaymentReceivedToOwner({ booking }) {
  if (!OWNER_EMAIL) return;
  await send({
    to: OWNER_EMAIL,
    subject: `Payment received — booking #${booking.id}`,
    text: [
      `Payment of ${formatMoney(booking.amount_cents)} received for booking #${booking.id}.`,
      '',
      ...bookingSummary(booking),
      `Customer: ${booking.owner_name} <${booking.email}>`
    ].join('\n'),
    html: `
      <p>Payment of <strong>${formatMoney(booking.amount_cents)}</strong> received for booking #${booking.id}.</p>
      ${bookingHtmlBlock(booking)}
      <p><strong>Customer:</strong> ${escapeHtml(booking.owner_name)} &lt;${escapeHtml(booking.email)}&gt;</p>
    `
  });
}

module.exports = {
  setTransport,
  sendMarketingCampaign,
  sendNewBookingToOwner,
  sendBookingReceivedToCustomer,
  sendBookingApprovedToCustomer,
  sendBookingCancelledToCustomer,
  sendPaymentLinkToCustomer,
  sendPaymentReceivedToCustomer,
  sendPaymentReceivedToOwner,
  sendPasswordResetToCustomer
};
