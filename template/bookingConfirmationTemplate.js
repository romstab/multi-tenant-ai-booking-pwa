function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {{ tenant: object, booking: object }} args
 */
function buildBookingConfirmationEmail({ tenant, booking }) {
  const biz = tenant.businessName || tenant.name || 'Business';
  const cat = tenant.category || booking.businessCategory || '';
  const ref = booking.bookingRef || booking.bookingReference || '';
  const service = booking.serviceName || '';
  const staff = booking.staffName || '';
  const notes = booking.notes
    ? `<p style="margin:12px 0 0;font-size:14px;color:#334155;"><strong>Notes:</strong> ${esc(booking.notes)}</p>`
    : '';
  const contactBits = [];
  if (tenant.email || tenant.businessEmail) contactBits.push(esc(tenant.email || tenant.businessEmail));
  if (tenant.phone || tenant.businessPhone) contactBits.push(esc(tenant.phone || tenant.businessPhone));

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f1f5f9;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">
        <tr><td style="background:#0f172a;padding:20px 24px;">
          <p style="margin:0;color:#94a3b8;font-size:12px;letter-spacing:0.04em;">RST BOOKING SYSTEM</p>
          <h1 style="margin:6px 0 0;color:#fff;font-size:20px;font-weight:700;">Booking Confirmation</h1>
        </td></tr>
        <tr><td style="padding:24px;">
          <p style="margin:0 0 12px;font-size:15px;color:#0f172a;">Hi ${esc(booking.customerName)},</p>
          <p style="margin:0 0 16px;font-size:14px;color:#475569;line-height:1.5;">
            Your booking with <strong>${esc(biz)}</strong> is confirmed.
          </p>
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px;margin-bottom:16px;">
            <p style="margin:0;font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:0.04em;">Booking reference</p>
            <p style="margin:4px 0 0;font-size:18px;font-weight:700;color:#0f172a;font-family:ui-monospace,monospace;">${esc(ref)}</p>
          </div>
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
            <tr><td style="padding:6px 0;color:#64748b;font-size:14px;">Business</td>
                <td style="padding:6px 0;font-size:14px;color:#0f172a;">${esc(biz)}</td></tr>
            ${cat ? `<tr><td style="padding:6px 0;color:#64748b;font-size:14px;">Category</td>
                <td style="padding:6px 0;font-size:14px;color:#0f172a;">${esc(cat)}</td></tr>` : ''}
            ${service ? `<tr><td style="padding:6px 0;color:#64748b;font-size:14px;">Service</td>
                <td style="padding:6px 0;font-size:14px;color:#0f172a;">${esc(service)}</td></tr>` : ''}
            ${staff ? `<tr><td style="padding:6px 0;color:#64748b;font-size:14px;">Staff</td>
                <td style="padding:6px 0;font-size:14px;color:#0f172a;">${esc(staff)}</td></tr>` : ''}
            <tr><td style="padding:6px 0;color:#64748b;font-size:14px;">Date</td>
                <td style="padding:6px 0;font-size:14px;color:#0f172a;">${esc(booking.date)}</td></tr>
            <tr><td style="padding:6px 0;color:#64748b;font-size:14px;">Time</td>
                <td style="padding:6px 0;font-size:14px;color:#0f172a;">${esc(booking.startTime)}${booking.endTime ? ' – ' + esc(booking.endTime) : ''}</td></tr>
          </table>
          ${notes}
          ${contactBits.length ? `<p style="margin:16px 0 0;font-size:13px;color:#64748b;">Contact: ${contactBits.join(' · ')}</p>` : ''}
          <p style="margin:16px 0 0;font-size:13px;color:#64748b;line-height:1.5;">
            You may receive a reminder shortly before your appointment.
            Use your manage link if the business provided one to cancel or reschedule.
          </p>
        </td></tr>
        <tr><td style="padding:16px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;">
          <p style="margin:0;font-size:12px;color:#94a3b8;text-align:center;">RST Booking System · Automated message</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text =
    `Booking Confirmation — ${biz}\n` +
    `Reference: ${ref}\n` +
    `Customer: ${booking.customerName}\n` +
    (service ? `Service: ${service}\n` : '') +
    `Date: ${booking.date}\n` +
    `Time: ${booking.startTime}\n`;

  return {
    subject: `Booking Confirmation — ${biz} (${ref})`,
    html,
    text
  };
}

module.exports = { buildBookingConfirmationEmail };
