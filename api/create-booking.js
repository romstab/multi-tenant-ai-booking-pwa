/**
 * Vercel Serverless — Secure Booking + Slot Preview (CommonJS for Vercel)
 * POST /api/create-booking
 *
 * Env vars required:
 *   FIREBASE_PROJECT_ID
 *   FIREBASE_CLIENT_EMAIL
 *   FIREBASE_PRIVATE_KEY
 */

const admin = require('firebase-admin');

function initAdmin() {
  if (admin.apps.length) return true;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    console.error('Missing Firebase Admin env vars', {
      hasProjectId: !!projectId,
      hasClientEmail: !!clientEmail,
      hasPrivateKey: !!privateKey
    });
    return false;
  }

  // Fix escaped newlines from Vercel env
  privateKey = privateKey.replace(/\\n/g, '\n');

  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        clientEmail,
        privateKey
      })
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
    if (!conflict) {
      slots.push({ startTime: minutesToTime(start), endTime: minutesToTime(end) });
    }
  }
  return slots;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!initAdmin()) {
    return res.status(500).json({
      error: 'Server booking not configured. Check FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY on Vercel, then Redeploy.'
    });
  }

  const db = admin.firestore();

  try {
    const body = req.body || {};
    const action = body.action || 'create';

    if (action === 'getSlots') {
      return await handleGetSlots(db, body, res);
    }
    if (action === 'create') {
      return await handleCreate(db, body, res);
    }
    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('create-booking error:', err);
    return res.status(err.status || 500).json({
      error: err.message || 'Internal server error'
    });
  }
};

async function handleGetSlots(db, body, res) {
  const tenantId = body.tenantId;
  const serviceId = body.serviceId;
  const date = body.date;

  if (!tenantId || !serviceId || !date) {
    return res.status(400).json({ error: 'tenantId, serviceId, and date are required' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid date format' });
  }

  const settingsSnap = await db.doc('tenants/' + tenantId + '/settings/config').get();
  if (!settingsSnap.exists) {
    return res.status(404).json({ error: 'Business not found' });
  }
  const settings = settingsSnap.data();

  const serviceSnap = await db.doc('tenants/' + tenantId + '/services/' + serviceId).get();
  if (!serviceSnap.exists || serviceSnap.data().active === false) {
    return res.status(404).json({ error: 'Service not found or inactive' });
  }
  const service = serviceSnap.data();
  const duration = service.duration || 30;

  const apptSnap = await db
    .collection('tenants/' + tenantId + '/appointments')
    .where('date', '==', date)
    .get();

  const appointments = [];
  apptSnap.forEach(function (d) {
    appointments.push(d.data());
  });

  const slots = generateSlots(date, duration, settings.operatingHours || {}, appointments);
  return res.status(200).json({ slots: slots });
}

async function handleCreate(db, body, res) {
  const tenantId = body.tenantId;
  const serviceId = body.serviceId;
  const date = body.date;
  const startTime = body.startTime;
  const endTime = body.endTime;
  const customerName = body.customerName;
  const customerEmail = body.customerEmail;
  const customerPhone = body.customerPhone || '';
  const notes = body.notes || '';

  if (!tenantId || !serviceId || !date || !startTime || !customerName || !customerEmail) {
    return res.status(400).json({ error: 'Missing required booking fields' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid date' });
  }

  const settingsRef = db.doc('tenants/' + tenantId + '/settings/config');
  const serviceRef = db.doc('tenants/' + tenantId + '/services/' + serviceId);
  const appointmentsCol = db.collection('tenants/' + tenantId + '/appointments');

  const settingsSnap = await settingsRef.get();
  if (!settingsSnap.exists) {
    return res.status(404).json({ error: 'Business not found' });
  }
  const settings = settingsSnap.data();

  const serviceSnap = await serviceRef.get();
  if (!serviceSnap.exists || serviceSnap.data().active === false) {
    return res.status(404).json({ error: 'Service not found or inactive' });
  }
  const service = serviceSnap.data();
  const duration = service.duration || 30;

  const startMin = timeToMinutes(startTime);
  const finalEnd = endTime || minutesToTime(startMin + duration);
  const reqEndMin = timeToMinutes(finalEnd);

  const weekday = getWeekdayKey(date);
  const day = settings.operatingHours && settings.operatingHours[weekday];
  if (!day || !day.enabled) {
    return res.status(400).json({ error: 'Business is closed on this day' });
  }
  const openMin = timeToMinutes(day.open);
  const closeMin = timeToMinutes(day.close);
  if (startMin < openMin || reqEndMin > closeMin) {
    return res.status(400).json({ error: 'Selected time is outside operating hours' });
  }

  const apptSnap = await appointmentsCol.where('date', '==', date).get();
  const appointments = [];
  apptSnap.forEach(function (d) {
    appointments.push(d.data());
  });

  for (let i = 0; i < appointments.length; i++) {
    const a = appointments[i];
    if (a.status === 'cancelled') continue;
    if (hasConflict(startMin, reqEndMin, timeToMinutes(a.startTime), timeToMinutes(a.endTime))) {
      return res.status(409).json({ error: 'This time slot is no longer available' });
    }
  }

  const appointment = {
    customerName: String(customerName).trim(),
    customerEmail: String(customerEmail).trim().toLowerCase(),
    customerPhone: String(customerPhone).trim(),
    notes: String(notes).trim().slice(0, 500),
    serviceId: serviceId,
    serviceName: service.name || '',
    serviceDuration: duration,
    date: date,
    startTime: startTime,
    endTime: finalEnd,
    status: 'confirmed',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };

  const newRef = await appointmentsCol.add(appointment);

  return res.status(201).json({
    success: true,
    appointmentId: newRef.id,
    message: 'Booking confirmed'
  });
}
