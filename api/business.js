/**
 * POST /api/business
 * CRM, waitlist, cancel-with-recovery, analytics helpers
 * Auth: Firebase ID token for owner actions; public for waitlist join
 */

const admin = require('firebase-admin');
const crypto = require('crypto');
const authz = require('./authz');

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

const ROLE_PERMS = {
  owner: [
    'full',
    'viewAppointments', 'manageAppointments', 'manageCustomers', 'manageWaitlist',
    'manageStaff', 'manageStaffAvailability', 'manageSpecialHours', 'manageSettings',
    'manageServices', 'viewAnalytics', 'manageTeamAccounts'
  ],
  manager: [
    'viewAppointments', 'manageAppointments', 'manageCustomers', 'manageWaitlist',
    'manageStaffAvailability', 'manageSpecialHours', 'manageServices', 'viewAnalytics'
  ],
  staff: [
    'viewOwnAppointments', 'updateOwnAppointmentStatus', 'viewOwnSchedule'
  ]
};

function hasPermission(role, perm) {
  const r = String(role || '').toLowerCase();
  const list = ROLE_PERMS[r] || ROLE_PERMS.staff;
  return list.indexOf('full') !== -1 || list.indexOf(perm) !== -1;
}

/**
 * Resolve authenticated user context.
 * Owner: uid === tenantId (legacy BookAI model).
 * Staff: platformStaffIndex/{uid} + staff doc accountStatus active.
 */
