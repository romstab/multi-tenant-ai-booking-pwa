function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildBookingReminderEmail({ tenant, booking }) {
  const biz = tenant.businessName || tenant.name || 'Business';
  const ref = booking.bookingRef || booking.bookingReference || '';
  const service = booking.serviceName || '';

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f1f5f9;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:520px;background:#ffffff;border-radius:12px;border:1px solid #e2e8f0;">
        <tr><td style="background:#0f766e;padding:20px 24px;">
          <p style="margin:0;color:#99f6e4;font-size:12px;">REMINDER</p>
          <h1 style="margin:6px 0 0;color:#fff;font-size:20px;">Your appointment is soon</h1>
        </td></tr>
        <tr><td style="padding:24px;">
          <p style="margin:0 0 12px;font-size:15px;color:#0f172a;">Hi ${esc(booking.customerName)},</p>
          <p style="margin:0 0 16px;font-size:14px;color:#475569;line-height:1.5;">
            Reminder: your booking with <strong>${esc(biz)}</strong> starts in about <strong>5 minutes</strong>.
          </p>
          <div style="background:#f0fdfa;border:1px solid #99f6e4;border-radius:8px;padding:14px 16px;">
            <p style="margin:0;font-size:14px;color:#0f766e;">
              <strong>${esc(booking.date)}</strong> at <strong>${esc(booking.startTime)}</strong>
            </p>
            ${service ? `<p style="margin:6px 0 0;font-size:13px;color:#334155;">${esc(service)}</p>` : ''}
            <p style="margin:8px 0 0;font-size:12px;color:#64748b;">Ref: ${esc(ref)}</p>
          </div>
        </td></tr>
        <tr><td style="padding:16px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;">
          <p style="margin:0;font-size:12px;color:#94a3b8;text-align:center;">RST Booking System</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text =
    `Reminder: ${biz} on ${booking.date} at ${booking.startTime}\n` +
    `Reference: ${ref}\n`;

  return {
    subject: `Reminder — ${biz} at ${booking.startTime} (${ref})`,
    html,
    text
  };
}

module.exports = { buildBookingReminderEmail };
