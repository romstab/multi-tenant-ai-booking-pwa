/** CREATE-BOOKING-FIX-FINAL-1 — slotStartMin/slotEndMin declared before hours checks; real BK refs only */

function makeManageToken() {
  return require('crypto').randomBytes(24).toString('hex');
}
function makeBookingRef(dateStr) {
  const d = (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr))
    ? dateStr.replace(/-/g, '')
    : new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return 'BK-' + d + '-' + require('crypto').randomBytes(3).toString('hex').toUpperCase();
}
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
const authz = require('./authz');

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

const SERVER_BUILD = 'CREATE-BOOKING-FIX-FINAL-1';

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

/** Default client booking policies (backward compatible with Batches 1–17). */
function getClientBookingPolicies(settings) {
  const p = (settings && settings.clientBookingPolicies) || {};
  const cancelEnabled = p.cancelEnabled !== false; // default true
  const rescheduleEnabled = p.rescheduleEnabled !== false; // default true
  let cancelCutoffHours = p.cancelCutoffHours;
  if (cancelCutoffHours === undefined || cancelCutoffHours === null) cancelCutoffHours = 0; // anytime before
  cancelCutoffHours = Number(cancelCutoffHours);
  if (isNaN(cancelCutoffHours) || cancelCutoffHours < 0) cancelCutoffHours = 0;
  let rescheduleCutoffHours = p.rescheduleCutoffHours;
  if (rescheduleCutoffHours === undefined || rescheduleCutoffHours === null) rescheduleCutoffHours = 0;
  rescheduleCutoffHours = Number(rescheduleCutoffHours);
  if (isNaN(rescheduleCutoffHours) || rescheduleCutoffHours < 0) rescheduleCutoffHours = 0;
  let maxReschedules = p.maxReschedules;
  if (maxReschedules === undefined || maxReschedules === null || maxReschedules === 'unlimited') {
    maxReschedules = null; // unlimited
  } else {
    maxReschedules = parseInt(maxReschedules, 10);
    if (isNaN(maxReschedules) || maxReschedules < 0) maxReschedules = null;
  }
  return {
    cancelEnabled,
    cancelCutoffHours,
    rescheduleEnabled,
    rescheduleCutoffHours,
    maxReschedules
  };
}

/**
 * Hours remaining until appointment start, using business timezone offset (default PH +8).
 * Returns negative if already started.
 */
function hoursUntilAppointment(settings, dateStr, timeStr) {
  const tzOff = (settings && settings.timezoneOffsetMinutes != null)
    ? Number(settings.timezoneOffsetMinutes)
    : 480;
  const start = parseBusinessLocalDateTime(dateStr, timeStr, tzOff);
  return (start.getTime() - Date.now()) / 3600000;
}

function evaluateCancelPolicy(settings, appointment) {
  const pol = getClientBookingPolicies(settings);
  if (!pol.cancelEnabled) {
    return { ok: false, reason: 'Online cancellation is not available for this appointment. Please contact the business if you need assistance.' };
  }
  const st = appointment.status || 'confirmed';
  if (['cancelled', 'completed', 'no_show'].includes(st)) {
    return { ok: false, reason: 'This appointment can no longer be cancelled.' };
  }
  const hoursLeft = hoursUntilAppointment(settings, appointment.date, appointment.startTime);
  if (hoursLeft < pol.cancelCutoffHours) {
    if (hoursLeft < 0) {
      return { ok: false, reason: 'This appointment time has already passed.' };
    }
    return {
      ok: false,
      reason: pol.cancelCutoffHours > 0
        ? ('Online cancellation is no longer available because the appointment is within ' + pol.cancelCutoffHours + ' hour(s) of its scheduled time.')
        : 'This appointment can no longer be cancelled.'
    };
  }
  return { ok: true, policy: pol, hoursLeft };
}

function evaluateReschedulePolicy(settings, appointment) {
  const pol = getClientBookingPolicies(settings);
  if (!pol.rescheduleEnabled) {
    return { ok: false, reason: 'Online rescheduling is not available for this appointment.' };
  }
  const st = appointment.status || 'confirmed';
  if (['cancelled', 'completed', 'no_show'].includes(st)) {
    return { ok: false, reason: 'This appointment can no longer be rescheduled.' };
  }
  const hoursLeft = hoursUntilAppointment(settings, appointment.date, appointment.startTime);
  if (hoursLeft < pol.rescheduleCutoffHours) {
    if (hoursLeft < 0) {
      return { ok: false, reason: 'This appointment time has already passed.' };
    }
    return {
      ok: false,
      reason: pol.rescheduleCutoffHours > 0
        ? ('Online rescheduling is no longer available because the appointment is within ' + pol.rescheduleCutoffHours + ' hour(s) of its scheduled time.')
        : 'This appointment can no longer be rescheduled.'
    };
  }
  const count = Number(appointment.rescheduleCount || 0);
  if (pol.maxReschedules != null && count >= pol.maxReschedules) {
    return {
      ok: false,
      reason: 'This appointment has already been rescheduled the maximum number of times allowed by the business.'
    };
  }
  return { ok: true, policy: pol, hoursLeft, rescheduleCount: count };
}

