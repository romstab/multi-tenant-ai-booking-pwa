/**
 * POST /api/admin-auth
 * Body: { email, password }  → { token, expiresIn }
 * or    { action: "verify" } with Authorization Bearer → { ok: true }
 *
 * Env: SUPER_ADMIN_EMAIL, SUPER_ADMIN_PASSWORD_HASH, JWT_SECRET
 *
 * Password hash: SHA-256 hex of password (simple for student project).
 * Generate hash: node -e "console.log(require('crypto').createHash('sha256').update('YOUR_PASSWORD').digest('hex'))"
 */

const crypto = require('crypto');

function timingSafeEqual(a, b) {
  try {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function b64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function signJwt(payload, secret, expiresInSec) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = Object.assign({}, payload, { iat: now, exp: now + expiresInSec });
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(body));
  const data = h + '.' + p;
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return data + '.' + sig;
}

function verifyJwt(token, secret) {
  if (!token || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const data = parts[0] + '.' + parts[1];
  const expected = crypto.createHmac('sha256', secret).update(data).digest('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  if (!timingSafeEqual(expected, parts[2])) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const email = process.env.SUPER_ADMIN_EMAIL;
  const passHash = process.env.SUPER_ADMIN_PASSWORD_HASH;
  const jwtSecret = process.env.JWT_SECRET;

  if (!email || !passHash || !jwtSecret) {
    return res.status(500).json({
      error: 'Super Admin is not configured. Set SUPER_ADMIN_EMAIL, SUPER_ADMIN_PASSWORD_HASH, JWT_SECRET on Vercel.'
    });
  }

  try {
    const body = req.body || {};

    // Verify existing token
    if (body.action === 'verify') {
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const payload = verifyJwt(token, jwtSecret);
      if (!payload || payload.role !== 'superadmin') {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      return res.status(200).json({ ok: true, email: payload.email });
    }

    // Login
    const inputEmail = String(body.email || '').trim().toLowerCase();
    const inputPass = String(body.password || '');
    if (!inputEmail || !inputPass) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const inputHash = sha256(inputPass);
    if (!timingSafeEqual(inputEmail, String(email).toLowerCase()) || !timingSafeEqual(inputHash, passHash)) {
      // constant-ish delay
      await new Promise((r) => setTimeout(r, 400));
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = signJwt({ role: 'superadmin', email: inputEmail }, jwtSecret, 60 * 60 * 8); // 8h
    return res.status(200).json({ token: token, expiresIn: 28800 });
  } catch (err) {
    console.error('admin-auth', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// Export helpers for admin.js
module.exports.verifyJwt = verifyJwt;
module.exports.sha256 = sha256;
