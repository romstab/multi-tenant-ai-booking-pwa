/**
 * POST /api/admin
 * Authorization: Bearer <JWT from admin-auth>
 * Body: { action, tenantId, ... }
 *
 * Actions: listTenants | setStatus | extendTrial | extendSubscription | metrics | deleteTenant
 */

const admin = require('firebase-admin');
const crypto = require('crypto');

function initAdmin() {
  if (admin.apps.length) return true;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;
  if (!projectId || !clientEmail || !privateKey) return false;
  privateKey = privateKey.replace(/\\n/g, '\n');
  try {
    admin.initializeApp({
      credential: admin.credential.cert({ projectId, clientEmail, privateKey })
    });
    return true;
  } catch (e) {
    console.error('Admin init', e.message);
    return false;
  }
}

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

function verifyJwt(token, secret) {
  if (!token || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const data = parts[0] + '.' + parts[1];
  const expected = crypto
    .createHmac('sha256', secret)
    .update(data)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  if (!timingSafeEqual(expected, parts[2])) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
    const payload = JSON.parse(json);
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function requireSuperAdmin(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const payload = verifyJwt(token, process.env.JWT_SECRET);
  if (!payload || payload.role !== 'superadmin') return null;
  return payload;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!initAdmin()) {
    return res.status(500).json({ error: 'Firebase Admin not configured' });
  }

  const user = requireSuperAdmin(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const db = admin.firestore();
  const body = req.body || {};
  const action = body.action;

  try {
    if (action === 'listSupportMessages') {
      const snap = await db.collection('platformSupport').orderBy('createdAt', 'desc').limit(50).get();
      const items = [];
      snap.forEach((d) => {
        const x = d.data();
        items.push({
          id: d.id,
          tenantId: x.tenantId || '',
          email: x.email || '',
          businessName: x.businessName || '',
          message: x.message || '',
          status: x.status || 'open',
          createdAt: x.createdAt && x.createdAt.toDate ? x.createdAt.toDate().toISOString() : null
        });
      });
      return res.status(200).json({ items });
    }

    if (action === 'resolveSupport') {
      const id = body.id;
      if (!id) return res.status(400).json({ error: 'id required' });
      await db.doc('platformSupport/' + id).set({ status: 'resolved', resolvedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      return res.status(200).json({ success: true });
    }

    if (action === 'listTenants') {
      const snap = await db.collection('platformTenants').orderBy('createdAt', 'desc').limit(200).get();
      const tenants = [];
      snap.forEach((d) => tenants.push(Object.assign({ tenantId: d.id }, d.data())));
      // serialize timestamps
      tenants.forEach((t) => {
        ['trialStart', 'trialEnd', 'subscriptionEnd', 'createdAt', 'updatedAt'].forEach((k) => {
          if (t[k] && t[k].toDate) t[k] = t[k].toDate().toISOString();
        });
      });
      return res.status(200).json({ tenants });
    }

    if (action === 'metrics') {
      const snap = await db.collection('platformTenants').get();
      let total = 0, active = 0, trial = 0, suspended = 0, expired = 0, bookings = 0, revenue = 0;
      snap.forEach((d) => {
        const t = d.data();
        total++;
        if (t.status === 'active') active++;
        else if (t.status === 'trial') trial++;
        else if (t.status === 'suspended') suspended++;
        else if (t.status === 'expired') expired++;
        bookings += Number(t.totalBookings || 0);
        revenue += Number(t.estimatedRevenue || 0);
      });
      return res.status(200).json({
        total, active, trial, suspended, expired,
        totalBookings: bookings,
        estimatedRevenue: revenue,
        note: 'Revenue is sum of service prices on confirmed bookings (not verified payments).'
      });
    }

    if (action === 'setStatus') {
      const tenantId = body.tenantId;
      const status = body.status;
      const allowed = ['trial', 'active', 'suspended', 'expired'];
      if (!tenantId || !allowed.includes(status)) {
        return res.status(400).json({ error: 'Invalid tenantId or status' });
      }
      await db.doc('platformTenants/' + tenantId).set(
        { status, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
      return res.status(200).json({ ok: true, tenantId, status });
    }

    if (action === 'extendTrial') {
      const tenantId = body.tenantId;
      const days = Math.min(Math.max(parseInt(body.days, 10) || 14, 1), 365);
      if (!tenantId) return res.status(400).json({ error: 'tenantId required' });
      const ref = db.doc('platformTenants/' + tenantId);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: 'Tenant not found' });
      const data = snap.data();
      let base = new Date();
      if (data.trialEnd && data.trialEnd.toDate) {
        const te = data.trialEnd.toDate();
        if (te > base) base = te;
      }
      base.setDate(base.getDate() + days);
      await ref.set(
        {
          status: 'trial',
          trialEnd: admin.firestore.Timestamp.fromDate(base),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );
      return res.status(200).json({ ok: true, trialEnd: base.toISOString() });
    }

    if (action === 'extendSubscription') {
      const tenantId = body.tenantId;
      const days = Math.min(Math.max(parseInt(body.days, 10) || 30, 1), 730);
      if (!tenantId) return res.status(400).json({ error: 'tenantId required' });
      const ref = db.doc('platformTenants/' + tenantId);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: 'Tenant not found' });
      const data = snap.data();
      let base = new Date();
      if (data.subscriptionEnd && data.subscriptionEnd.toDate) {
        const se = data.subscriptionEnd.toDate();
        if (se > base) base = se;
      }
      base.setDate(base.getDate() + days);
      await ref.set(
        {
          status: 'active',
          subscriptionEnd: admin.firestore.Timestamp.fromDate(base),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );
      return res.status(200).json({ ok: true, subscriptionEnd: base.toISOString() });
    }

    if (action === 'deleteTenant') {
      const tenantId = body.tenantId;
      if (!tenantId) return res.status(400).json({ error: 'tenantId required' });
      // Soft-delete: mark deleted, do not wipe Firestore tenant data (safer)
      await db.doc('platformTenants/' + tenantId).set(
        {
          status: 'suspended',
          deleted: true,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );
      return res.status(200).json({ ok: true, note: 'Tenant suspended and marked deleted. Firestore business data retained.' });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('admin', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
