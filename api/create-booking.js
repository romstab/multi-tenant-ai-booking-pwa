/**
 * POST /api/create-booking
 * Actions:
 *   getSlots | create | resolveHandle | registerTenant
 *   walkIn | blockTime | unblockTime | listBlocked
 *   setEmergencyClosure | updateStatus
 *
 * Server is the authority for conflicts, closure, spam, and status transitions.
 */

const admin = require('firebase-admin');
const crypto = require('crypto');

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
  const parts = String(t).split(':');
  return (parseInt(parts[0], 10) || 0) * 60 + (parseInt(parts[1], 10) || 0);
}

function minutesToTime(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

function getWeekdayKey(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][d.getDay()];
}

/** Inclusive overlap on half-open ranges in minutes */
function hasConflict(reqStart, reqEnd, existStart, existEnd) {
  return reqStart < existEnd && reqEnd > existStart;
}

function makeBookingId() {
  return 'BK-' + new Date().getFullYear() + '-' + Math.random().toString(36).slice(2, 10).toUpperCase();
}

/** Parse business local wall-clock into Date (default Asia/Manila UTC+8). */
function parseBusinessLocalDateTime(dateStr, timeStr, tzOffsetMinutes) {
  const offset = typeof tzOffsetMinutes === 'number' ? tzOffsetMinutes : 480; // +08:00
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = String(timeStr || '00:00').split(':').map(Number);
  // Construct as UTC then subtract offset so the wall clock matches business local
  const utcMs = Date.UTC(y, (mo || 1) - 1, d || 1, h || 0, mi || 0, 0) - offset * 60 * 1000;
  return new Date(utcMs);
}

function sanitizeIdempotencyKey(key) {
  return String(key || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}

function customerIdFromContact(email, phone) {
  const crypto = require('crypto');
  const key = (String(email || '').trim().toLowerCase() || String(phone || '').trim()).slice(0, 120);
  if (!key) return null;
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 28);
}

async function upsertCustomerCreated(db, tenantId, appointment) {
  const cid = customerIdFromContact(appointment.customerEmail, appointment.customerPhone);
  if (!cid) return;
  const ref = db.doc('tenants/' + tenantId + '/customers/' + cid);
  await ref.set({
    name: appointment.customerName || '',
    email: (appointment.customerEmail || '').toLowerCase(),
    phone: appointment.customerPhone || '',
    totalBookings: admin.firestore.FieldValue.increment(1),
    completedBookings: admin.firestore.FieldValue.increment(0),
    cancelledBookings: admin.firestore.FieldValue.increment(0),
    noShowCount: admin.firestore.FieldValue.increment(0),
    totalSpent: admin.firestore.FieldValue.increment(0),
    lastBookingAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
}



function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return req.headers['x-real-ip'] || 'unknown';
}

function hashKey(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 32);
}

/**
 * Rate limit: max N attempts per key per windowMinutes.
 * Stored in platformRateLimits/{key} via Admin SDK.
 */
async function checkRateLimit(db, key, maxAttempts, windowMinutes) {
  const ref = db.doc('platformRateLimits/' + key);
  const now = Date.now();
  const windowMs = windowMinutes * 60 * 1000;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    let data = snap.exists ? snap.data() : { count: 0, windowStart: now };
    if (now - (data.windowStart || 0) > windowMs) {
      data = { count: 0, windowStart: now };
    }
    if (data.count >= maxAttempts) {
      const err = new Error('Too many booking attempts. Please wait a few minutes and try again.');
      err.status = 429;
      throw err;
    }
    data.count = (data.count || 0) + 1;
    data.updatedAt = admin.firestore.FieldValue.serverTimestamp();
    tx.set(ref, data, { merge: true });
  });
}

