/**
 * Vercel Serverless Function — Secure Booking + Slot Preview
 * ----------------------------------------------------------
 * POST /api/create-booking
 *
 * Actions:
 *   { action: "getSlots", tenantId, serviceId, date }
 *   { action: "create", tenantId, serviceId, date, startTime, endTime, customerName, customerEmail, ... }
 *
 * Uses Firebase Admin SDK for privileged reads/writes and transactions.
 *
 * Required environment variables on Vercel:
 *   FIREBASE_PROJECT_ID
 *   FIREBASE_CLIENT_EMAIL
 *   FIREBASE_PRIVATE_KEY   (replace \n with real newlines or keep escaped)
 *
 * How to get them:
 *   Firebase Console → Project Settings → Service accounts → Generate new private key
 *   Use the project_id, client_email, and private_key fields.
 */

import admin from 'firebase-admin';

// Initialize Admin once (warm container reuse)
if (!admin.apps.length) {
  try {
    const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey
      })
    });
  } catch (e) {
    console.error('Firebase Admin init failed', e.message);
  }
}

const db = () => admin.firestore();

function timeToMinutes(t) {
  if (!t) return 0;
  const [h, m] = String(t).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function minutesToTime(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function getWeekdayKey(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  return days[d.getDay()];
}

function hasConflict(reqStart, reqEnd, existStart, existEnd) {
  return reqStart < existEnd && reqEnd > existStart;
}

function generateSlots(date, durationMinutes, operatingHours, appointments, slotInterval = 30) {
  const weekday = getWeekdayKey(date);
  const day = operatingHours?.[weekday];
  if (!day || !day.enabled || !day.open || !day.close) return [];

  const openMin = timeToMinutes(day.open);
  const closeMin = timeToMinutes(day.close);
  if (closeMin <= openMin) return [];

  const onDay = (appointments || []).filter(a => a.date === date && a.status !== 'cancelled');
  const slots = [];

  for (let start = openMin; start + durationMinutes <= closeMin; start += slotInterval) {
    const end = start + durationMinutes;
    let conflict = false;
    for (const a of onDay) {
      if (hasConflict(start, end, timeToMinutes(a.startTime), timeToMinutes(a.endTime))) {
        conflict = true;
        break;
      }
    }
    if (!conflict) {
      slots.push({ startTime: minutesToTime(start), endTime: minutesToTime(end) });
    }
  }
  return slots;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Guard: Admin must be configured
  if (!admin.apps.length) {
    return res.status(500).json({
      error: 'Server booking is not configured. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY on Vercel.'
    });
  }

  try {
    const body = req.body || {};
    const action = body.action || 'create';

    if (action === 'getSlots') {
      return await handleGetSlots(body, res);
    }
    if (action === 'create') {
      return await handleCreate(body, res);
    }
    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('create-booking error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function handleGetSlots(body, res) {
  const { tenantId, serviceId, date } = body;
  if (!tenantId || !serviceId || !date) {
    return res.status(400).json({ error: 'tenantId, serviceId, and date are required' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid date format' });
  }

  const settingsSnap = await db().doc(`tenants/${tenantId}/settings/config`).get();
  if (!settingsSnap.exists) {
    return res.status(404).json({ error: 'Business not found' });
  }
  const settings = settingsSnap.data();

  const serviceSnap = await db().doc(`tenants/${tenantId}/services/${serviceId}`).get();
  if (!serviceSnap.exists || serviceSnap.data().active === false) {
    return res.status(404).json({ error: 'Service not found or inactive' });
  }
  const service = serviceSnap.data();
  const duration = service.duration || 30;

  // Load appointments for that date only
  const apptSnap = await db()
    .collection(`tenants/${tenantId}/appointments`)
    .where('date', '==', date)
    .get();

  const appointments = [];
  apptSnap.forEach(d => appointments.push(d.data()));

  const slots = generateSlots(date, duration, settings.operatingHours || {}, appointments);
  return res.status(200).json({ slots });
}

async function handleCreate(body, res) {
  const {
    tenantId,
    serviceId,
    date,
    startTime,
    endTime,
    customerName,
    customerEmail,
    customerPhone = '',
    notes = ''
  } = body;

  if (!tenantId || !serviceId || !date || !startTime || !endTime || !customerName || !customerEmail) {
    return res.status(400).json({ error: 'Missing required booking fields' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid date' });
  }
  if (customerName.length > 120 || customerEmail.length > 200) {
    return res.status(400).json({ error: 'Invalid input length' });
  }

  const settingsRef = db().doc(`tenants/${tenantId}/settings/config`);
  const serviceRef = db().doc(`tenants/${tenantId}/services/${serviceId}`);
  const appointmentsCol = db().collection(`tenants/${tenantId}/appointments`);

  // Transaction: re-check conflicts and write atomically
  const result = await db().runTransaction(async (tx) => {
    const [settingsSnap, serviceSnap] = await Promise.all([
      tx.get(settingsRef),
      tx.get(serviceRef)
    ]);

    if (!settingsSnap.exists) throw Object.assign(new Error('Business not found'), { status: 404 });
    if (!serviceSnap.exists || serviceSnap.data().active === false) {
      throw Object.assign(new Error('Service not found or inactive'), { status: 404 });
    }

    const settings = settingsSnap.data();
    const service = serviceSnap.data();
    const duration = service.duration || 30;

    // Verify endTime matches duration (or recompute)
    const startMin = timeToMinutes(startTime);
    const expectedEnd = minutesToTime(startMin + duration);
    const finalEnd = endTime || expectedEnd;

    // Operating hours check
    const weekday = getWeekdayKey(date);
    const day = settings.operatingHours?.[weekday];
    if (!day || !day.enabled) {
      throw Object.assign(new Error('Business is closed on this day'), { status: 400 });
    }
    const openMin = timeToMinutes(day.open);
    const closeMin = timeToMinutes(day.close);
    if (startMin < openMin || timeToMinutes(finalEnd) > closeMin) {
      throw Object.assign(new Error('Selected time is outside operating hours'), { status: 400 });
    }

    // Load same-day appointments inside transaction
    // Note: Firestore transactions require all reads before writes.
    // We use a query; for strong consistency on high concurrency consider a different design.
    const apptQuery = appointmentsCol.where('date', '==', date);
    const apptSnap = await tx.get(apptQuery);

    const appointments = [];
    apptSnap.forEach(d => appointments.push(d.data()));

    const reqEndMin = timeToMinutes(finalEnd);
    for (const a of appointments) {
      if (a.status === 'cancelled') continue;
      if (hasConflict(startMin, reqEndMin, timeToMinutes(a.startTime), timeToMinutes(a.endTime))) {
        throw Object.assign(new Error('This time slot is no longer available'), { status: 409 });
      }
    }

    const newRef = appointmentsCol.doc();
    const appointment = {
      customerName: String(customerName).trim(),
      customerEmail: String(customerEmail).trim().toLowerCase(),
      customerPhone: String(customerPhone || '').trim(),
      notes: String(notes || '').trim().slice(0, 500),
      serviceId,
      serviceName: service.name || '',
      serviceDuration: duration,
      date,
      startTime,
      endTime: finalEnd,
      status: 'confirmed',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    tx.set(newRef, appointment);
    return { id: newRef.id, ...appointment };
  });

  return res.status(201).json({
    success: true,
    appointmentId: result.id,
    message: 'Booking confirmed'
  });
}