async function resolveMembership(db, idToken) {
  const decoded = await admin.auth().verifyIdToken(idToken);
  const uid = decoded.uid;
  const email = (decoded.email || '').toLowerCase();

  // Owner path: platform tenant or settings under tenants/uid
  const plat = await db.doc('platformTenants/' + uid).get();
  const settings = await db.doc('tenants/' + uid + '/settings/config').get();
  if (plat.exists || settings.exists) {
    return {
      uid,
      email,
      isOwner: true,
      tenantId: uid,
      staffId: null,
      accessRole: 'owner',
      accountStatus: 'active',
      permissions: ROLE_PERMS.owner
    };
  }

  // Staff path via index
  const idx = await db.doc('platformStaffIndex/' + uid).get();
  if (idx.exists) {
    const ix = idx.data() || {};
    if (ix.status === 'disabled') {
      return { uid, email, isOwner: false, denied: true, reason: 'Your staff access has been disabled.' };
    }
    const tenantId = ix.tenantId;
    const staffId = ix.staffId;
    if (!tenantId || !staffId) {
      return { uid, email, isOwner: false, denied: true, reason: 'Staff membership is incomplete.' };
    }
    const staffSnap = await db.doc('tenants/' + tenantId + '/staff/' + staffId).get();
    if (!staffSnap.exists) {
      return { uid, email, isOwner: false, denied: true, reason: 'Staff profile not found.' };
    }
    const staff = staffSnap.data();
    if (staff.authUid && staff.authUid !== uid) {
      return { uid, email, isOwner: false, denied: true, reason: 'Account mismatch.' };
    }
    if (staff.accountStatus === 'disabled') {
      return { uid, email, isOwner: false, denied: true, reason: 'Your staff access has been disabled.' };
    }
    if (staff.accountStatus !== 'active' && staff.accountStatus !== 'invited') {
      // invited can activate on first login
    }
    const role = (staff.accessRole || ix.accessRole || 'staff').toLowerCase();
    if (role !== 'manager' && role !== 'staff') {
      // invalid
    }
    // Auto-activate invited on successful login
    if (staff.accountStatus === 'invited' || staff.accountStatus === 'pending') {
      await staffSnap.ref.set({
        accountStatus: 'active',
        authUid: uid,
        accountEmail: email || staff.accountEmail || null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      await idx.ref.set({ status: 'active', accessRole: role }, { merge: true });
    }
    return {
      uid,
      email,
      isOwner: false,
      isStaff: true,
      tenantId,
      staffId,
      accessRole: role === 'manager' ? 'manager' : 'staff',
      accountStatus: 'active',
      staffName: staff.name || 'Staff',
      permissions: ROLE_PERMS[role === 'manager' ? 'manager' : 'staff']
    };
  }

  // Fallback: invited staff by email (collection group not used — scan requires owner to re-link after signup)
  // When staff signs up with invited email, owner should click Connect again OR we search platformStaffIndex by email field
  if (email) {
    const byEmail = await db.collection('platformStaffIndex').where('accountEmail', '==', email).limit(3).get();
    if (!byEmail.empty) {
      // Prefer matching invited entries and bind uid
      let chosen = null;
      byEmail.forEach(function (d) {
        const x = d.data();
        if (!chosen) chosen = { id: d.id, data: x, ref: d.ref };
      });
      if (chosen && chosen.data.tenantId && chosen.data.staffId) {
        const staffRef = db.doc('tenants/' + chosen.data.tenantId + '/staff/' + chosen.data.staffId);
        const staffSnap = await staffRef.get();
        if (staffSnap.exists && staffSnap.data().accountStatus !== 'disabled') {
          const role = (staffSnap.data().accessRole || chosen.data.accessRole || 'staff').toLowerCase();
          // Re-key index to real uid
          if (chosen.id !== uid) {
            await chosen.ref.delete();
          }
          await db.doc('platformStaffIndex/' + uid).set({
            tenantId: chosen.data.tenantId,
            staffId: chosen.data.staffId,
            accessRole: role === 'manager' ? 'manager' : 'staff',
            status: 'active',
            accountEmail: email,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
          await staffRef.set({
            authUid: uid,
            accountEmail: email,
            accountStatus: 'active',
            accessRole: role === 'manager' ? 'manager' : 'staff',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
          return {
            uid,
            email,
            isOwner: false,
            isStaff: true,
            tenantId: chosen.data.tenantId,
            staffId: chosen.data.staffId,
            accessRole: role === 'manager' ? 'manager' : 'staff',
            accountStatus: 'active',
            staffName: staffSnap.data().name || 'Staff',
            permissions: ROLE_PERMS[role === 'manager' ? 'manager' : 'staff']
          };
        }
      }
    }
  }

  return {
    uid,
    email,
    isOwner: false,
    isStaff: false,
    denied: true,
    reason: 'No business access is linked to this account. Ask the business owner to connect your email in Team settings.'
  };
}

async function requireMembership(db, idToken, opts) {
  opts = opts || {};
  const m = await resolveMembership(db, idToken);
  if (m.denied) {
    const err = new Error(m.reason || 'Access denied');
    err.status = 403;
    throw err;
  }
  if (opts.ownerOnly && !m.isOwner) {
    const err = new Error('Owner access required');
    err.status = 403;
    throw err;
  }
  if (opts.permission && !hasPermission(m.accessRole, opts.permission)) {
    const err = new Error('You do not have permission for this action');
    err.status = 403;
    throw err;
  }
  return m;
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

      const notes = String(body.notes || '').trim().slice(0, 500);
      const serviceName = String(body.serviceName || '').trim().slice(0, 120);
      const ref = await db.collection('tenants/' + tenantId + '/waitlist').add({
        customerName,
        customerEmail,
        customerPhone,
        serviceId,
        serviceName: serviceName || null,
        preferredDate,
        preferredStartTime,
        preferredEndTime,
        preferredPeriod: body.preferredPeriod || null,
        notes: notes || null,
        staffId: body.staffId || null,
        status: 'waiting',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        notifiedAt: null,
        expiresAt: admin.firestore.Timestamp.fromDate(expires)
      });

      try {
        await db.collection('tenants/' + tenantId + '/notifications').add({
          type: 'waitlist',
          title: 'New waitlist request',
          message: customerName + ' is waiting for ' + (serviceName || 'a service') + ' on ' + preferredDate,
          read: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          meta: { waitlistId: ref.id },
          waitlistId: ref.id
        });
      } catch (ne) {
        console.warn('waitlist notify', ne.message);
      }

      return res.status(201).json({ success: true, waitlistId: ref.id });
    }

    // ---------- Owner: list waitlist ----------
    if (action === 'listWaitlist') {
      let m, tenantId;
      try {
        m = await authz.requireMembership(db, body.idToken, { permission: 'manageWaitlist' });
        tenantId = m.tenantId;
      } catch (e) {
        return res.status(e.status || 403).json({ error: e.message || 'Forbidden' });
      }
      const snap = await db
        .collection('tenants/' + tenantId + '/waitlist')
        .where('status', 'in', ['waiting', 'offered', 'contacted', 'resolved'])
        .limit(80)
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
          preferredPeriod: x.preferredPeriod || null,
          serviceId: x.serviceId,
          serviceName: x.serviceName || null,
          status: x.status,
          customerPhone: x.customerPhone,
          customerEmail: x.customerEmail,
          notes: x.notes || null
        });
      });
      items.sort(function (a, b) {
        return String(b.preferredDate || '').localeCompare(String(a.preferredDate || ''));
      });
      return res.status(200).json({ items });
    }

    // ---------- Owner: update waitlist status ----------
    if (action === 'updateWaitlistStatus') {
      let m, tenantId;
      try {
        m = await authz.requireMembership(db, body.idToken, { permission: 'manageWaitlist' });
        tenantId = m.tenantId;
      } catch (e) {
        return res.status(e.status || 403).json({ error: e.message || 'Forbidden' });
      }
      const waitlistId = body.waitlistId;
      const status = String(body.status || '').trim();
      if (!waitlistId || !['waiting', 'contacted', 'resolved', 'offered'].includes(status)) {
        return res.status(400).json({ error: 'Invalid waitlist status update' });
      }
      const ref = db.doc('tenants/' + tenantId + '/waitlist/' + waitlistId);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: 'Waitlist entry not found' });
      await ref.set({
        status,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      return res.status(200).json({ success: true, status });
    }

    // ---------- Owner: list customers ----------

    // ---------- Session / membership (Batch 24) ----------
    if (action === 'resolveSession') {
      const m = await authz.resolveMembership(db, body.idToken);
      return res.status(200).json({
        uid: m.uid,
        email: m.email || null,
        isOwner: !!m.isOwner,
        isStaff: !!m.isStaff,
        denied: !!m.denied,
        reason: m.reason || null,
        tenantId: m.tenantId || null,
        staffId: m.staffId || null,
        accessRole: m.accessRole || null,
        accountStatus: m.accountStatus || null,
        staffName: m.staffName || null,
        permissions: m.permissions || []
      });
    }

    // ---------- Owner: link staff account (no email send) ----------
    if (action === 'linkStaffAccount') {
      const m = await authz.requireMembership(db, body.idToken, { ownerOnly: true });
      const staffId = String(body.staffId || '').trim();
      const accountEmail = String(body.accountEmail || '').trim().toLowerCase();
      const accessRole = String(body.accessRole || 'staff').toLowerCase() === 'manager' ? 'manager' : 'staff';
      if (!staffId || !accountEmail || !accountEmail.includes('@')) {
        return res.status(400).json({ error: 'staffId and valid accountEmail required' });
      }
      const staffRef = db.doc('tenants/' + m.tenantId + '/staff/' + staffId);
      const staffSnap = await staffRef.get();
      if (!staffSnap.exists) return res.status(404).json({ error: 'Staff not found' });

      // If Firebase user already exists with this email, link authUid immediately
      let authUid = null;
      let accountStatus = 'invited';
      try {
        const user = await admin.auth().getUserByEmail(accountEmail);
        authUid = user.uid;
        // Prevent linking owner account as staff on same tenant if uid === tenantId
        if (authUid === m.tenantId) {
          return res.status(400).json({ error: 'Cannot link the owner account as staff' });
        }
        // Check index not used by another tenant
        const existingIdx = await db.doc('platformStaffIndex/' + authUid).get();
        if (existingIdx.exists && existingIdx.data().tenantId !== m.tenantId) {
          return res.status(409).json({ error: 'This account is already linked to another business' });
        }
        accountStatus = 'active';
        await db.doc('platformStaffIndex/' + authUid).set({
          tenantId: m.tenantId,
          staffId,
          accessRole,
          status: 'active',
          accountEmail,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      } catch (e) {
        if (e.code !== 'auth/user-not-found') {
          console.warn('getUserByEmail', e.message);
        }
        // User not registered yet — leave invited; store email-keyed pending index for later bind
        accountStatus = 'invited';
        const emailKey = 'email_' + require('crypto').createHash('sha256').update(accountEmail).digest('hex').slice(0, 24);
        await db.doc('platformStaffIndex/' + emailKey).set({
          tenantId: m.tenantId,
          staffId,
          accessRole,
          status: 'invited',
          accountEmail,
          pendingEmail: true,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      }

      // Clear previous index if staff had different authUid
      const prev = staffSnap.data() || {};
      if (prev.authUid && prev.authUid !== authUid) {
        try {
          await db.doc('platformStaffIndex/' + prev.authUid).delete();
        } catch (e) {}
      }

      await staffRef.set({
        accountEmail,
        accessRole,
        accountStatus,
        authUid: authUid || null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      return res.status(200).json({
        success: true,
        accountStatus,
        authUid: authUid || null,
        message: accountStatus === 'active'
          ? 'Account linked. The staff member can sign in with this email.'
          : 'Email saved as invited. Ask them to create a BookAI login with this exact email, then sign in. No invitation email was sent by the system.'
      });
    }

    if (action === 'unlinkStaffAccount') {
      const m = await authz.requireMembership(db, body.idToken, { ownerOnly: true });
      const staffId = String(body.staffId || '').trim();
      if (!staffId) return res.status(400).json({ error: 'staffId required' });
      const staffRef = db.doc('tenants/' + m.tenantId + '/staff/' + staffId);
      const staffSnap = await staffRef.get();
      if (!staffSnap.exists) return res.status(404).json({ error: 'Staff not found' });
      const prev = staffSnap.data() || {};
      if (prev.authUid) {
        try { await db.doc('platformStaffIndex/' + prev.authUid).delete(); } catch (e) {}
      }
      await staffRef.set({
        authUid: null,
        accountEmail: null,
        accountStatus: 'not_connected',
        accessRole: null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      return res.status(200).json({ success: true });
    }

    if (action === 'setStaffAccountStatus') {
      const m = await authz.requireMembership(db, body.idToken, { ownerOnly: true });
      const staffId = String(body.staffId || '').trim();
      const status = String(body.accountStatus || '').trim();
      if (!staffId || ['active', 'disabled', 'invited', 'not_connected'].indexOf(status) === -1) {
        return res.status(400).json({ error: 'Invalid staffId or status' });
      }
      const staffRef = db.doc('tenants/' + m.tenantId + '/staff/' + staffId);
      const staffSnap = await staffRef.get();
      if (!staffSnap.exists) return res.status(404).json({ error: 'Staff not found' });
      const prev = staffSnap.data() || {};
      await staffRef.set({
        accountStatus: status,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      if (prev.authUid) {
        await db.doc('platformStaffIndex/' + prev.authUid).set({
          status: status === 'disabled' ? 'disabled' : (status === 'active' ? 'active' : 'invited'),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      }
      return res.status(200).json({ success: true });
    }

    if (action === 'setStaffAccessRole') {
      const m = await authz.requireMembership(db, body.idToken, { ownerOnly: true });
      const staffId = String(body.staffId || '').trim();
      const accessRole = String(body.accessRole || 'staff').toLowerCase() === 'manager' ? 'manager' : 'staff';
      if (!staffId) return res.status(400).json({ error: 'staffId required' });
      const staffRef = db.doc('tenants/' + m.tenantId + '/staff/' + staffId);
      const staffSnap = await staffRef.get();
      if (!staffSnap.exists) return res.status(404).json({ error: 'Staff not found' });
      const prev = staffSnap.data() || {};
      await staffRef.set({ accessRole, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      if (prev.authUid) {
        await db.doc('platformStaffIndex/' + prev.authUid).set({ accessRole }, { merge: true });
      }
      return res.status(200).json({ success: true, accessRole });
    }

    // Staff: list own appointments
    if (action === 'listMyAppointments') {
      const m = await authz.requireMembership(db, body.idToken, { permission: 'viewOwnAppointments' });
      if (m.isOwner && !m.isStaff) {
        return res.status(400).json({ error: 'Use owner appointment views' });
      }
      if (!m.staffId) return res.status(403).json({ error: 'Staff profile required' });
      const snap = await db.collection('tenants/' + m.tenantId + '/appointments')
        .where('staffId', '==', m.staffId)
        .limit(120)
        .get();
      const items = [];
      snap.forEach(function (d) {
        const a = d.data();
        // Never return manage tokens or internal secrets
        items.push({
          id: d.id,
          date: a.date,
          startTime: a.startTime,
          endTime: a.endTime,
          status: a.status || 'confirmed',
          serviceName: a.serviceName || '',
          serviceId: a.serviceId || null,
          durationMinutes: a.durationMinutes || a.serviceDuration || a.duration || null,
          customerName: a.customerName || '',
          customerEmail: a.customerEmail || null,
          customerPhone: a.customerPhone || null,
          notes: a.notes || null,
          staffId: a.staffId || null,
          staffName: a.staffName || null,
          bookingRef: a.bookingRef || null,
          source: a.source || null
        });
      });
      items.sort(function (a, b) {
        return String((a.date || '') + (a.startTime || '')).localeCompare(String((b.date || '') + (b.startTime || '')));
      });
      return res.status(200).json({
        items,
        staffId: m.staffId,
        tenantId: m.tenantId,
        staffName: m.staffName || null,
        accessRole: m.accessRole
      });
    }

    // Staff: update status on OWN assigned appointments only
    if (action === 'updateMyAppointmentStatus') {
      const m = await authz.requireMembership(db, body.idToken, { permission: 'updateOwnAppointmentStatus' });
      if (!m.staffId || !m.tenantId) {
        return res.status(403).json({ error: 'Staff profile required' });
      }
      const appointmentId = String(body.appointmentId || '').trim();
      const newStatus = String(body.status || '').trim();
      if (!appointmentId || !newStatus) {
        return res.status(400).json({ error: 'appointmentId and status required' });
      }
      // Staff operational transitions only
      // Staff: operational transitions only — cancellation is owner/manager
      const STAFF_ALLOWED = {
        pending: ['confirmed'],
        pending_verification: ['confirmed'],
        confirmed: ['checked_in', 'completed', 'no_show'],
        checked_in: ['completed'],
        completed: [],
        cancelled: [],
        no_show: []
      };
      const ref = db.doc('tenants/' + m.tenantId + '/appointments/' + appointmentId);
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) {
          const err = new Error('Appointment not found');
          err.status = 404;
          throw err;
        }
        const a = snap.data();
        // Critical: must be assigned to this staff member
        if (a.staffId !== m.staffId) {
          const err = new Error('You can only update appointments assigned to you');
          err.status = 403;
          throw err;
        }
        const cur = a.status || 'confirmed';
        const allowed = STAFF_ALLOWED[cur] || [];
        if (allowed.indexOf(newStatus) === -1) {
          const err = new Error('Invalid status transition from ' + cur + ' to ' + newStatus);
          err.status = 400;
          throw err;
        }
        const patch = {
          status: newStatus,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          lastStatusBy: 'staff:' + m.staffId
        };
        if (newStatus === 'checked_in') patch.checkedInAt = admin.firestore.FieldValue.serverTimestamp();
        if (newStatus === 'completed') patch.completedAt = admin.firestore.FieldValue.serverTimestamp();
        if (newStatus === 'no_show') patch.noShowProcessedAt = admin.firestore.FieldValue.serverTimestamp();
        tx.update(ref, patch);
      });
      try {
        const snap = await ref.get();
        const appt = snap.exists ? snap.data() : {};
        await db.collection('tenants/' + m.tenantId + '/notifications').add({
          type: 'status',
          title: 'Staff updated booking',
          message: (m.staffName || 'Staff') + ' set ' + (appt.customerName || 'customer') + ' → ' + newStatus,
          read: false,
          meta: { appointmentId: appointmentId, staffId: m.staffId },
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } catch (e) {}
      return res.status(200).json({ success: true, status: newStatus });
    }


        if (action === 'listCustomers') {
      let m, tenantId;
      try {
        m = await authz.requireMembership(db, body.idToken, { permission: 'manageCustomers' });
        tenantId = m.tenantId;
      } catch (e) {
        return res.status(e.status || 403).json({ error: e.message || 'Forbidden' });
      }
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
      let m, tenantId;
      try {
        m = await authz.requireMembership(db, body.idToken, { permission: 'manageCustomers' });
        tenantId = m.tenantId;
      } catch (e) {
        return res.status(e.status || 403).json({ error: e.message || 'Forbidden' });
      }
      if (!body.customerId) return res.status(400).json({ error: 'customerId required' });
      const patch = {
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      };
      if (body.notes !== undefined) patch.notes = String(body.notes || '').slice(0, 1000);
      if (body.name) patch.name = String(body.name).trim().slice(0, 120);
      if (body.email) patch.email = String(body.email).trim().toLowerCase().slice(0, 160);
      if (body.phone) patch.phone = String(body.phone).trim().slice(0, 40);
      if (body.followUpStatus) {
        const allowed = ['not_contacted', 'contacted', 'completed'];
        if (allowed.indexOf(body.followUpStatus) !== -1) {
          patch.followUpStatus = body.followUpStatus;
          patch.followUpUpdatedAt = admin.firestore.FieldValue.serverTimestamp();
        }
      }
      await db.doc('tenants/' + tenantId + '/customers/' + String(body.customerId).replace(/\//g, '_')).set(
        patch,
        { merge: true }
      );
      return res.status(200).json({ success: true });
    }

    // ---------- Owner: cancel appointment + waitlist offer ----------
    if (action === 'cancelAppointment') {
      let m, tenantId;
      try {
        m = await authz.requireMembership(db, body.idToken, { permission: 'manageAppointments' });
        tenantId = m.tenantId;
      } catch (e) {
        return res.status(e.status || 403).json({ error: e.message || 'Forbidden' });
      }
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
      let m, tenantId;
      try {
        m = await authz.requireMembership(db, body.idToken, { permission: 'manageWaitlist' });
        tenantId = m.tenantId;
      } catch (e) {
        return res.status(e.status || 403).json({ error: e.message || 'Forbidden' });
      }
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
      let m, tenantId;
      try {
        m = await authz.requireMembership(db, body.idToken, { ownerOnly: true });
        tenantId = m.tenantId;
      } catch (e) {
        return res.status(e.status || 403).json({ error: e.message || 'Forbidden' });
      }
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
      let m, tenantId;
      try {
        m = await authz.requireMembership(db, body.idToken, { permission: 'dashboardSummary' });
        tenantId = m.tenantId;
      } catch (e) {
        return res.status(e.status || 403).json({ error: e.message || 'Forbidden' });
      }

            let settingsForTz = {};
      try {
        const sSnap = await db.doc('tenants/' + tenantId + '/settings/config').get();
        if (sSnap.exists) settingsForTz = sSnap.data() || {};
      } catch (e) {}
      const today = authz.businessLocalDateISO(settingsForTz);
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

    
    if (action === 'tenantStatus') {
      let m, tenantId;
      try {
        m = await authz.requireMembership(db, body.idToken, { permission: 'dashboardSummary' });
        tenantId = m.tenantId;
      } catch (e) {
        return res.status(e.status || 403).json({ error: e.message || 'Forbidden' });
      }
      const snap = await db.doc('platformTenants/' + tenantId).get();
      if (!snap.exists) {
        return res.status(200).json({ status: 'unregistered', daysLeft: null, trialExpired: false });
      }
      const p = snap.data();
      let status = p.status || 'trial';
      let daysLeft = null;
      let trialExpired = false;
      if (p.trialEnd && p.trialEnd.toDate) {
        const end = p.trialEnd.toDate().getTime();
        daysLeft = Math.ceil((end - Date.now()) / 86400000);
        if (status === 'trial' && end < Date.now()) {
          trialExpired = true;
          status = 'expired';
        }
      }
      if (status === 'expired') trialExpired = true;
      return res.status(200).json({ status, daysLeft, trialExpired, email: p.email || null, businessName: p.businessName || null });
    }

    if (action === 'supportMessage') {
      let m, tenantId;
      try {
        m = await authz.requireMembership(db, body.idToken, { permission: 'dashboardSummary' });
        tenantId = m.tenantId;
      } catch (e) {
        return res.status(e.status || 403).json({ error: e.message || 'Forbidden' });
      }
      const message = String(body.message || '').trim().slice(0, 2000);
      if (message.length < 5) return res.status(400).json({ error: 'Message too short' });
      await db.collection('platformSupport').add({
        tenantId,
        email: body.email || '',
        businessName: body.businessName || '',
        message,
        status: 'open',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return res.status(201).json({ success: true });
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
