/**
 * Nodemailer transport for RST Booking System emails.
 * Credentials ONLY from server env: EMAIL_USER, EMAIL_PASS.
 * Never import this file from frontend code.
 */

const nodemailer = require('nodemailer');

let transporter = null;

function isEmailConfigured() {
  return !!(process.env.EMAIL_USER && process.env.EMAIL_PASS);
}

function getTransporter() {
  if (transporter) return transporter;
  if (!isEmailConfigured()) return null;
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    }
  });
  return transporter;
}

/**
 * @returns {{ ok: boolean, messageId?: string, error?: string, skipped?: boolean }}
 */
async function sendMail({ to, subject, html, text }) {
  const tx = getTransporter();
  if (!tx) {
    return {
      ok: false,
      skipped: true,
      error: 'Email not configured (set EMAIL_USER and EMAIL_PASS)'
    };
  }
  try {
    const info = await tx.sendMail({
      from: `"RST Booking System" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      html,
      text: text || undefined
    });
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    console.error('[emailService]', err && err.message ? err.message : err);
    return { ok: false, error: 'Failed to send email' };
  }
}

module.exports = {
  isEmailConfigured,
  sendMail
};