async function assertTenantBookable(db, tenantId) {
  const plat = await db.doc('platformTenants/' + tenantId).get();
  if (!plat.exists) return { ok: true, status: 'legacy' };
  const p = plat.data();
  if (p.deleted) return { ok: false, error: 'This business is no longer available.' };
  if (p.status === 'suspended') {
    return { ok: false, error: 'This business is temporarily unavailable for bookings.' };
  }
  if (p.status === 'expired') {
    return { ok: false, error: 'This business subscription has expired.' };
  }
  if (p.status === 'trial' && p.trialEnd && p.trialEnd.toDate && p.trialEnd.toDate() < new Date()) {
    return { ok: false, error: 'This business trial has expired.' };
  }
  if (p.status === 'active' && p.subscriptionEnd && p.subscriptionEnd.toDate && p.subscriptionEnd.toDate() < new Date()) {
    return { ok: false, error: 'This business subscription has expired.' };
  }
  return { ok: true, status: p.status };
}

/**
 * Emergency closure active for a given date (YYYY-MM-DD) and optional time range.
 */
function isEmergencyClosed(settings, dateStr) {
  const c = settings && settings.emergencyClosure;
  if (!c || !c.isClosed) return false;
  const start = c.closureStartDate || c.closureStart || null;
  const end = c.closureEndDate || c.closureEnd || null;
  if (!start && !end) return true; // closed with no range = fully closed
  if (start && dateStr < start) return false;
  if (end && dateStr > end) return false;
  return true;
}

function getActiveAppointments(list) {
  return (list || []).filter(function (a) {
    const s = a.status || 'confirmed';
    return s !== 'cancelled' && s !== 'no_show';
  });
}

function overlapsAny(startMin, endMin, appointments, bufferMinutes) {
  const buf = bufferMinutes || 0;
  for (let i = 0; i < appointments.length; i++) {
    const a = appointments[i];
    const es = timeToMinutes(a.startTime) - buf;
    const ee = timeToMinutes(a.endTime) + buf;
    if (hasConflict(startMin, endMin, es, ee)) return true;
  }
  return false;
}

function overlapsBlocks(startMin, endMin, blocks, dateStr) {
  for (let i = 0; i < (blocks || []).length; i++) {
    const b = blocks[i];
    if (b.status === 'inactive') continue;
    if (b.date && b.date !== dateStr) continue;
    if (b.allDay) return true;
    const bs = timeToMinutes(b.startTime);
    const be = timeToMinutes(b.endTime);
    if (hasConflict(startMin, endMin, bs, be)) return true;
  }
  return false;
}

function generateSlots(date, durationMinutes, operatingHours, appointments, blocks, bufferMinutes, slotInterval) {
  slotInterval = slotInterval || 30;
  bufferMinutes = bufferMinutes || 0;
  const weekday = getWeekdayKey(date);
  const day = operatingHours && operatingHours[weekday];
  if (!day || !day.enabled || !day.open || !day.close) return [];
  const openMin = timeToMinutes(day.open);
  const closeMin = timeToMinutes(day.close);
  if (closeMin <= openMin) return [];
  const active = getActiveAppointments(appointments);
  const slots = [];
  for (let start = openMin; start + durationMinutes <= closeMin; start += slotInterval) {
    const end = start + durationMinutes;
    if (overlapsAny(start, end, active, bufferMinutes)) continue;
    if (overlapsBlocks(start, end, blocks, date)) continue;
    slots.push({ startTime: minutesToTime(start), endTime: minutesToTime(end) });
  }
  return slots;
}

async function loadBlocksForDate(db, tenantId, date) {
  const snap = await db.collection('tenants/' + tenantId + '/blockedSlots').where('date', '==', date).get();
  const blocks = [];
  snap.forEach(function (d) {
    blocks.push(Object.assign({ id: d.id }, d.data()));
  });
  // also all-day blocks without filtering if query misses — secondary query optional
  return blocks;
}

async function verifyOwnerToken(idToken) {
  const decoded = await admin.auth().verifyIdToken(idToken);
  return decoded.uid;
}

