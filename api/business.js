/**
 * POST /api/business
 * CRM, waitlist, cancel-with-recovery, analytics helpers
 * Auth: Firebase ID token for owner actions; public for waitlist join
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
    console.error(e.message);
    return false;
  }
}

function timeToMinutes(t) {
  if (!t) return 0;
  const p = String(t).split(':');
  return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
}

function customerIdFromContact(email, phone) {
  const key = (String(email || '').trim().toLowerCase() || String(phone || '').trim()).slice(0, 120);
  if (!key) return null;
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 28);
}

async function verifyOwner(idToken) {
  const decoded = await admin.auth().verifyIdToken(idToken);
  return decoded.uid;
}

function tagCustomer(c) {
  const tags = [];
  const completed = Number(c.completedBookings || 0);
  const noShow = Number(c.noShowCount || 0);
  const cancelled = Number(c.cancelledBookings || 0);
  const total = Number(c.totalBookings || 0);
  const last = c.lastVisitAt && c.lastVisitAt.toDate ? c.lastVisitAt.toDate() : null;
  const daysSince = last ? (Date.now() - last.getTime()) / 86400000 : 999;

  if (completed <= 1 && total <= 1) tags.push('NEW');
  if (completed >= 2) tags.push('RETURNING');
  if (completed >= 5) tags.push('LOYAL');
  if (daysSince >= 60 && completed >= 1) tags.push('INACTIVE');
  if (Number(c.totalSpent || 0) >= 5000) tags.push('HIGH_VALUE');
  if (cancelled >= 3 && cancelled > completed) tags.push('FREQUENT_CANCEL');
  if (noShow >= 2) tags.push('FREQUENT_NO_SHOW');
  return tags;
}

/**
 * Upsert customer stats after booking lifecycle events.
 * server-only
 */
async function upsertCustomerFromAppointment(db, tenantId, appt, event) {
  const cid = customerIdFromContact(appt.customerEmail, appt.customerPhone);
  if (!cid) return null;
  const ref = db.doc('tenants/' + tenantId + '/customers/' + cid);
  const snap = await ref.get();
  const now = admin.firestore.FieldValue.serverTimestamp();
  const base = snap.exists
    ? snap.data()
    : {
        name: appt.customerName || '',
        email: (appt.customerEmail || '').toLowerCase(),
        phone: appt.customerPhone || '',
        totalBookings: 0,
        completedBookings: 0,
        cancelledBookings: 0,
        noShowCount: 0,
        totalSpent: 0,
        favoriteService: '',
        favoriteServiceCount: 0,
        notes: '',
        createdAt: now
      };

  const patch = {
    name: appt.customerName || base.name,
    email: (appt.customerEmail || base.email || '').toLowerCase(),
    phone: appt.customerPhone || base.phone || '',
    updatedAt: now
  };

  if (event === 'created') {
    patch.totalBookings = admin.firestore.FieldValue.increment(1);
  }
  if (event === 'completed') {
    patch.completedBookings = admin.firestore.FieldValue.increment(1);
    patch.totalSpent = admin.firestore.FieldValue.increment(Number(appt.servicePrice || 0));
    patch.lastVisitAt = now;
    const rebookDays = Number(appt.recommendedRebookDays || 30);
    const next = new Date();
    next.setDate(next.getDate() + rebookDays);
    patch.nextRecommendedBookingAt = admin.firestore.Timestamp.fromDate(next);
    patch.retentionStatus = 'active';
  }
  if (event === 'cancelled') {
    patch.cancelledBookings = admin.firestore.FieldValue.increment(1);
  }
  if (event === 'no_show') {
    patch.noShowCount = admin.firestore.FieldValue.increment(1);
  }

  // favorite service (best-effort on completed)
  if (event === 'completed' && appt.serviceName) {
    const prevFav = base.favoriteService || '';
    const prevCount = Number(base.favoriteServiceCount || 0);
    if (appt.serviceName === prevFav) {
      patch.favoriteServiceCount = prevCount + 1;
      patch.favoriteService = prevFav;
    } else if (!prevFav) {
      patch.favoriteService = appt.serviceName;
      patch.favoriteServiceCount = 1;
    }
  }

  await ref.set(Object.assign({}, base, patch), { merge: true });
  return cid;
}

