/**
 * POST /api/sms
 * Optional SMS abstraction (Twilio or Semaphore)
 * Body: { provider, to, message, tenantId }
 * Requires Authorization only if you later add admin JWT — currently server-only from other functions.
 *
 * Env (optional):
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER
 *   SEMAPHORE_API_KEY, SEMAPHORE_SENDER
 *
 * This endpoint is NOT publicly useful without a secret; protect with a simple SMS_API_SECRET header.
 */

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-SMS-Secret');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = process.env.SMS_API_SECRET;
  if (secret) {
    if (req.headers['x-sms-secret'] !== secret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  } else {
    return res.status(503).json({
      error: 'SMS not configured. Set SMS_API_SECRET and provider credentials on Vercel.'
    });
  }

  const body = req.body || {};
  const provider = (body.provider || 'twilio').toLowerCase();
  const to = String(body.to || '').trim();
  const message = String(body.message || '').trim().slice(0, 500);

  if (!to || !message) {
    return res.status(400).json({ error: 'to and message required' });
  }

  try {
    if (provider === 'twilio') {
      const sid = process.env.TWILIO_ACCOUNT_SID;
      const token = process.env.TWILIO_AUTH_TOKEN;
      const from = process.env.TWILIO_PHONE_NUMBER;
      if (!sid || !token || !from) {
        return res.status(503).json({ error: 'Twilio credentials not set' });
      }
      const auth = Buffer.from(sid + ':' + token).toString('base64');
      const params = new URLSearchParams({ To: to, From: from, Body: message });
      const r = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + sid + '/Messages.json', {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + auth,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params.toString()
      });
      const data = await r.json();
      if (!r.ok) return res.status(502).json({ error: data.message || 'Twilio error' });
      return res.status(200).json({ ok: true, provider: 'twilio', sid: data.sid });
    }

    if (provider === 'semaphore') {
      const apiKey = process.env.SEMAPHORE_API_KEY;
      const sender = process.env.SEMAPHORE_SENDER || 'BOOKAI';
      if (!apiKey) return res.status(503).json({ error: 'Semaphore API key not set' });
      const r = await fetch('https://api.semaphore.co/api/v4/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apikey: apiKey, number: to, message: message, sendername: sender })
      });
      const data = await r.json();
      if (!r.ok) return res.status(502).json({ error: 'Semaphore error', detail: data });
      return res.status(200).json({ ok: true, provider: 'semaphore', result: data });
    }

    return res.status(400).json({ error: 'Unknown provider' });
  } catch (err) {
    console.error('sms', err);
    return res.status(500).json({ error: err.message || 'SMS failed' });
  }
};