const ALLOWED_STATUS = {
  pending: ['confirmed', 'cancelled'],
  pending_verification: ['confirmed', 'cancelled'],
  confirmed: ['checked_in', 'completed', 'cancelled', 'no_show'],
  checked_in: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
  no_show: []
};

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
  const body = req.body || {};
  const action = body.action || 'create';

  try {
    // ---------- resolveHandle ----------
    if (action === 'resolveHandle') {
      const handle = String(body.handle || '').toLowerCase().trim();
      if (!/^[a-z0-9-]{3,40}$/.test(handle)) {
        return res.status(400).json({ error: 'Invalid handle' });
      }
      const q = await db.collection('platformTenants').where('handle', '==', handle).limit(1).get();
      if (q.empty) return res.status(404).json({ error: 'Business not found' });
      return res.status(200).json({ tenantId: q.docs[0].id });
    }

    // ---------- registerTenant ----------
    if (action === 'registerTenant') {
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

    // ---------- getSlots ----------
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

      if (isEmergencyClosed(settings, date)) {
        return res.status(200).json({
          slots: [],
          closed: true,
          message: (settings.emergencyClosure && settings.emergencyClosure.closureMessage) ||
            'This business is temporarily unavailable for online bookings.'
        });
      }

      const serviceSnap = await db.doc('tenants/' + tenantId + '/services/' + serviceId).get();
      if (!serviceSnap.exists || serviceSnap.data().active === false) {
        return res.status(404).json({ error: 'Service not found or inactive' });
      }
      const duration = serviceSnap.data().duration || 30;
      const buffer = (settings.bookingRules && settings.bookingRules.bufferMinutes) || 0;

      const apptSnap = await db.collection('tenants/' + tenantId + '/appointments').where('date', '==', date).get();
      const appointments = [];
      apptSnap.forEach(function (d) { appointments.push(d.data()); });
      const blocks = await loadBlocksForDate(db, tenantId, date);

      const slots = generateSlots(date, duration, settings.operatingHours || {}, appointments, blocks, buffer);
      return res.status(200).json({ slots: slots, closed: false });
    }

    // ---------- create (public online booking) ----------
    if (action === 'create') {
      // Honeypot: bots fill hidden field
      if (body.website || body.company_url || body.hp_field) {
        return res.status(200).json({ success: true, appointmentId: 'ok', message: 'Booking recorded' });
      }

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
      const idempotencyKey = body.idempotencyKey ? sanitizeIdempotencyKey(body.idempotencyKey) : null;

      if (!tenantId || !serviceId || !date || !startTime || !customerName || !customerEmail) {
        return res.status(400).json({ error: 'Missing required booking fields' });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: 'Invalid date' });
      }
      if (String(customerName).trim().length < 2 || String(customerName).length > 120) {
        return res.status(400).json({ error: 'Invalid customer name' });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(customerEmail).trim())) {
        return res.status(400).json({ error: 'Invalid email' });
      }

      // Rate limit by IP + tenant
      try {
        const rk = hashKey(clientIp(req) + ':' + tenantId);
        await checkRateLimit(db, 'book:' + rk, 12, 10);
      } catch (e) {
        if (e.status === 429) return res.status(429).json({ error: e.message });
        console.warn('rate limit', e.message);
      }

      const bookable = await assertTenantBookable(db, tenantId);
      if (!bookable.ok) return res.status(403).json({ error: bookable.error });

      const settingsRef = db.doc('tenants/' + tenantId + '/settings/config');
      const serviceRef = db.doc('tenants/' + tenantId + '/services/' + serviceId);
      const appointmentsCol = db.collection('tenants/' + tenantId + '/appointments');

      const result = await db.runTransaction(async (tx) => {
        // Idempotency inside transaction (atomic with create)
        if (idempotencyKey) {
          const idempRef = db.doc('tenants/' + tenantId + '/idempotency/' + idempotencyKey);
          const idempSnap = await tx.get(idempRef);
          if (idempSnap.exists) {
            const prev = idempSnap.data();
            return {
              id: prev.appointmentId,
              bookingId: prev.bookingId,
              status: prev.status,
              price: 0,
              duplicate: true
            };
          }
        }

        const settingsSnap = await tx.get(settingsRef);
        if (!settingsSnap.exists) {
          const err = new Error('Business not found');
          err.status = 404;
          throw err;
        }
        const settings = settingsSnap.data();

        if (isEmergencyClosed(settings, date)) {
          const err = new Error(
            (settings.emergencyClosure && settings.emergencyClosure.closureMessage) ||
            'This business is temporarily unavailable for online bookings.'
          );
          err.status = 403;
          throw err;
        }

        const serviceSnap = await tx.get(serviceRef);
        if (!serviceSnap.exists || serviceSnap.data().active === false) {
          const err = new Error('Service not found or inactive');
          err.status = 404;
          throw err;
        }
        const service = serviceSnap.data();
        const duration = service.duration || 30;
        const price = Number(service.price || 0);
        const buffer = (settings.bookingRules && settings.bookingRules.bufferMinutes) || 0;

        const startMin = timeToMinutes(startTime);
        const finalEnd = endTime || minutesToTime(startMin + duration);
        const reqEndMin = timeToMinutes(finalEnd);

        const weekday = getWeekdayKey(date);
        const day = settings.operatingHours && settings.operatingHours[weekday];
        if (!day || !day.enabled) {
          const err = new Error('Business is closed on this day');
          err.status = 400;
          throw err;
        }
        if (startMin < timeToMinutes(day.open) || reqEndMin > timeToMinutes(day.close)) {
          const err = new Error('Selected time is outside operating hours');
          err.status = 400;
          throw err;
        }

        // Booking rules: min advance
        const minAdvance = (settings.bookingRules && settings.bookingRules.minAdvanceHours) || 0;
        if (minAdvance > 0) {
          const tzOff2 = (settings.timezoneOffsetMinutes != null) ? Number(settings.timezoneOffsetMinutes) : 480;
          const startDt = parseBusinessLocalDateTime(date, startTime, tzOff2);
          if (startDt.getTime() - Date.now() < minAdvance * 3600000) {
            const err = new Error('This time is too soon to book. Please choose a later slot.');
            err.status = 400;
            throw err;
          }
        }

        const apptQuery = appointmentsCol.where('date', '==', date);
        const apptSnap = await tx.get(apptQuery);
        const appointments = [];
        apptSnap.forEach(function (d) { appointments.push(d.data()); });
        const active = getActiveAppointments(appointments);
        if (overlapsAny(startMin, reqEndMin, active, buffer)) {
          const err = new Error('Sorry, this time slot was just booked. Please choose another available time.');
          err.status = 409;
          throw err;
        }

        // Blocked slots (read outside heavy — use collection get in tx via query)
        const blockQuery = db.collection('tenants/' + tenantId + '/blockedSlots').where('date', '==', date);
        const blockSnap = await tx.get(blockQuery);
        const blocks = [];
        blockSnap.forEach(function (d) { blocks.push(d.data()); });
        if (overlapsBlocks(startMin, reqEndMin, blocks, date)) {
          const err = new Error('This time is blocked by the business.');
          err.status = 409;
          throw err;
        }

        const depositSettings = settings.depositSettings || { enabled: false };
        let depositStatus = 'none';
        let status = 'confirmed';
        if (depositSettings.enabled) {
          if (depositSettings.required && !paymentRef) {
            const err = new Error('Payment reference is required for this deposit.');
            err.status = 400;
            throw err;
          }
          depositStatus = paymentRef ? 'pending_verification' : 'pending';
          if (depositSettings.required) status = 'pending_verification';
        }

        const bookingId = makeBookingId();
        const tzOff = (settings.timezoneOffsetMinutes != null) ? Number(settings.timezoneOffsetMinutes) : 480;
        const startLocal = parseBusinessLocalDateTime(date, startTime, tzOff);
        const graceEnds = new Date(startLocal.getTime() + 15 * 60 * 1000);
        const reminderFor = new Date(startLocal.getTime() - 60 * 60 * 1000);

        const newRef = appointmentsCol.doc();
        const appointment = {
          bookingId,
          customerName: String(customerName).trim(),
          customerEmail: String(customerEmail).trim().toLowerCase(),
          customerPhone: String(customerPhone).trim().slice(0, 40),
          notes: String(notes).trim().slice(0, 500),
          serviceId,
          serviceName: service.name || '',
          serviceDuration: duration,
          servicePrice: price,
          date,
          startTime,
          endTime: finalEnd,
          status,
          depositStatus,
          paymentRef: String(paymentRef).trim().slice(0, 120),
          source: 'online',
          gracePeriodEndsAt: admin.firestore.Timestamp.fromDate(graceEnds),
          checkedInAt: null,
          noShowProcessedAt: null,
          reminderStatus: 'scheduled',
          reminderScheduledFor: admin.firestore.Timestamp.fromDate(reminderFor),
          reminderSentAt: null,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        tx.set(newRef, appointment);

        if (idempotencyKey) {
          tx.set(db.doc('tenants/' + tenantId + '/idempotency/' + idempotencyKey), {
            appointmentId: newRef.id,
            bookingId,
            status,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
        }

        return { id: newRef.id, bookingId, status, price };
      });

      if (!result.duplicate) {
        try {
          await upsertCustomerCreated(db, tenantId, {
            customerName: String(customerName).trim(),
            customerEmail: String(customerEmail).trim().toLowerCase(),
            customerPhone: String(customerPhone).trim()
          });
        } catch (e) { console.warn('crm', e.message); }
        try {
          await db.doc('platformTenants/' + tenantId).set({
            totalBookings: admin.firestore.FieldValue.increment(1),
            estimatedRevenue: admin.firestore.FieldValue.increment(result.price || 0),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
        } catch (e) { console.warn('stats', e.message); }

        try {
          await db.collection('tenants/' + tenantId + '/notifications').add({
            type: 'new_booking',
            title: 'New booking',
            message: result.bookingId + ' was created',
            read: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
        } catch (e) {}
      }

      if (result.duplicate) {
        return res.status(200).json({
          success: true,
          appointmentId: result.id,
          bookingId: result.bookingId,
          status: result.status,
          message: 'Booking already recorded',
          duplicate: true
        });
      }

      return res.status(201).json({
        success: true,
        appointmentId: result.id,
        bookingId: result.bookingId,
        status: result.status,
        message: 'Booking confirmed'
      });
    }

    // ---------- walkIn (owner) ----------
    if (action === 'walkIn') {
      const idToken = body.idToken;
      if (!idToken) return res.status(401).json({ error: 'Auth required' });
      const uid = await verifyOwnerToken(idToken);
      const tenantId = body.tenantId || uid;
      if (tenantId !== uid) return res.status(403).json({ error: 'Forbidden' });

      const serviceId = body.serviceId;
      const date = body.date || new Date().toISOString().slice(0, 10);
      const startTime = body.startTime;
      const customerName = String(body.customerName || 'Walk-in').trim().slice(0, 120);
      if (!serviceId || !startTime) return res.status(400).json({ error: 'serviceId and startTime required' });

      const settingsSnap = await db.doc('tenants/' + tenantId + '/settings/config').get();
      if (!settingsSnap.exists) return res.status(404).json({ error: 'Business not found' });
      const settings = settingsSnap.data();
      const serviceSnap = await db.doc('tenants/' + tenantId + '/services/' + serviceId).get();
      if (!serviceSnap.exists) return res.status(404).json({ error: 'Service not found' });
      const service = serviceSnap.data();
      const duration = body.duration ? Number(body.duration) : (service.duration || 30);
      const startMin = timeToMinutes(startTime);
      const endTime = minutesToTime(startMin + duration);
      const buffer = (settings.bookingRules && settings.bookingRules.bufferMinutes) || 0;

      const result = await db.runTransaction(async (tx) => {
        const apptSnap = await tx.get(db.collection('tenants/' + tenantId + '/appointments').where('date', '==', date));
        const appointments = [];
        apptSnap.forEach(function (d) { appointments.push(d.data()); });
        if (overlapsAny(startMin, startMin + duration, getActiveAppointments(appointments), buffer)) {
          const err = new Error('This time conflicts with an existing appointment.');
          err.status = 409;
          throw err;
        }
        const blockSnap = await tx.get(db.collection('tenants/' + tenantId + '/blockedSlots').where('date', '==', date));
        const blocks = [];
        blockSnap.forEach(function (d) { blocks.push(d.data()); });
        if (overlapsBlocks(startMin, startMin + duration, blocks, date)) {
          const err = new Error('This time is blocked.');
          err.status = 409;
          throw err;
        }
        const bookingId = makeBookingId();
        const newRef = db.collection('tenants/' + tenantId + '/appointments').doc();
        const tzOff = (settings.timezoneOffsetMinutes != null) ? Number(settings.timezoneOffsetMinutes) : 480;
        const startLocal = parseBusinessLocalDateTime(date, startTime, tzOff);
        const graceEnds = new Date(startLocal.getTime() + 15 * 60 * 1000);
        tx.set(newRef, {
          bookingId,
          customerName,
          customerEmail: '',
          customerPhone: String(body.customerPhone || '').trim(),
          notes: String(body.notes || 'Walk-in').slice(0, 500),
          serviceId,
          serviceName: service.name || '',
          serviceDuration: duration,
          servicePrice: Number(service.price || 0),
          date,
          startTime,
          endTime,
          status: 'checked_in',
          checkedInAt: admin.firestore.FieldValue.serverTimestamp(),
          gracePeriodEndsAt: admin.firestore.Timestamp.fromDate(graceEnds),
          source: 'walk_in',
          depositStatus: 'none',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        return { id: newRef.id, bookingId };
      });

      return res.status(201).json({ success: true, appointmentId: result.id, bookingId: result.bookingId });
    }

    // ---------- blockTime ----------
    if (action === 'blockTime') {
      const idToken = body.idToken;
      if (!idToken) return res.status(401).json({ error: 'Auth required' });
      const uid = await verifyOwnerToken(idToken);
      const tenantId = body.tenantId || uid;
      if (tenantId !== uid) return res.status(403).json({ error: 'Forbidden' });

      const date = body.date;
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: 'Valid date required' });
      }
      const allDay = !!body.allDay;
      const startTime = body.startTime || '';
      const endTime = body.endTime || '';
      if (!allDay && (!startTime || !endTime)) {
        return res.status(400).json({ error: 'startTime and endTime required unless allDay' });
      }
      if (!allDay && timeToMinutes(endTime) <= timeToMinutes(startTime)) {
        return res.status(400).json({ error: 'endTime must be after startTime' });
      }

      const ref = await db.collection('tenants/' + tenantId + '/blockedSlots').add({
        date,
        allDay,
        startTime: allDay ? '' : startTime,
        endTime: allDay ? '' : endTime,
        reason: String(body.reason || 'Blocked').slice(0, 200),
        status: 'active',
        createdBy: uid,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return res.status(201).json({ success: true, blockId: ref.id });
    }

    if (action === 'unblockTime') {
      const idToken = body.idToken;
      if (!idToken) return res.status(401).json({ error: 'Auth required' });
      const uid = await verifyOwnerToken(idToken);
      const tenantId = body.tenantId || uid;
      if (tenantId !== uid) return res.status(403).json({ error: 'Forbidden' });
      if (!body.blockId) return res.status(400).json({ error: 'blockId required' });
      await db.doc('tenants/' + tenantId + '/blockedSlots/' + body.blockId).delete();
      return res.status(200).json({ success: true });
    }

    if (action === 'listBlocked') {
      const idToken = body.idToken;
      if (!idToken) return res.status(401).json({ error: 'Auth required' });
      const uid = await verifyOwnerToken(idToken);
      const tenantId = body.tenantId || uid;
      if (tenantId !== uid) return res.status(403).json({ error: 'Forbidden' });
      const snap = await db.collection('tenants/' + tenantId + '/blockedSlots').orderBy('date', 'desc').limit(50).get();
      const items = [];
      snap.forEach(function (d) {
        const x = d.data();
        items.push({
          id: d.id,
          date: x.date,
          allDay: x.allDay,
          startTime: x.startTime,
          endTime: x.endTime,
          reason: x.reason
        });
      });
      return res.status(200).json({ blocks: items });
    }

    // ---------- setEmergencyClosure ----------
    if (action === 'setEmergencyClosure') {
      const idToken = body.idToken;
      if (!idToken) return res.status(401).json({ error: 'Auth required' });
      const uid = await verifyOwnerToken(idToken);
      const tenantId = body.tenantId || uid;
      if (tenantId !== uid) return res.status(403).json({ error: 'Forbidden' });

      const isClosed = !!body.isClosed;
      const closure = {
        isClosed,
        closureStartDate: body.closureStartDate || null,
        closureEndDate: body.closureEndDate || null,
        closureMessage: String(body.closureMessage || 'This business is temporarily unavailable for online bookings.').slice(0, 300),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: uid
      };
      await db.doc('tenants/' + tenantId + '/settings/config').set(
        { emergencyClosure: closure, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );

      if (isClosed) {
        try {
          await db.collection('tenants/' + tenantId + '/closureEvents').add({
            ...closure,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
          await db.collection('tenants/' + tenantId + '/notifications').add({
            type: 'emergency_closure',
            title: 'Emergency closure activated',
            message: closure.closureMessage,
            read: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
        } catch (e) {}
      }

      return res.status(200).json({ success: true, emergencyClosure: { isClosed: closure.isClosed, closureMessage: closure.closureMessage } });
    }

    // ---------- updateStatus (owner) ----------
    if (action === 'updateStatus') {
      const idToken = body.idToken;
      if (!idToken) return res.status(401).json({ error: 'Auth required' });
      const uid = await verifyOwnerToken(idToken);
      const tenantId = body.tenantId || uid;
      if (tenantId !== uid) return res.status(403).json({ error: 'Forbidden' });
      const appointmentId = body.appointmentId;
      const newStatus = body.status;
      if (!appointmentId || !newStatus) {
        return res.status(400).json({ error: 'appointmentId and status required' });
      }

      const ref = db.doc('tenants/' + tenantId + '/appointments/' + appointmentId);
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) {
          const err = new Error('Appointment not found');
          err.status = 404;
          throw err;
        }
        const cur = snap.data().status || 'confirmed';
        const allowed = ALLOWED_STATUS[cur] || [];
        if (allowed.indexOf(newStatus) === -1) {
          const err = new Error('Invalid status transition from ' + cur + ' to ' + newStatus);
          err.status = 400;
          throw err;
        }
        const patch = {
          status: newStatus,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        if (newStatus === 'checked_in') {
          patch.checkedInAt = admin.firestore.FieldValue.serverTimestamp();
        }
        if (newStatus === 'no_show') {
          patch.noShowProcessedAt = admin.firestore.FieldValue.serverTimestamp();
        }
        tx.update(ref, patch);
      });

      // CRM sync for completed / no_show
      if (newStatus === 'completed' || newStatus === 'no_show') {
        try {
          const snap = await ref.get();
          if (snap.exists) {
            const appt = snap.data();
            const cid = customerIdFromContact(appt.customerEmail, appt.customerPhone);
            if (cid) {
              const cref = db.doc('tenants/' + tenantId + '/customers/' + cid);
              if (newStatus === 'completed') {
                await cref.set({
                  completedBookings: admin.firestore.FieldValue.increment(1),
                  totalSpent: admin.firestore.FieldValue.increment(Number(appt.servicePrice || 0)),
                  lastVisitAt: admin.firestore.FieldValue.serverTimestamp(),
                  nextRecommendedBookingAt: admin.firestore.Timestamp.fromDate(
                    new Date(Date.now() + 30 * 86400000)
                  ),
                  updatedAt: admin.firestore.FieldValue.serverTimestamp()
                }, { merge: true });
              } else {
                await cref.set({
                  noShowCount: admin.firestore.FieldValue.increment(1),
                  updatedAt: admin.firestore.FieldValue.serverTimestamp()
                }, { merge: true });
              }
            }
          }
        } catch (e) { console.warn('crm status', e.message); }
      }

      return res.status(200).json({ success: true, status: newStatus });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('create-booking error:', err);
    const status = err.status || 500;
    return res.status(status).json({ error: err.message || 'Internal server error' });
  }
};
