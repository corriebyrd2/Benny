const sgMail = require('@sendgrid/mail');

const API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL;
const FROM_NAME = process.env.SENDGRID_FROM_NAME || 'Benny and the Pets';
const OWNER_EMAIL = process.env.OWNER_NOTIFICATION_EMAIL || process.env.ADMIN_EMAIL;
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const MARKETING_LIST_IDS = (process.env.SENDGRID_MARKETING_LIST_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const MARKETING_SENDER_ID = process.env.SENDGRID_MARKETING_SENDER_ID || '';

let configured = false;
if (API_KEY && FROM_EMAIL) {
  sgMail.setApiKey(API_KEY);
  configured = true;
} else {
  console.warn('[email] SendGrid not configured — notifications will be skipped. Set SENDGRID_API_KEY and SENDGRID_FROM_EMAIL.');
}

// Marketing Contacts uses the v3 API directly (separate from Mail Send) and
// requires the API key to have the "Marketing" permission. It also needs at
// least one list id if new subscribers should land on a specific list — a
// blank SENDGRID_MARKETING_LIST_IDS still uploads contacts to the All Contacts
// pool but leaves them unattached, which is the usual cause of "I subscribed
// but my email isn't on the list" reports.
if (API_KEY && MARKETING_LIST_IDS.length === 0) {
  console.warn('[email] SENDGRID_MARKETING_LIST_IDS is empty — new subscribers will be added to All Contacts but NOT to any marketing list (e.g. "Join the Pack"). Set SENDGRID_MARKETING_LIST_IDS to the list UUID(s).');
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

// Marketing Contacts transport is separate because it hits a different SendGrid
// API (v3/marketing/contacts, not the Mail Send API). Tests override via
// setMarketingTransport().
async function sgFetch(path, { method, body } = {}) {
  const res = await fetch(`https://api.sendgrid.com${path}`, {
    method: method || 'GET',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const err = new Error(`SendGrid ${res.status} ${path}: ${text.slice(0, 500)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return text ? JSON.parse(text) : {};
}

let marketingTransport = {
  async addContact({ email, listIds }) {
    if (!API_KEY) return { status: 'skipped', reason: 'not_configured' };
    const result = await sgFetch('/v3/marketing/contacts', {
      method: 'PUT',
      body: {
        list_ids: listIds && listIds.length ? listIds : undefined,
        contacts: [{ email }]
      }
    });
    return {
      status: 'accepted',
      jobId: result.job_id || null,
      listIds: listIds && listIds.length ? listIds : [],
      attachedToList: Boolean(listIds && listIds.length)
    };
  },

  // Creates a SingleSend and schedules it to go out immediately. Returns the
  // SendGrid singlesend id so admins can follow up in mc.sendgrid.com.
  async sendCampaign({ name, subject, html, plain, listIds, senderId }) {
    if (!API_KEY) return { status: 'skipped', reason: 'not_configured' };
    if (!senderId) throw new Error('SENDGRID_MARKETING_SENDER_ID is not set');
    if (!listIds || !listIds.length) throw new Error('At least one list id is required');

    const created = await sgFetch('/v3/marketing/singlesends', {
      method: 'POST',
      body: {
        name,
        send_to: { list_ids: listIds },
        email_config: {
          subject,
          html_content: html,
          plain_content: plain || undefined,
          sender_id: Number(senderId),
          suppression_group_id: null
        }
      }
    });
    await sgFetch(`/v3/marketing/singlesends/${created.id}/schedule`, {
      method: 'PUT',
      body: { send_at: 'now' }
    });
    return { status: 'scheduled', id: created.id };
  }
};

function setMarketingTransport(t) {
  marketingTransport = t;
}

async function addMarketingContact({ email }) {
  try {
    const result = await marketingTransport.addContact({
      email,
      listIds: MARKETING_LIST_IDS
    });
    if (result.status === 'accepted' && !result.attachedToList) {
      console.warn('[email] marketing contact accepted but no list attached (SENDGRID_MARKETING_LIST_IDS is empty):', email);
    }
    return result;
  } catch (err) {
    console.error('[email] marketing contact sync failed:', email, '→', err.status || '', err.message);
    return { status: 'failed', error: err.message };
  }
}

async function sendMarketingCampaign({ name, subject, html, plain, listIds }) {
  const lists = listIds && listIds.length ? listIds : MARKETING_LIST_IDS;
  return marketingTransport.sendCampaign({
    name,
    subject,
    html,
    plain,
    listIds: lists,
    senderId: MARKETING_SENDER_ID
  });
}

function formatMoney(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
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
  try {
    await transport.send({
      to,
      from: { email: FROM_EMAIL || 'noreply@example.test', name: FROM_NAME },
      subject,
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
  setMarketingTransport,
  addMarketingContact,
  sendMarketingCampaign,
  sendNewBookingToOwner,
  sendBookingReceivedToCustomer,
  sendBookingApprovedToCustomer,
  sendBookingCancelledToCustomer,
  sendPaymentLinkToCustomer,
  sendPaymentReceivedToCustomer,
  sendPaymentReceivedToOwner
};