function policySummaryText(settings) {
  const pol = getClientBookingPolicies(settings);
  const parts = [];
  if (pol.cancelEnabled) {
    parts.push(pol.cancelCutoffHours > 0
      ? ('Cancel until ' + pol.cancelCutoffHours + ' hour(s) before')
      : 'Cancel anytime before the appointment');
  } else {
    parts.push('Online cancellation not available');
  }
  if (pol.rescheduleEnabled) {
    let r = pol.rescheduleCutoffHours > 0
      ? ('Reschedule until ' + pol.rescheduleCutoffHours + ' hour(s) before')
      : 'Reschedule anytime before the appointment';
    if (pol.maxReschedules != null) r += ' (max ' + pol.maxReschedules + ' change' + (pol.maxReschedules === 1 ? '' : 's') + ')';
    parts.push(r);
  } else {
    parts.push('Online rescheduling not available');
  }
  return parts.join('. ') + '.';
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

/**
 * Load special hours override for a single date (YYYY-MM-DD).
 * Returns null if none, or { type: 'closed'|'custom_hours', open, close, title, note }.
 */
async function loadSpecialHoursForDate(db, tenantId, dateStr) {
  const snap = await db.collection('tenants/' + tenantId + '/specialHours')
    .where('date', '==', dateStr)
    .limit(5)
    .get();
  if (snap.empty) return null;
  // Prefer explicit closed over custom if both somehow exist
  let closed = null;
  let custom = null;
  snap.forEach(function (d) {
    const x = Object.assign({ id: d.id }, d.data());
    if (x.type === 'closed') closed = x;
    else if (x.type === 'custom_hours') custom = x;
  });
  return closed || custom || null;
}

/**
 * Resolve effective business day hours for a date.
 * Priority: emergency > special closed > special custom > weekly operatingHours.
 * Returns { closed: true, reason } OR { closed: false, open, close, source, title }.
 */
function resolveBusinessDayHours(settings, dateStr, special) {
  if (isEmergencyClosed(settings, dateStr)) {
    return {
      closed: true,
      reason: (settings.emergencyClosure && settings.emergencyClosure.closureMessage) ||
        'This business is temporarily unavailable for online bookings.',
      source: 'emergency'
    };
  }
  if (special && special.type === 'closed') {
    return {
      closed: true,
      reason: special.title
        ? ('Closed: ' + special.title)
        : 'This business is unavailable on this date.',
      source: 'special_closed',
      title: special.title || null
    };
  }
  if (special && special.type === 'custom_hours' && special.open && special.close) {
    const o = timeToMinutes(special.open);
    const c = timeToMinutes(special.close);
    if (c > o) {
      return {
        closed: false,
        open: special.open,
        close: special.close,
        source: 'special_custom',
        title: special.title || null
      };
    }
  }
  const weekday = getWeekdayKey(dateStr);
  const day = settings && settings.operatingHours && settings.operatingHours[weekday];
  if (!day || day.enabled === false || day.closed === true || !day.open || !day.close) {
    return { closed: true, reason: 'The business is closed on this day.', source: 'weekly' };
  }
  return {
    closed: false,
    open: day.open,
    close: day.close,
    source: 'weekly',
    title: null
  };
}

/** Build a synthetic operatingHours object for generateSlots using one resolved day. */
function operatingHoursFromResolved(dateStr, resolved) {
  if (!resolved || resolved.closed) return {};
  const weekday = getWeekdayKey(dateStr);
  const oh = {};
  oh[weekday] = { enabled: true, open: resolved.open, close: resolved.close };
  return oh;
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

function generateSlots(date, durationMinutes, operatingHours, appointments, blocks, bufferMinutes, slotInterval, staffOperatingHours, staffBreaksForDay) {
  slotInterval = slotInterval || 30;
  bufferMinutes = bufferMinutes || 0;
  const weekday = getWeekdayKey(date);
  const day = operatingHours && operatingHours[weekday];
  if (!day || !day.enabled || !day.open || !day.close) return [];
  let openMin = timeToMinutes(day.open);
  let closeMin = timeToMinutes(day.close);
  if (staffOperatingHours) {
    const sd = staffOperatingHours[weekday];
    if (!sd || sd.enabled === false || sd.closed === true || !sd.open || !sd.close) return [];
    openMin = Math.max(openMin, timeToMinutes(sd.open));
    closeMin = Math.min(closeMin, timeToMinutes(sd.close));
  }
  if (closeMin <= openMin) return [];
  const active = getActiveAppointments(appointments);
  const breaks = staffBreaksForDay || [];
  const slots = [];
  for (let start = openMin; start + durationMinutes <= closeMin; start += slotInterval) {
    const end = start + durationMinutes;
    if (overlapsAny(start, end, active, bufferMinutes)) continue;
    if (overlapsBlocks(start, end, blocks, date)) continue;
    if (overlapsStaffBreaks(start, end, breaks)) continue;
    slots.push({ startTime: minutesToTime(start), endTime: minutesToTime(end) });
  }
  return slots;
}

function overlapsStaffBreaks(startMin, endMin, breaks) {
  for (let i = 0; i < (breaks || []).length; i++) {
    const b = breaks[i];
    if (!b || !b.start || !b.end) continue;
    const bs = timeToMinutes(b.start);
    const be = timeToMinutes(b.end);
    if (be <= bs) continue;
    if (hasConflict(startMin, endMin, bs, be)) return true;
  }
  return false;
}

function getStaffBreaksForDate(staff, dateStr) {
  if (!staff || !staff.staffBreaks) return [];
  const weekday = getWeekdayKey(dateStr);
  const keyMap = { sunday: 'sun', monday: 'mon', tuesday: 'tue', wednesday: 'wed', thursday: 'thu', friday: 'fri', saturday: 'sat' };
  const short = keyMap[weekday] || weekday.slice(0, 3);
  // support both mon and monday keys
  const list = staff.staffBreaks[short] || staff.staffBreaks[weekday] || [];
  return Array.isArray(list) ? list : [];
}

/**
 * timeOff records: { staffId, startDate, endDate, startTime?, endTime?, type }
 * Full day if startTime/endTime missing.
 */
function isStaffOnTimeOff(timeOffList, staffId, dateStr, startMin, endMin) {
  const list = timeOffList || [];
  for (let i = 0; i < list.length; i++) {
    const to = list[i];
    if (!to || to.staffId !== staffId) continue;
    const sd = to.startDate || '';
    const ed = to.endDate || to.startDate || '';
    if (!sd) continue;
    if (dateStr < sd || dateStr > ed) continue;
    // full-day off
    if (!to.startTime && !to.endTime) return true;
    // partial day — only if date equals a day in range
    const ts = to.startTime ? timeToMinutes(to.startTime) : 0;
    const te = to.endTime ? timeToMinutes(to.endTime) : 24 * 60;
    if (te <= ts) return true; // treat invalid as full day
    if (hasConflict(startMin, endMin, ts, te)) return true;
  }
  return false;
}

async function loadStaffTimeOffForDate(db, tenantId, dateStr) {
  // Query by startDate <= date and endDate >= date is hard without composite indexes for all cases.
  // Load recent window (limit 200) and filter in memory — practical for small teams.
  const snap = await db.collection('tenants/' + tenantId + '/staffTimeOff').limit(200).get();
  const out = [];
  snap.forEach(function (d) {
    const x = Object.assign({ id: d.id }, d.data());
    const sd = x.startDate || '';
    const ed = x.endDate || x.startDate || '';
    if (!sd) return;
    if (dateStr >= sd && dateStr <= ed) out.push(x);
  });
  return out;
}


function staffCanDoService(staff, serviceId) {
  if (!staff || staff.active === false) return false;
  const ids = staff.serviceIds;
  if (!ids || !ids.length) return true;
  return ids.indexOf(serviceId) !== -1;
}

function getStaffSelectionMode(settings) {
  const m = (settings && settings.staffSelectionMode) || 'optional';
  if (['optional', 'required', 'hidden'].indexOf(m) === -1) return 'optional';
  return m;
}

async function loadActiveStaff(db, tenantId) {
  const snap = await db.collection('tenants/' + tenantId + '/staff').limit(100).get();
  const list = [];
  snap.forEach(function (d) {
    list.push(Object.assign({ id: d.id }, d.data()));
  });
  return list.filter(function (s) { return s.active !== false; });
}

function staffWorksAt(staff, dateStr, startMin, endMin, timeOffList) {
  if (!staff || staff.active === false) return false;
  if (isStaffOnTimeOff(timeOffList, staff.id, dateStr, startMin, endMin)) return false;
  const weekday = getWeekdayKey(dateStr);
  const sd = staff.workingHours && staff.workingHours[weekday];
  if (sd) {
    if (sd.enabled === false || sd.closed === true) return false;
    if (sd.open && startMin < timeToMinutes(sd.open)) return false;
    if (sd.close && endMin > timeToMinutes(sd.close)) return false;
  }
  if (overlapsStaffBreaks(startMin, endMin, getStaffBreaksForDate(staff, dateStr))) return false;
  return true;
}

function countStaffDayLoad(appointments, staffId, dateStr) {
  return getActiveAppointments(appointments).filter(function (a) {
    return a.staffId === staffId && a.date === dateStr;
  }).length;
}

function countStaffUpcomingLoad(appointments, staffId, fromDateStr) {
  return getActiveAppointments(appointments).filter(function (a) {
    return a.staffId === staffId && a.date >= fromDateStr;
  }).length;
}

/** Balanced auto-assign: fewest day load, then upcoming, then name/id. */
function pickStaffForSlot(eligibleStaff, appointments, dateStr, startMin, endMin, buffer, serviceId, timeOffList) {
  const candidates = [];
  for (let i = 0; i < eligibleStaff.length; i++) {
    const st = eligibleStaff[i];
    if (!staffCanDoService(st, serviceId)) continue;
    if (!staffWorksAt(st, dateStr, startMin, endMin, timeOffList)) continue;
    const staffAppts = getActiveAppointments(appointments.filter(function (a) {
      return a.staffId === st.id;
    }));
    if (overlapsAny(startMin, endMin, staffAppts, buffer)) continue;
    candidates.push(st);
  }
  if (!candidates.length) return null;
  candidates.sort(function (a, b) {
    const dayA = countStaffDayLoad(appointments, a.id, dateStr);
    const dayB = countStaffDayLoad(appointments, b.id, dateStr);
    if (dayA !== dayB) return dayA - dayB;
    const upA = countStaffUpcomingLoad(appointments, a.id, dateStr);
    const upB = countStaffUpcomingLoad(appointments, b.id, dateStr);
    if (upA !== upB) return upA - upB;
    const na = String(a.name || '').toLowerCase();
    const nb = String(b.name || '').toLowerCase();
    if (na !== nb) return na < nb ? -1 : 1;
    return String(a.id).localeCompare(String(b.id));
  });
  return candidates[0];
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

      const special = await loadSpecialHoursForDate(db, tenantId, date);
      const dayHours = resolveBusinessDayHours(settings, date, special);
      if (dayHours.closed) {
        return res.status(200).json({
          slots: [],
          closed: true,
          message: dayHours.reason || 'This business is unavailable on this date.',
          specialHours: special ? { type: special.type, title: special.title || null } : null
        });
      }

      const serviceSnap = await db.doc('tenants/' + tenantId + '/services/' + serviceId).get();
      if (!serviceSnap.exists || serviceSnap.data().active === false) {
        return res.status(404).json({ error: 'Service not found or inactive' });
      }
      const duration = serviceSnap.data().duration || 30;
      const buffer = (settings.bookingRules && settings.bookingRules.bufferMinutes) || 0;

      const apptSnap = await db.collection('tenants/' + tenantId + '/appointments').where('date', '==', date).get();
      const excludeId = body.excludeAppointmentId ? String(body.excludeAppointmentId) : '';
      const appointments = [];
      apptSnap.forEach(function (d) {
        if (excludeId && d.id === excludeId) return;
        appointments.push(Object.assign({ id: d.id }, d.data()));
      });
      const blocks = await loadBlocksForDate(db, tenantId, date);
      const allStaff = await loadActiveStaff(db, tenantId);
      const staffId = body.staffId ? String(body.staffId).trim() : '';
      const mode = getStaffSelectionMode(settings);

      const effectiveOH = operatingHoursFromResolved(date, dayHours);

      if (!allStaff.length) {
        const slots = generateSlots(date, duration, effectiveOH, appointments, blocks, buffer);
        return res.status(200).json({
          slots: slots, closed: false, staffMode: mode, hasStaff: false,
          specialHours: special ? { type: special.type, open: dayHours.open, close: dayHours.close, title: special.title || null } : null
        });
      }

      const eligible = allStaff.filter(function (s) { return staffCanDoService(s, serviceId); });
      if (!eligible.length) {
        return res.status(200).json({
          slots: [], closed: false, hasStaff: true, staffMode: mode,
          message: 'No staff available for this service'
        });
      }

      const timeOff = await loadStaffTimeOffForDate(db, tenantId, date);

      if (staffId) {
        const staff = eligible.find(function (s) { return s.id === staffId; });
        if (!staff) return res.status(400).json({ error: 'Selected staff cannot perform this service' });
        // full day off?
        if (isStaffOnTimeOff(timeOff, staffId, date, 0, 24 * 60)) {
          return res.status(200).json({
            slots: [], closed: false, hasStaff: true, staffId: staffId, staffMode: mode,
            message: 'This team member is unavailable on the selected date.'
          });
        }
        const staffAppts = appointments.filter(function (a) { return a.staffId === staffId; });
        const slots = generateSlots(
          date, duration, effectiveOH || settings.operatingHours || {}, staffAppts, blocks, buffer, 30,
          staff.workingHours || null, getStaffBreaksForDate(staff, date)
        );
        return res.status(200).json({
          slots: slots, closed: false, staffMode: mode, hasStaff: true, staffId: staffId,
          message: slots.length ? null : 'No available times for this team member on the selected date.'
        });
      }

      const slotMap = {};
      eligible.forEach(function (staff) {
        if (isStaffOnTimeOff(timeOff, staff.id, date, 0, 24 * 60) &&
            !staff.staffBreaks) {
          // still allow partial day — check per slot via generateSlots + worksAt
        }
        const staffAppts = appointments.filter(function (a) { return a.staffId === staff.id; });
        generateSlots(
          date, duration, effectiveOH || settings.operatingHours || {}, staffAppts, blocks, buffer, 30,
          staff.workingHours || null, getStaffBreaksForDate(staff, date)
        ).forEach(function (s) {
          const sm = timeToMinutes(s.startTime);
          const em = timeToMinutes(s.endTime);
          if (!staffWorksAt(staff, date, sm, em, timeOff)) return;
          if (!slotMap[s.startTime]) slotMap[s.startTime] = s;
        });
      });
      const unionSlots = Object.keys(slotMap).sort().map(function (k) { return slotMap[k]; });
      return res.status(200).json({ slots: unionSlots, closed: false, staffMode: mode, hasStaff: true, staffId: null });
    }

    // ---------- listStaffPublic ----------
    if (action === 'listStaffPublic') {
      const tenantId = String(body.tenantId || '').trim();
      const serviceId = body.serviceId ? String(body.serviceId) : '';
      if (!tenantId) return res.status(400).json({ error: 'tenantId required' });
      const settingsSnap = await db.doc('tenants/' + tenantId + '/settings/config').get();
      const settings = settingsSnap.exists ? settingsSnap.data() : {};
      const mode = getStaffSelectionMode(settings);
      const staff = await loadActiveStaff(db, tenantId);
      let list = staff.map(function (s) {
        return {
          id: s.id,
          name: s.name || 'Staff',
          role: s.role || '',
          description: s.description || '',
          serviceIds: s.serviceIds || []
        };
      });
      if (serviceId) {
        list = list.filter(function (s) {
          const full = staff.find(function (x) { return x.id === s.id; });
          return staffCanDoService(full, serviceId);
        });
      }
      return res.status(200).json({ staff: list, staffSelectionMode: mode, hasStaff: list.length > 0 });
    }

    // ---------- create (public online booking) ----------
    if (action === 'create') {
      // Honeypot: only treat as bot when a honeypot field is NON-EMPTY (after trim).
      // IMPORTANT: never return appointmentId/bookingRef that a real client would accept.
      // Browser autofill can fill name="website" — clients must still require a real BK- reference.
      const hpVal = String(body.website || body.company_url || body.hp_field || body.bk_hp || '').trim();
      if (hpVal) {
        return res.status(200).json({
          ok: false,
          success: false,
          stage: 'honeypot',
          error: 'Rejected',
          message: 'Could not complete booking. Please try again.',
          appointmentId: null,
          bookingId: null,
          bookingRef: null,
          serverBuild: SERVER_BUILD
        });
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
        return res.status(400).json({
          ok: false,
          stage: 'validate-fields',
          error: 'Missing required booking fields',
          message: 'Missing required booking fields'
        });
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
      const timeOffForDay = await loadStaffTimeOffForDate(db, tenantId, date);
      const specialForCreate = await loadSpecialHoursForDate(db, tenantId, date);
      // Pre-load staff outside the transaction (non-tx reads inside runTransaction are unsafe)
      const staffSnapPre = await db.collection('tenants/' + tenantId + '/staff').limit(100).get();
      const allStaffPre = [];
      staffSnapPre.forEach(function (d) {
        allStaffPre.push(Object.assign({ id: d.id }, d.data()));
      });
      const activeStaffPre = allStaffPre.filter(function (s) { return s.active !== false; });

      const result = await db.runTransaction(async (tx) => {
        // Idempotency inside transaction (atomic with create)
        if (idempotencyKey) {
          const idempRef = db.doc('tenants/' + tenantId + '/idempotency/' + idempotencyKey);
          const idempSnap = await tx.get(idempRef);
          if (idempSnap.exists) {
            const prev = idempSnap.data() || {};
            return {
              id: prev.appointmentId || null,
              bookingId: prev.bookingId || null,
              bookingRef: prev.bookingRef || null,
              manageToken: prev.manageToken || null,
              status: prev.status || 'confirmed',
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
        // special hours loaded outside tx as specialForCreate
        const dayHoursCreate = resolveBusinessDayHours(settings, date, specialForCreate);
        if (dayHoursCreate.closed) {
          const err = new Error(dayHoursCreate.reason || 'This business is unavailable on this date.');
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

        // BOOKING-FIX-FINAL-1: declare ALL slot minute values BEFORE any comparison (no TDZ).
        const slotDurationMin = Number(duration) || 30;
        const slotStartMin = timeToMinutes(startTime);
        if (!Number.isFinite(slotStartMin)) {
          const err = new Error('Invalid start time.');
          err.status = 400;
          throw err;
        }
        const slotEndTime = endTime || minutesToTime(slotStartMin + slotDurationMin);
        const slotEndMin = timeToMinutes(slotEndTime);
        if (!Number.isFinite(slotEndMin) || slotEndMin <= slotStartMin) {
          const err = new Error('Invalid end time for this service duration.');
          err.status = 400;
          throw err;
        }

        // Effective hours for this date only (includes special hours / holidays)
        const bizOpenMin = timeToMinutes(dayHoursCreate.open);
        const bizCloseMin = timeToMinutes(dayHoursCreate.close);
        if (slotStartMin < bizOpenMin || slotEndMin > bizCloseMin) {
          const err = new Error('Selected time is outside business hours for this date.');
          err.status = 409;
          throw err;
        }

        // Aliases used by shared helpers below (declared only after values are ready)
        const startMin = slotStartMin;
        const reqEndMin = slotEndMin;
        const finalEnd = slotEndTime;

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

        // Staff assignment (optional; uses preloaded list — legacy tenants have no staff)
        const staffMode = getStaffSelectionMode(settings);
        let assignedStaffId = body.staffId ? String(body.staffId).trim() : '';
        let assignedStaffName = '';
        const activeStaffList = activeStaffPre;

        if (activeStaffList.length) {
          if (staffMode === 'required' && !assignedStaffId) {
            const err = new Error('Please select a staff member');
            err.status = 400;
            throw err;
          }
          if (assignedStaffId) {
            const st = activeStaffList.find(function (s) { return s.id === assignedStaffId; });
            if (!st || !staffCanDoService(st, serviceId)) {
              const err = new Error('Selected staff is not available for this service');
              err.status = 400;
              throw err;
            }
            if (!staffWorksAt(st, date, startMin, reqEndMin, timeOffForDay)) {
              const err = new Error('Selected staff is unavailable at this time (hours, break, or time off)');
              err.status = 409;
              throw err;
            }
            assignedStaffName = st.name || 'Staff';
          }
        }

        const apptQuery = appointmentsCol.where('date', '==', date);
        const apptSnap = await tx.get(apptQuery);
        const appointments = [];
        apptSnap.forEach(function (d) { appointments.push(Object.assign({ id: d.id }, d.data())); });

        // Smart balanced auto-assign when no specific staff chosen
        if (activeStaffList.length && !assignedStaffId && staffMode !== 'required') {
          const eligible = activeStaffList.filter(function (s) { return staffCanDoService(s, serviceId); });
          const picked = pickStaffForSlot(eligible, appointments, date, startMin, reqEndMin, buffer, serviceId, timeOffForDay);
          if (picked) {
            assignedStaffId = picked.id;
            assignedStaffName = picked.name || 'Staff';
          } else if (eligible.length) {
            const err = new Error('Sorry, this time slot was just booked. Please choose another available time.');
            err.status = 409;
            throw err;
          }
        }

        let active;
        if (assignedStaffId) {
          active = getActiveAppointments(appointments.filter(function (a) { return a.staffId === assignedStaffId; }));
        } else {
          // Legacy business-level: all appointments conflict
          active = getActiveAppointments(appointments);
        }
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
        const bookingRef = makeBookingRef(date);
        const manageToken = makeManageToken();
        const tzOff = (settings.timezoneOffsetMinutes != null) ? Number(settings.timezoneOffsetMinutes) : 480;
        const startLocal = parseBusinessLocalDateTime(date, startTime, tzOff);
        const graceEnds = new Date(startLocal.getTime() + 15 * 60 * 1000);
        const reminderFor = new Date(startLocal.getTime() - 60 * 60 * 1000);

        const newRef = appointmentsCol.doc();
        const appointment = {
          tenantId,
          bookingId,
          bookingRef,
          bookingReference: bookingRef,
          manageToken,
          paymentMode: 'pay_at_venue',
          statusLabel: 'Confirmed — Pay at Venue',
          customerName: String(customerName).trim(),
          customerEmail: String(customerEmail).trim().toLowerCase(),
          customerPhone: String(customerPhone).trim().slice(0, 40),
          notes: String(notes).trim().slice(0, 500),
          serviceId,
          serviceName: service.name || '',
          serviceDuration: duration,
          servicePrice: price,
          staffId: assignedStaffId || null,
          staffName: assignedStaffName || null,
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
            bookingRef,
            manageToken,
            status,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
        }

        return { id: newRef.id, bookingId, bookingRef, manageToken, status, price, staffId: assignedStaffId || null, staffName: assignedStaffName || null, serviceName: service.name || '' };
      });

      let bookingRef = result.bookingRef || null;
      let manageToken = result.manageToken || null;

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
            message: (customerName || 'Customer') + ' booked ' + (result.serviceName || body.serviceName || 'a service') +
              (result.staffName ? (' with ' + result.staffName) : '') +
              (body.date ? (' for ' + body.date) : '') +
              (body.startTime ? (' at ' + body.startTime) : '') +
              (bookingRef ? (' · ' + bookingRef) : ''),
            read: false,
            meta: { appointmentId: result.id, bookingRef: bookingRef || null },
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
        } catch (e) {}
      }

      if (result.duplicate) {
        return res.status(200).json({
          ok: true,
          success: true,
          appointmentId: result.id,
          bookingId: result.bookingId,
          bookingRef,
          bookingReference: bookingRef,
          status: result.status,
          message: 'Booking already recorded',
          duplicate: true
        });
      }

      const manageUrl = manageToken
        ? ('/manage-booking.html?tenant=' + encodeURIComponent(tenantId) + '&ref=' + encodeURIComponent(bookingRef || '') + '&token=' + encodeURIComponent(manageToken))
        : null;

      if (!result.id || !bookingRef) {
        return res.status(500).json({
          ok: false,
          stage: 'post-write',
          error: 'Booking write did not return a reference',
          message: 'Booking could not be confirmed. Please try again.'
        });
      }

      return res.status(201).json({
        ok: true,
        success: true,
        appointmentId: result.id,
        bookingId: result.bookingId || result.id,
        bookingRef,
        bookingReference: bookingRef,
        manageToken,
        manageUrl,
        status: result.status || 'confirmed',
        paymentMode: 'pay_at_venue',
        message: 'Booking confirmed — Pay at Venue',
        serverBuild: SERVER_BUILD
      });
    }

    // ---------- walkIn (owner) ----------
    if (action === 'walkIn') {
      const idToken = body.idToken;
      if (!idToken) return res.status(401).json({ error: 'Auth required' });
      let m, tenantId;
      try {
        m = await authz.requireMembership(db, body.idToken || idToken, { permission: 'walkIn' });
        tenantId = m.tenantId;
      } catch (e) {
        return res.status(e.status || 403).json({ error: e.message || 'Forbidden' });
      }

      const serviceId = body.serviceId;
      const startTime = body.startTime;
      const customerName = String(body.customerName || 'Walk-in').trim().slice(0, 120);
      let requestedStaffId = body.staffId ? String(body.staffId).trim() : '';
      if (!serviceId || !startTime) return res.status(400).json({ error: 'serviceId and startTime required' });

      const settingsSnap = await db.doc('tenants/' + tenantId + '/settings/config').get();
      if (!settingsSnap.exists) return res.status(404).json({ error: 'Business not found' });
      const settings = settingsSnap.data();
      const date = body.date || authz.businessLocalDateISO(settings);
      const serviceSnap = await db.doc('tenants/' + tenantId + '/services/' + serviceId).get();
      if (!serviceSnap.exists) return res.status(404).json({ error: 'Service not found' });
      const service = serviceSnap.data();
      const duration = body.duration ? Number(body.duration) : (service.duration || 30);
      const startMin = timeToMinutes(startTime);
      const endTime = minutesToTime(startMin + duration);
      const endMin = startMin + duration;
      const buffer = (settings.bookingRules && settings.bookingRules.bufferMinutes) || 0;
      const timeOffForDay = await loadStaffTimeOffForDate(db, tenantId, date);
      const specialForWalkIn = await loadSpecialHoursForDate(db, tenantId, date);
      const dayHoursWi = resolveBusinessDayHours(settings, date, specialForWalkIn);
      if (dayHoursWi.closed) {
        return res.status(403).json({ error: dayHoursWi.reason || 'Business is closed on this date.' });
      }
      if (startMin < timeToMinutes(dayHoursWi.open) || endMin > timeToMinutes(dayHoursWi.close)) {
        return res.status(409).json({ error: 'Walk-in time is outside business hours for this date.' });
      }

      const result = await db.runTransaction(async (tx) => {
        const apptSnap = await tx.get(db.collection('tenants/' + tenantId + '/appointments').where('date', '==', date));
        const appointments = [];
        apptSnap.forEach(function (d) { appointments.push(Object.assign({ id: d.id }, d.data())); });

        const blockSnap = await tx.get(db.collection('tenants/' + tenantId + '/blockedSlots').where('date', '==', date));
        const blocks = [];
        blockSnap.forEach(function (d) { blocks.push(d.data()); });
        if (overlapsBlocks(startMin, endMin, blocks, date)) {
          const err = new Error('This time is blocked.');
          err.status = 409;
          throw err;
        }

        const staffCol = db.collection('tenants/' + tenantId + '/staff');
        const staffSnapAll = await staffCol.limit(100).get();
        const allStaff = [];
        staffSnapAll.forEach(function (d) {
          allStaff.push(Object.assign({ id: d.id }, d.data()));
        });
        const activeStaffList = allStaff.filter(function (s) { return s.active !== false; });

        let assignedStaffId = requestedStaffId;
        let assignedStaffName = '';

        if (activeStaffList.length) {
          if (assignedStaffId) {
            const st = activeStaffList.find(function (s) { return s.id === assignedStaffId; });
            if (!st || !staffCanDoService(st, serviceId)) {
              const err = new Error('Selected staff cannot perform this service');
              err.status = 400;
              throw err;
            }
            if (!staffWorksAt(st, date, startMin, endMin, timeOffForDay)) {
              const err = new Error('Selected staff is not working at this time');
              err.status = 409;
              throw err;
            }
            const staffAppts = getActiveAppointments(appointments.filter(function (a) { return a.staffId === assignedStaffId; }));
            if (overlapsAny(startMin, endMin, staffAppts, buffer)) {
              const err = new Error('Selected staff already has an appointment at this time');
              err.status = 409;
              throw err;
            }
            assignedStaffName = st.name || 'Staff';
          } else {
            const eligible = activeStaffList.filter(function (s) { return staffCanDoService(s, serviceId); });
            const picked = pickStaffForSlot(eligible, appointments, date, startMin, endMin, buffer, serviceId, timeOffForDay);
            if (picked) {
              assignedStaffId = picked.id;
              assignedStaffName = picked.name || 'Staff';
            } else if (eligible.length) {
              const err = new Error('No staff available at this time. Choose another time or staff member.');
              err.status = 409;
              throw err;
            }
          }
        }

        // Legacy conflict when no staff system
        if (!activeStaffList.length) {
          if (overlapsAny(startMin, endMin, getActiveAppointments(appointments), buffer)) {
            const err = new Error('This time conflicts with an existing appointment.');
            err.status = 409;
            throw err;
          }
        }

        const bookingId = makeBookingId();
        const newRef = db.collection('tenants/' + tenantId + '/appointments').doc();
        tx.set(newRef, {
          bookingId,
          customerName: customerName,
          customerEmail: '',
          customerPhone: '',
          serviceId,
          serviceName: service.name || '',
          serviceDuration: duration,
          servicePrice: Number(service.price || 0),
          staffId: assignedStaffId || null,
          staffName: assignedStaffName || null,
          date,
          startTime,
          endTime,
          status: 'confirmed',
          source: 'walk_in',
          depositStatus: 'none',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        return { id: newRef.id, bookingId, staffId: assignedStaffId || null, staffName: assignedStaffName || null };
      });

      try {
        await db.collection('tenants/' + tenantId + '/notifications').add({
          type: 'walk_in',
          title: 'Walk-in added',
          message: (customerName || 'Walk-in') + ' at ' + startTime +
            (result.staffName ? (' · ' + result.staffName) : ''),
          read: false,
          meta: { appointmentId: result.id },
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } catch (e) {}
      return res.status(201).json({
        success: true,
        appointmentId: result.id,
        bookingId: result.bookingId,
        staffId: result.staffId || null,
        staffName: result.staffName || null
      });
    }

    // ---------- blockTime ----------
    if (action === 'blockTime') {
      const idToken = body.idToken;
      if (!idToken) return res.status(401).json({ error: 'Auth required' });
      let m, tenantId;
      try {
        m = await authz.requireMembership(db, body.idToken || idToken, { permission: 'manageBlocks' });
        tenantId = m.tenantId;
      } catch (e) {
        return res.status(e.status || 403).json({ error: e.message || 'Forbidden' });
      }

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
      let m, tenantId;
      try {
        m = await authz.requireMembership(db, body.idToken || idToken, { permission: 'manageBlocks' });
        tenantId = m.tenantId;
      } catch (e) {
        return res.status(e.status || 403).json({ error: e.message || 'Forbidden' });
      }
      if (!body.blockId) return res.status(400).json({ error: 'blockId required' });
      await db.doc('tenants/' + tenantId + '/blockedSlots/' + body.blockId).delete();
      return res.status(200).json({ success: true });
    }

    if (action === 'listBlocked') {
      const idToken = body.idToken;
      if (!idToken) return res.status(401).json({ error: 'Auth required' });
      let m, tenantId;
      try {
        m = await authz.requireMembership(db, body.idToken || idToken, { permission: 'manageBlocks' });
        tenantId = m.tenantId;
      } catch (e) {
        return res.status(e.status || 403).json({ error: e.message || 'Forbidden' });
      }
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
      let m, tenantId;
      try {
        m = await authz.requireMembership(db, body.idToken || idToken, { ownerOnly: true });
        tenantId = m.tenantId;
      } catch (e) {
        return res.status(e.status || 403).json({ error: e.message || 'Forbidden' });
      }

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
        } catch (e) {}
      }

      try {
        await db.collection('tenants/' + tenantId + '/notifications').add({
          type: 'emergency',
          title: isClosed ? 'Emergency closure ON' : 'Emergency closure OFF',
          message: isClosed ? 'Online bookings are paused.' : 'Online bookings are open again.',
          read: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } catch (e) {}
      return res.status(200).json({ success: true, emergencyClosure: { isClosed: closure.isClosed, closureMessage: closure.closureMessage } });
    }

    // ---------- updateStatus (owner) ----------
    if (action === 'updateStatus') {
      const idToken = body.idToken;
      if (!idToken) return res.status(401).json({ error: 'Auth required' });
      let m, tenantId;
      try {
        m = await authz.requireMembership(db, body.idToken || idToken, { permission: 'manageAppointments' });
        tenantId = m.tenantId;
      } catch (e) {
        return res.status(e.status || 403).json({ error: e.message || 'Forbidden' });
      }
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

      try {
        const snap = await ref.get();
        const appt = snap.exists ? snap.data() : {};
        await db.collection('tenants/' + tenantId + '/notifications').add({
          type: 'status',
          title: 'Booking ' + newStatus.replace('_', ' '),
          message: (appt.customerName || 'Customer') + ' · ' + (appt.bookingRef || appt.bookingId || appointmentId) + ' → ' + newStatus,
          read: false,
          meta: { appointmentId: appointmentId },
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } catch (e) {}

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

    
    // ---------- Client self-service (token auth) ----------
    if (action === 'getManagedBooking') {
      const tenantId = String(body.tenantId || '').trim();
      const token = String(body.token || '').trim();
      const ref = String(body.ref || body.bookingRef || '').trim();
      if (!tenantId || !token || token.length < 20) {
        return res.status(400).json({ error: 'Invalid management link' });
      }
      let snap;
      if (ref) {
        const q = await db.collection('tenants/' + tenantId + '/appointments')
          .where('bookingRef', '==', ref).limit(5).get();
        snap = null;
        q.forEach((d) => {
          if (d.data().manageToken === token) snap = d;
        });
      }
      if (!snap) {
        // fallback scan limited — prefer index on manageToken later
        return res.status(404).json({ error: 'Booking not found or link expired' });
      }
      const a = snap.data();
      const st = a.status || 'confirmed';
      const settingsSnap = await db.doc('tenants/' + tenantId + '/settings/config').get();
      const settings = settingsSnap.exists ? settingsSnap.data() : {};
      const cancelEval = evaluateCancelPolicy(settings, a);
      const reschedEval = evaluateReschedulePolicy(settings, a);
      return res.status(200).json({
        appointmentId: snap.id,
        bookingRef: a.bookingRef || ref,
        status: st,
        date: a.date,
        startTime: a.startTime,
        endTime: a.endTime,
        serviceId: a.serviceId || '',
        serviceName: a.serviceName || '',
        durationMinutes: a.durationMinutes || a.serviceDuration || a.duration || 30,
        customerName: a.customerName || '',
        businessName: a.businessName || settings.businessName || '',
        paymentMode: a.paymentMode || 'pay_at_venue',
        rescheduleCount: Number(a.rescheduleCount || 0),
        canReschedule: !!reschedEval.ok,
        canCancel: !!cancelEval.ok,
        rescheduleBlockedReason: reschedEval.ok ? null : (reschedEval.reason || null),
        cancelBlockedReason: cancelEval.ok ? null : (cancelEval.reason || null),
        policySummary: policySummaryText(settings)
      });
    }

    if (action === 'cancelManagedBooking') {
      const tenantId = String(body.tenantId || '').trim();
      const token = String(body.token || '').trim();
      const ref = String(body.ref || '').trim();
      if (!tenantId || !token || token.length < 20 || !ref) {
        return res.status(400).json({ error: 'Invalid request' });
      }
      const q = await db.collection('tenants/' + tenantId + '/appointments')
        .where('bookingRef', '==', ref).limit(5).get();
      let doc = null;
      q.forEach((d) => { if (d.data().manageToken === token) doc = d; });
      if (!doc) return res.status(404).json({ error: 'Booking not found' });
      const a = doc.data();
      const settingsSnapC = await db.doc('tenants/' + tenantId + '/settings/config').get();
      const settingsC = settingsSnapC.exists ? settingsSnapC.data() : {};
      const cancelEval = evaluateCancelPolicy(settingsC, a);
      if (!cancelEval.ok) {
        return res.status(403).json({ error: cancelEval.reason || 'Cancellation not allowed' });
      }
      await db.runTransaction(async (tx) => {
        const fresh = await tx.get(doc.ref);
        if (!fresh.exists) {
          const err = new Error('Booking not found');
          err.status = 404;
          throw err;
        }
        const curData = fresh.data();
        const cur = curData.status;
        if (['cancelled', 'completed', 'no_show'].includes(cur)) {
          const err = new Error('Booking cannot be cancelled');
          err.status = 400;
          throw err;
        }
        const reEval = evaluateCancelPolicy(settingsC, curData);
        if (!reEval.ok) {
          const err = new Error(reEval.reason || 'Cancellation not allowed');
          err.status = 403;
          throw err;
        }
        tx.set(doc.ref, {
          status: 'cancelled',
          cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
          cancelledBy: 'customer',
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      });
      try {
        await db.collection('tenants/' + tenantId + '/notifications').add({
          type: 'cancelled',
          title: 'Booking cancelled',
          message: (a.bookingRef || ref) + ' was cancelled by customer',
          read: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } catch (e) {}
      return res.status(200).json({ success: true, status: 'cancelled' });
    }



    // ---------- Client: reschedule managed booking (atomic) ----------
    if (action === 'rescheduleManagedBooking') {
      const tenantId = String(body.tenantId || '').trim();
      const token = String(body.token || '').trim();
      const ref = String(body.ref || body.bookingRef || '').trim();
      const newDate = String(body.newDate || body.date || '').trim();
      const newStartTime = String(body.newStartTime || body.startTime || '').trim();
      if (!tenantId || !token || token.length < 20 || !ref) {
        return res.status(400).json({ error: 'Invalid management link' });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate)) {
        return res.status(400).json({ error: 'Invalid date' });
      }
      if (!/^\d{1,2}:\d{2}$/.test(newStartTime)) {
        return res.status(400).json({ error: 'Invalid start time' });
      }

      const bookable = await assertTenantBookable(db, tenantId);
      if (!bookable.ok) return res.status(403).json({ error: bookable.error });

      const q = await db.collection('tenants/' + tenantId + '/appointments')
        .where('bookingRef', '==', ref).limit(5).get();
      let doc = null;
      q.forEach(function (d) {
        if (d.data().manageToken === token) doc = d;
      });
      if (!doc) return res.status(404).json({ error: 'Booking not found or link invalid' });

      const settingsSnap = await db.doc('tenants/' + tenantId + '/settings/config').get();
      if (!settingsSnap.exists) return res.status(404).json({ error: 'Business not found' });
      const settings = settingsSnap.data();
      const specialRs = await loadSpecialHoursForDate(db, tenantId, newDate);
      const dayHoursRs = resolveBusinessDayHours(settings, newDate, specialRs);
      if (dayHoursRs.closed) {
        return res.status(409).json({
          error: dayHoursRs.reason || 'This business is unavailable on the selected date.'
        });
      }

      const a0 = doc.data();
      const rsEval = evaluateReschedulePolicy(settings, a0);
      if (!rsEval.ok) {
        return res.status(403).json({ error: rsEval.reason || 'Reschedule not allowed' });
      }

      let duration = Number(a0.durationMinutes || a0.serviceDuration || a0.duration || 0);
      if (!duration && a0.serviceId) {
        const svc = await db.doc('tenants/' + tenantId + '/services/' + a0.serviceId).get();
        if (svc.exists) duration = Number(svc.data().duration || 30);
      }
      if (!duration) duration = 30;
      const buffer = (settings.bookingRules && settings.bookingRules.bufferMinutes) || 0;
      const startMin = timeToMinutes(newStartTime);
      const endMin = startMin + duration;
      const newEndTime = minutesToTime(endMin);

      // Validate against effective business hours (weekly or special)
      const openMin = timeToMinutes(dayHoursRs.open);
      const closeMin = timeToMinutes(dayHoursRs.close);
      if (startMin < openMin || endMin > closeMin) {
        return res.status(409).json({ error: 'Selected time is outside business hours' });
      }

      const blocks = await loadBlocksForDate(db, tenantId, newDate);
      if (overlapsBlocks(startMin, endMin, blocks, newDate)) {
        return res.status(409).json({ error: 'Selected time is blocked' });
      }

      let updated;
      try {
        updated = await db.runTransaction(async function (tx) {
          const fresh = await tx.get(doc.ref);
          if (!fresh.exists) {
            const err = new Error('Booking not found');
            err.status = 404;
            throw err;
          }
          const cur = fresh.data();
          if (cur.manageToken !== token) {
            const err = new Error('Invalid management link');
            err.status = 403;
            throw err;
          }
          const st = cur.status || 'confirmed';
          const reEval = evaluateReschedulePolicy(settings, cur);
          if (!reEval.ok) {
            const err = new Error(reEval.reason || 'Reschedule not allowed');
            err.status = 403;
            throw err;
          }

          const appointmentsCol = db.collection('tenants/' + tenantId + '/appointments');
          const apptSnap = await tx.get(appointmentsCol.where('date', '==', newDate));
          const others = [];
          apptSnap.forEach(function (d) {
            if (d.id === doc.id) return;
            others.push(Object.assign({ id: d.id }, d.data()));
          });
          const active = getActiveAppointments(others);
          if (overlapsAny(startMin, endMin, active, buffer)) {
            const err = new Error('That time is no longer available. Please choose another slot.');
            err.status = 409;
            throw err;
          }

          const prevDate = cur.date;
          const prevStart = cur.startTime;
          const prevEnd = cur.endTime;
          const normStart = (newStartTime.length === 4 && newStartTime.indexOf(':') === 1)
            ? ('0' + newStartTime)
            : newStartTime;
          const prevCount = Number(cur.rescheduleCount || 0);
          tx.set(doc.ref, {
            date: newDate,
            startTime: normStart,
            endTime: newEndTime,
            durationMinutes: duration,
            previousDate: prevDate || null,
            previousStartTime: prevStart || null,
            previousEndTime: prevEnd || null,
            rescheduleCount: prevCount + 1,
            rescheduledAt: admin.firestore.FieldValue.serverTimestamp(),
            rescheduledBy: 'customer',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
          return {
            appointmentId: doc.id,
            date: newDate,
            startTime: newStartTime,
            endTime: newEndTime,
            previousDate: prevDate,
            previousStartTime: prevStart,
            customerName: cur.customerName,
            serviceName: cur.serviceName,
            bookingRef: cur.bookingRef || ref
          };
        });
      } catch (e) {
        if (e.status) return res.status(e.status).json({ error: e.message });
        throw e;
      }

      try {
        await db.collection('tenants/' + tenantId + '/notifications').add({
          type: 'rescheduled',
          title: 'Appointment rescheduled',
          message: (updated.customerName || 'Customer') + ' moved their appointment to ' +
            updated.date + ' at ' + updated.startTime,
          read: false,
          meta: { appointmentId: updated.appointmentId, bookingRef: updated.bookingRef || ref },
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } catch (e) {}

      return res.status(200).json({
        success: true,
        appointmentId: updated.appointmentId,
        date: updated.date,
        startTime: updated.startTime,
        endTime: updated.endTime,
        previousDate: updated.previousDate,
        previousStartTime: updated.previousStartTime,
        bookingRef: updated.bookingRef
      });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('create-booking error:', err);
    const status = err.status || 500;
    return res.status(status).json({
      ok: false,
      stage: err.stage || 'server',
      error: err.message || 'Internal server error',
      message: err.message || 'Internal server error',
      serverBuild: SERVER_BUILD
    });
  }
};
