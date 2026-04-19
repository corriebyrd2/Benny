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
  if (!configured) {
    console.log(`[email] skipped (SendGrid not configured): ${subject} → ${to}`);
    return;
  }
  if (!to) {
    console.warn(`[email] skipped (no recipient): ${subject}`);
    return;
  }
  try {
    await sgMail.send({
      to,
      from: { email: FROM_EMAIL, name: FROM_NAME },
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
  sendNewBookingToOwner,
  sendBookingReceivedToCustomer,
  sendBookingApprovedToCustomer,
  sendBookingCancelledToCustomer,
  sendPaymentLinkToCustomer,
  sendPaymentReceivedToCustomer,
  sendPaymentReceivedToOwner
};