async function findWaitlistMatches(db, tenantId, { date, startTime, endTime, serviceId }) {
  const startMin = timeToMinutes(startTime);
  const endMin = timeToMinutes(endTime);
  const snap = await db
    .collection('tenants/' + tenantId + '/waitlist')
    .where('status', '==', 'waiting')
    .where('preferredDate', '==', date)
    .limit(30)
    .get();

  const matches = [];
  snap.forEach((d) => {
    const w = Object.assign({ id: d.id }, d.data());
    if (serviceId && w.serviceId && w.serviceId !== serviceId) return;
    const prefStart = timeToMinutes(w.preferredStartTime || '00:00');
    const prefEnd = timeToMinutes(w.preferredEndTime || '23:59');
    // slot must fall within preferred window
    if (startMin >= prefStart && endMin <= prefEnd) {
      matches.push(w);
    } else if (startMin < prefEnd && endMin > prefStart) {
      matches.push(w);
    }
  });
  matches.sort((a, b) => {
    const ta = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0;
    const tb = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0;
    return ta - tb;
  });
  return matches;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!initAdmin()) return res.status(500).json({ error: 'Admin not configured' });

  const db = admin.firestore();
  const body = req.body || {};
  const action = body.action;

  try {
    // ---------- Public: join waitlist ----------
    if (action === 'joinWaitlist') {
      if (body.website || body.hp_field) {
        return res.status(200).json({ success: true });
      }
      const tenantId = body.tenantId;
      const serviceId = body.serviceId;
      const preferredDate = body.preferredDate;
      const preferredStartTime = body.preferredStartTime || '09:00';
      const preferredEndTime = body.preferredEndTime || '17:00';
      const customerName = String(body.customerName || '').trim();
      const customerEmail = String(body.customerEmail || '').trim().toLowerCase();
      const customerPhone = String(body.customerPhone || '').trim();

      if (!tenantId || !serviceId || !preferredDate || !customerName) {
        return res.status(400).json({ error: 'Missing required waitlist fields' });
      }
      if (!customerEmail && !customerPhone) {
        return res.status(400).json({ error: 'Email or phone required' });
      }

      const settingsSnap = await db.doc('tenants/' + tenantId + '/settings/config').get();
      if (!settingsSnap.exists) return res.status(404).json({ error: 'Business not found' });

      const expires = new Date();
      expires.setDate(expires.getDate() + 14);

      const ref = await db.collection('tenants/' + tenantId + '/waitlist').add({
        customerName,
        customerEmail,
        customerPhone,
        serviceId,
        preferredDate,
        preferredStartTime,
        preferredEndTime,
        staffId: body.staffId || null,
        status: 'waiting',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        notifiedAt: null,
        expiresAt: admin.firestore.Timestamp.fromDate(expires)
      });

      return res.status(201).json({ success: true, waitlistId: ref.id });
    }

    // ---------- Owner: list waitlist ----------
    if (action === 'listWaitlist') {
      const uid = await verifyOwner(body.idToken);
      const tenantId = body.tenantId || uid;
      if (tenantId !== uid) return res.status(403).json({ error: 'Forbidden' });
      const snap = await db
        .collection('tenants/' + tenantId + '/waitlist')
        .where('status', 'in', ['waiting', 'offered'])
        .limit(50)
        .get();
      const items = [];
      snap.forEach((d) => {
        const x = d.data();
        items.push({
          id: d.id,
          customerName: x.customerName,
          preferredDate: x.preferredDate,
          preferredStartTime: x.preferredStartTime,
          preferredEndTime: x.preferredEndTime,
          serviceId: x.serviceId,
          status: x.status,
          customerPhone: x.customerPhone,
          customerEmail: x.customerEmail
        });
      });
      return res.status(200).json({ items });
    }

    // ---------- Owner: list customers ----------
    if (action === 'listCustomers') {
      const uid = await verifyOwner(body.idToken);
      const tenantId = body.tenantId || uid;
      if (tenantId !== uid) return res.status(403).json({ error: 'Forbidden' });
      const snap = await db.collection('tenants/' + tenantId + '/customers').limit(100).get();
      const items = [];
      snap.forEach((d) => {
        const c = d.data();
        items.push({
          id: d.id,
          name: c.name,
          email: c.email,
          phone: c.phone,
          totalBookings: c.totalBookings || 0,
          completedBookings: c.completedBookings || 0,
          cancelledBookings: c.cancelledBookings || 0,
          noShowCount: c.noShowCount || 0,
          totalSpent: c.totalSpent || 0,
          favoriteService: c.favoriteService || '',
          tags: tagCustomer(c),
          notes: c.notes || '',
          lastVisitAt: c.lastVisitAt && c.lastVisitAt.toDate ? c.lastVisitAt.toDate().toISOString() : null,
          nextRecommendedBookingAt:
            c.nextRecommendedBookingAt && c.nextRecommendedBookingAt.toDate
              ? c.nextRecommendedBookingAt.toDate().toISOString()
              : null
        });
      });
      items.sort((a, b) => (b.totalBookings || 0) - (a.totalBookings || 0));
      return res.status(200).json({ items });
    }

    // ---------- Owner: save customer notes ----------
    if (action === 'saveCustomerNotes') {
      const uid = await verifyOwner(body.idToken);
      const tenantId = body.tenantId || uid;
      if (tenantId !== uid) return res.status(403).json({ error: 'Forbidden' });
      if (!body.customerId) return res.status(400).json({ error: 'customerId required' });
      await db.doc('tenants/' + tenantId + '/customers/' + body.customerId).set(
        {
          notes: String(body.notes || '').slice(0, 1000),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );
      return res.status(200).json({ success: true });
    }

    // ---------- Owner: cancel appointment + waitlist offer ----------
    if (action === 'cancelAppointment') {
      const uid = await verifyOwner(body.idToken);
      const tenantId = body.tenantId || uid;
      if (tenantId !== uid) return res.status(403).json({ error: 'Forbidden' });
      const appointmentId = body.appointmentId;
      if (!appointmentId) return res.status(400).json({ error: 'appointmentId required' });

      const apptRef = db.doc('tenants/' + tenantId + '/appointments/' + appointmentId);
      let apptData = null;

      await db.runTransaction(async (tx) => {
        const snap = await tx.get(apptRef);
        if (!snap.exists) {
          const err = new Error('Appointment not found');
          err.status = 404;
          throw err;
        }
        apptData = snap.data();
        const st = apptData.status || 'confirmed';
        if (st === 'cancelled' || st === 'completed') {
          const err = new Error('Cannot cancel this appointment');
          err.status = 400;
          throw err;
        }
        tx.update(apptRef, {
          status: 'cancelled',
          cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      });

      try {
        await upsertCustomerFromAppointment(db, tenantId, apptData, 'cancelled');
      } catch (e) {
        console.warn('crm cancel', e.message);
      }

      // Offer slot to waitlist (temporary reservation)
      let offer = null;
      try {
        const matches = await findWaitlistMatches(db, tenantId, {
          date: apptData.date,
          startTime: apptData.startTime,
          endTime: apptData.endTime,
          serviceId: apptData.serviceId
        });
        if (matches.length) {
          const candidate = matches[0];
          const holdUntil = new Date(Date.now() + 30 * 60 * 1000); // 30 min hold
          const offerRef = await db.collection('tenants/' + tenantId + '/slotOffers').add({
            waitlistId: candidate.id,
            appointmentFreedId: appointmentId,
            date: apptData.date,
            startTime: apptData.startTime,
            endTime: apptData.endTime,
            serviceId: apptData.serviceId,
            serviceName: apptData.serviceName || '',
            customerName: candidate.customerName,
            customerEmail: candidate.customerEmail,
            customerPhone: candidate.customerPhone,
            status: 'pending',
            holdUntil: admin.firestore.Timestamp.fromDate(holdUntil),
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
          await db.doc('tenants/' + tenantId + '/waitlist/' + candidate.id).set(
            {
              status: 'offered',
              notifiedAt: admin.firestore.FieldValue.serverTimestamp(),
              lastOfferId: offerRef.id
            },
            { merge: true }
          );
          await db.collection('tenants/' + tenantId + '/notifications').add({
            type: 'waitlist_offer',
            title: 'Waitlist match',
            message:
              candidate.customerName +
              ' can be offered ' +
              apptData.date +
              ' ' +
              apptData.startTime,
            read: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
          offer = {
            offerId: offerRef.id,
            waitlistId: candidate.id,
            customerName: candidate.customerName,
            holdUntil: holdUntil.toISOString()
          };
        }
      } catch (e) {
        console.warn('waitlist match', e.message);
      }

      return res.status(200).json({ success: true, waitlistOffer: offer });
    }

    // ---------- Claim waitlist offer (creates booking via transaction) ----------
    if (action === 'claimWaitlistOffer') {
      // Owner can confirm on behalf of customer (phone claim)
      const uid = await verifyOwner(body.idToken);
      const tenantId = body.tenantId || uid;
      if (tenantId !== uid) return res.status(403).json({ error: 'Forbidden' });
      const offerId = body.offerId;
      if (!offerId) return res.status(400).json({ error: 'offerId required' });

      const result = await db.runTransaction(async (tx) => {
        const offerRef = db.doc('tenants/' + tenantId + '/slotOffers/' + offerId);
        const offerSnap = await tx.get(offerRef);
        if (!offerSnap.exists) {
          const err = new Error('Offer not found');
          err.status = 404;
          throw err;
        }
        const offer = offerSnap.data();
        if (offer.status !== 'pending') {
          const err = new Error('Offer is no longer available');
          err.status = 409;
          throw err;
        }
        if (offer.holdUntil && offer.holdUntil.toMillis && offer.holdUntil.toMillis() < Date.now()) {
          tx.update(offerRef, { status: 'expired' });
          const err = new Error('Offer expired');
          err.status = 410;
          throw err;
        }

        // Conflict check
        const apptSnap = await tx.get(
          db.collection('tenants/' + tenantId + '/appointments').where('date', '==', offer.date)
        );
        const startMin = timeToMinutes(offer.startTime);
        const endMin = timeToMinutes(offer.endTime);
        let conflict = false;
        apptSnap.forEach((d) => {
          const a = d.data();
          const s = a.status || 'confirmed';
          if (s === 'cancelled' || s === 'no_show') return;
          const es = timeToMinutes(a.startTime);
          const ee = timeToMinutes(a.endTime);
          if (startMin < ee && endMin > es) conflict = true;
        });
        if (conflict) {
          const err = new Error('Slot was just taken');
          err.status = 409;
          throw err;
        }

        const bookingId =
          'BK-' + new Date().getFullYear() + '-' + Math.random().toString(36).slice(2, 10).toUpperCase();
        const newRef = db.collection('tenants/' + tenantId + '/appointments').doc();
        const startIso = offer.date + 'T' + offer.startTime + ':00';
        const graceEnds = new Date(new Date(startIso).getTime() + 15 * 60 * 1000 + 8 * 3600000);

        tx.set(newRef, {
          bookingId,
          customerName: offer.customerName,
          customerEmail: offer.customerEmail || '',
          customerPhone: offer.customerPhone || '',
          notes: 'From waitlist',
          serviceId: offer.serviceId,
          serviceName: offer.serviceName || '',
          serviceDuration: endMin - startMin,
          servicePrice: 0,
          date: offer.date,
          startTime: offer.startTime,
          endTime: offer.endTime,
          status: 'confirmed',
          source: 'waitlist',
          waitlistId: offer.waitlistId,
          gracePeriodEndsAt: admin.firestore.Timestamp.fromDate(graceEnds),
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        tx.update(offerRef, {
          status: 'claimed',
          appointmentId: newRef.id,
          claimedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        if (offer.waitlistId) {
          tx.set(
            db.doc('tenants/' + tenantId + '/waitlist/' + offer.waitlistId),
            { status: 'converted', updatedAt: admin.firestore.FieldValue.serverTimestamp() },
            { merge: true }
          );
        }
        return { appointmentId: newRef.id, bookingId };
      });

      return res.status(201).json({ success: true, ...result });
    }

    // ---------- Sync CRM from appointment status (called after check-in/complete/no-show) ----------
    if (action === 'syncCustomerEvent') {
      const uid = await verifyOwner(body.idToken);
      const tenantId = body.tenantId || uid;
      if (tenantId !== uid) return res.status(403).json({ error: 'Forbidden' });
      const appointmentId = body.appointmentId;
      const event = body.event; // completed | no_show | created
      if (!appointmentId || !event) return res.status(400).json({ error: 'appointmentId and event required' });
      const snap = await db.doc('tenants/' + tenantId + '/appointments/' + appointmentId).get();
      if (!snap.exists) return res.status(404).json({ error: 'Not found' });
      const appt = snap.data();
      // attach service rebook days if available
      if (appt.serviceId) {
        try {
          const s = await db.doc('tenants/' + tenantId + '/services/' + appt.serviceId).get();
          if (s.exists && s.data().recommendedRebookDays) {
            appt.recommendedRebookDays = s.data().recommendedRebookDays;
          }
        } catch (e) {}
      }
      await upsertCustomerFromAppointment(db, tenantId, appt, event);
      return res.status(200).json({ success: true });
    }

    // ---------- Dashboard summary ----------
    if (action === 'dashboardSummary') {
      const uid = await verifyOwner(body.idToken);
      const tenantId = body.tenantId || uid;
      if (tenantId !== uid) return res.status(403).json({ error: 'Forbidden' });

      const today = new Date().toISOString().slice(0, 10);
      const apptSnap = await db.collection('tenants/' + tenantId + '/appointments').limit(500).get();
      const byService = {};
      let todayTotal = 0,
        todayDone = 0,
        todayCancel = 0,
        todayNoShow = 0,
        todayUpcoming = 0;
      let weekBookings = 0,
        monthBookings = 0,
        monthRevenue = 0;
      const weekAgo = Date.now() - 7 * 86400000;
      const monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);

      apptSnap.forEach((d) => {
        const a = d.data();
        const st = a.status || 'confirmed';
        const dt = a.date || '';
        if (dt === today) {
          todayTotal++;
          if (st === 'completed') todayDone++;
          if (st === 'cancelled') todayCancel++;
          if (st === 'no_show') todayNoShow++;
          if (st !== 'cancelled' && st !== 'no_show' && st !== 'completed') todayUpcoming++;
        }
        const dayMs = new Date(dt + 'T12:00:00').getTime();
        if (dayMs >= weekAgo) weekBookings++;
        if (dayMs >= monthStart.getTime()) {
          monthBookings++;
          if (st === 'completed') monthRevenue += Number(a.servicePrice || 0);
        }
        const sn = a.serviceName || 'Service';
        if (!byService[sn]) byService[sn] = { name: sn, total: 0, completed: 0, cancelled: 0, noShow: 0, revenue: 0 };
        byService[sn].total++;
        if (st === 'completed') {
          byService[sn].completed++;
          byService[sn].revenue += Number(a.servicePrice || 0);
        }
        if (st === 'cancelled') byService[sn].cancelled++;
        if (st === 'no_show') byService[sn].noShow++;
      });

      const services = Object.values(byService).sort((a, b) => b.total - a.total);
      const custSnap = await db.collection('tenants/' + tenantId + '/customers').limit(200).get();
      let returning = 0,
        inactive = 0,
        dueRebook = 0;
      const dueList = [];
      const now = Date.now();
      custSnap.forEach((d) => {
        const c = d.data();
        if (Number(c.completedBookings || 0) >= 2) returning++;
        const last = c.lastVisitAt && c.lastVisitAt.toDate ? c.lastVisitAt.toDate().getTime() : 0;
        if (last && now - last > 60 * 86400000) inactive++;
        const next = c.nextRecommendedBookingAt && c.nextRecommendedBookingAt.toDate
          ? c.nextRecommendedBookingAt.toDate().getTime()
          : 0;
        if (next && next <= now && Number(c.completedBookings || 0) >= 1) {
          dueRebook++;
          dueList.push({
            id: d.id,
            name: c.name,
            phone: c.phone,
            email: c.email,
            favoriteService: c.favoriteService || ''
          });
        }
      });

      return res.status(200).json({
        today: {
          total: todayTotal,
          completed: todayDone,
          cancelled: todayCancel,
          noShows: todayNoShow,
          upcoming: todayUpcoming
        },
        week: { bookings: weekBookings },
        month: {
          bookings: monthBookings,
          estimatedRevenue: monthRevenue,
          note: 'Estimated from completed service prices, not verified payments'
        },
        services: services.slice(0, 8),
        retention: { returning, inactive, dueRebook, dueList: dueList.slice(0, 20) }
      });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('business API', err);
    return res.status(err.status || 500).json({ error: err.message || 'Internal error' });
  }
};

// Export helper for create-booking if needed later
module.exports.upsertCustomerFromAppointment = upsertCustomerFromAppointment;
module.exports.customerIdFromContact = customerIdFromContact;
