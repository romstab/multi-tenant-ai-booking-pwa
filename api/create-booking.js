/**
 * POST /api/create-booking
 * Actions: getSlots | create | resolveHandle
 */

const admin = require('firebase-admin');

function initAdmin() {
  if (admin.apps.length) return true;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;
  if (!projectId || !clientEmail || !privateKey) {
    console.error('Missing Firebase Admin env');
    return false;
  }
  privateKey = privateKey.replace(/\\n/g, '\n');
  try {
    admin.initializeApp({
      credential: admin.credential.cert({ projectId, clientEmail, privateKey })
    });
    return true;
  } catch (e) {
    console.error('Firebase Admin init failed:', e.message);
    return false;
  }
}

function timeToMinutes(t) {
  if (!t) return 0;
  const [h, m] = String(t).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function minutesToTime(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

function getWeekdayKey(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  return days[d.getDay()];
}

function hasConflict(reqStart, reqEnd, existStart, existEnd) {
  return reqStart < existEnd && reqEnd > existStart;
}

function generateSlots(date, durationMinutes, operatingHours, appointments, slotInterval) {
  slotInterval = slotInterval || 30;
  const weekday = getWeekdayKey(date);
  const day = operatingHours && operatingHours[weekday];
  if (!day || !day.enabled || !day.open || !day.close) return [];
  const openMin = timeToMinutes(day.open);
  const closeMin = timeToMinutes(day.close);
  if (closeMin <= openMin) return [];
  const onDay = (appointments || []).filter(function (a) {
    return a.date === date && a.status !== 'cancelled';
  });
  const slots = [];
  for (let start = openMin; start + durationMinutes <= closeMin; start += slotInterval) {
    const end = start + durationMinutes;
    let conflict = false;
    for (let i = 0; i < onDay.length; i++) {
      const a = onDay[i];
      if (hasConflict(start, end, timeToMinutes(a.startTime), timeToMinutes(a.endTime))) {
        conflict = true;
        break;
      }
    }
    if (!conflict) slots.push({ startTime: minutesToTime(start), endTime: minutesToTime(end) });
  }
  return slots;
}

function makeBookingId() {
  const year = new Date().getFullYear();
  const rand = Math.random().toString(36).slice(2, 10).toUpperCase();
  return 'BK-' + year + '-' + rand;
}

async function assertTenantBookable(db, tenantId) {
  const plat = await db.doc('platformTenants/' + tenantId).get();
  if (!plat.exists) {
    // Backward compatible: allow if no platform doc yet
    return { ok: true, status: 'legacy' };
  }
  const p = plat.data();
  if (p.deleted) return { ok: false, error: 'This business is no longer available.' };
  if (p.status === 'suspended') {
    return { ok: false, error: 'This business is temporarily unavailable for bookings.' };
  }
  if (p.status === 'expired') {
    return { ok: false, error: 'This business subscription has expired.' };
  }
  if (p.status === 'trial' && p.trialEnd && p.trialEnd.toDate) {
    if (p.trialEnd.toDate() < new Date()) {
      return { ok: false, error: 'This business trial has expired.' };
    }
  }
  if (p.status === 'active' && p.subscriptionEnd && p.subscriptionEnd.toDate) {
    if (p.subscriptionEnd.toDate() < new Date()) {
      return { ok: false, error: 'This business subscription has expired.' };
    }
  }
  return { ok: true, status: p.status };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!initAdmin()) {
    return res.status(500).json({
      error: 'Server booking not configured. Check Firebase Admin env vars on Vercel.'
    });
  }

  const db = admin.firestore();

  try {
    const body = req.body || {};
    const action = body.action || 'create';

    if (action === 'resolveHandle') {
      const handle = String(body.handle || '').toLowerCase().trim();
      if (!/^[a-z0-9-]{3,40}$/.test(handle)) {
        return res.status(400).json({ error: 'Invalid handle' });
      }
      // Search platformTenants by handle
      const q = await db.collection('platformTenants').where('handle', '==', handle).limit(1).get();
      if (q.empty) return res.status(404).json({ error: 'Business not found' });
      return res.status(200).json({ tenantId: q.docs[0].id });
    }

    if (action === 'registerTenant') {
      // Called after business setup. Body: { idToken, businessName, ownerEmail, handle? }
      const idToken = body.idToken;
      if (!idToken) return res.status(400).json({ error: 'idToken required' });
      let decoded;
      try {
        decoded = await admin.auth().verifyIdToken(idToken);
      } catch (e) {
        return res.status(401).json({ error: 'Invalid auth token' });
      }
      const tenantId = decoded.uid;
      const businessName = String(body.businessName || '').trim() || 'Business';
      const ownerEmail = String(body.ownerEmail || decoded.email || '').trim();
      let handle = String(body.handle || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
      if (handle && handle.length < 3) handle = '';

      if (handle) {
        const existing = await db.collection('platformTenants').where('handle', '==', handle).limit(1).get();
        if (!existing.empty && existing.docs[0].id !== tenantId) {
          return res.status(409).json({ error: 'Handle already taken' });
        }
      }

      const now = new Date();
      const trialEnd = new Date(now);
      trialEnd.setDate(trialEnd.getDate() + 14);

      const ref = db.doc('platformTenants/' + tenantId);
      const snap = await ref.get();
      if (snap.exists) {
        // Update name/email/handle only; keep status
        await ref.set({
          businessName,
          ownerEmail,
          handle: handle || snap.data().handle || null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        return res.status(200).json({ ok: true, existing: true });
      }

      await ref.set({
        tenantId,
        businessName,
        ownerEmail,
        handle: handle || null,
        status: 'trial',
        trialStart: admin.firestore.Timestamp.fromDate(now),
        trialEnd: admin.firestore.Timestamp.fromDate(trialEnd),
        subscriptionEnd: null,
        totalBookings: 0,
        estimatedRevenue: 0,
        deleted: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return res.status(201).json({ ok: true, trialEnd: trialEnd.toISOString() });
    }

    if (action === 'getSlots') {
      const { tenantId, serviceId, date } = body;
      if (!tenantId || !serviceId || !date) {
        return res.status(400).json({ error: 'tenantId, serviceId, and date are required' });
      }
      const bookable = await assertTenantBookable(db, tenantId);
      if (!bookable.ok) return res.status(403).json({ error: bookable.error });

      const settingsSnap = await db.doc('tenants/' + tenantId + '/settings/config').get();
      if (!settingsSnap.exists) return res.status(404).json({ error: 'Business not found' });
      const settings = settingsSnap.data();
      const serviceSnap = await db.doc('tenants/' + tenantId + '/services/' + serviceId).get();
      if (!serviceSnap.exists || serviceSnap.data().active === false) {
        return res.status(404).json({ error: 'Service not found or inactive' });
      }
      const duration = serviceSnap.data().duration || 30;
      const apptSnap = await db.collection('tenants/' + tenantId + '/appointments').where('date', '==', date).get();
      const appointments = [];
      apptSnap.forEach(function (d) { appointments.push(d.data()); });
      const slots = generateSlots(date, duration, settings.operatingHours || {}, appointments);
      return res.status(200).json({ slots: slots });
    }

    if (action === 'create') {
      const tenantId = body.tenantId;
      const serviceId = body.serviceId;
      const date = body.date;
      const startTime = body.startTime;
      const endTime = body.endTime;
      const customerName = body.customerName;
      const customerEmail = body.customerEmail;
      const customerPhone = body.customerPhone || '';
      const notes = body.notes || '';
      const paymentRef = body.paymentRef || '';
      const depositAmount = body.depositAmount != null ? Number(body.depositAmount) : null;

      if (!tenantId || !serviceId || !date || !startTime || !customerName || !customerEmail) {
        return res.status(400).json({ error: 'Missing required booking fields' });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: 'Invalid date' });
      }

      const bookable = await assertTenantBookable(db, tenantId);
      if (!bookable.ok) return res.status(403).json({ error: bookable.error });

      const settingsSnap = await db.doc('tenants/' + tenantId + '/settings/config').get();
      if (!settingsSnap.exists) return res.status(404).json({ error: 'Business not found' });
      const settings = settingsSnap.data();

      const serviceSnap = await db.doc('tenants/' + tenantId + '/services/' + serviceId).get();
      if (!serviceSnap.exists || serviceSnap.data().active === false) {
        return res.status(404).json({ error: 'Service not found or inactive' });
      }
      const service = serviceSnap.data();
      const duration = service.duration || 30;
      const price = Number(service.price || 0);

      const startMin = timeToMinutes(startTime);
      const finalEnd = endTime || minutesToTime(startMin + duration);
      const reqEndMin = timeToMinutes(finalEnd);

      const weekday = getWeekdayKey(date);
      const day = settings.operatingHours && settings.operatingHours[weekday];
      if (!day || !day.enabled) {
        return res.status(400).json({ error: 'Business is closed on this day' });
      }
      if (startMin < timeToMinutes(day.open) || reqEndMin > timeToMinutes(day.close)) {
        return res.status(400).json({ error: 'Selected time is outside operating hours' });
      }

      const apptSnap = await db.collection('tenants/' + tenantId + '/appointments').where('date', '==', date).get();
      const appointments = [];
      apptSnap.forEach(function (d) { appointments.push(d.data()); });
      for (let i = 0; i < appointments.length; i++) {
        const a = appointments[i];
        if (a.status === 'cancelled') continue;
        if (hasConflict(startMin, reqEndMin, timeToMinutes(a.startTime), timeToMinutes(a.endTime))) {
          return res.status(409).json({ error: 'This time slot is no longer available' });
        }
      }

      const depositSettings = settings.depositSettings || { enabled: false };
      let depositStatus = 'none';
      if (depositSettings.enabled) {
        if (depositSettings.required && !paymentRef) {
          return res.status(400).json({ error: 'Payment reference is required for this service deposit.' });
        }
        depositStatus = paymentRef ? 'pending_verification' : 'pending';
      }

      const bookingId = makeBookingId();
      const appointment = {
        bookingId,
        customerName: String(customerName).trim(),
        customerEmail: String(customerEmail).trim().toLowerCase(),
        customerPhone: String(customerPhone).trim(),
        notes: String(notes).trim().slice(0, 500),
        serviceId,
        serviceName: service.name || '',
        serviceDuration: duration,
        servicePrice: price,
        date,
        startTime,
        endTime: finalEnd,
        status: depositSettings.enabled && depositSettings.required ? 'pending_verification' : 'confirmed',
        depositStatus,
        paymentRef: String(paymentRef).trim().slice(0, 120),
        depositAmount: depositAmount,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      };

      const newRef = await db.collection('tenants/' + tenantId + '/appointments').add(appointment);

      // Update platform stats (best-effort)
      try {
        await db.doc('platformTenants/' + tenantId).set(
          {
            totalBookings: admin.firestore.FieldValue.increment(1),
            estimatedRevenue: admin.firestore.FieldValue.increment(price),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          },
          { merge: true }
        );
      } catch (e) {
        console.warn('platform stats update failed', e.message);
      }

      return res.status(201).json({
        success: true,
        appointmentId: newRef.id,
        bookingId,
        status: appointment.status,
        message: 'Booking recorded'
      });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('create-booking error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
