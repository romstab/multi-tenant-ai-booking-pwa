/**
 * Shared membership & permission helpers for BookAI APIs.
 * Server is authoritative — never trust client tenantId/role/staffId.
 */
const admin = require('firebase-admin');

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
    console.error('authz init', e.message);
    return false;
  }
}

/**
 * Permission matrix
 * OWNER: full
 * MANAGER: operational tenant scope (not team accounts / ownership)
 * STAFF: own schedule only
 */
const ROLE_PERMS = {
  owner: [
    'full',
    'viewAppointments', 'manageAppointments', 'manageCustomers', 'manageWaitlist',
    'manageStaff', 'manageStaffAvailability', 'manageSpecialHours', 'manageSettings',
    'manageServices', 'viewAnalytics', 'manageTeamAccounts', 'manageBlocks',
    'manageEmergencyClosure', 'managePolicies', 'walkIn', 'dashboardSummary'
  ],
  manager: [
    'viewAppointments', 'manageAppointments', 'manageCustomers', 'manageWaitlist',
    'manageStaffAvailability', 'manageSpecialHours', 'manageServices', 'viewAnalytics',
    'manageBlocks', 'walkIn', 'dashboardSummary'
  ],
  staff: [
    'viewOwnAppointments', 'updateOwnAppointmentStatus', 'viewOwnSchedule'
  ]
};

function hasPermission(role, perm) {
  const r = String(role || '').toLowerCase();
  const list = ROLE_PERMS[r] || [];
  return list.indexOf('full') !== -1 || list.indexOf(perm) !== -1;
}

async function resolveMembership(db, idToken) {
  const decoded = await admin.auth().verifyIdToken(idToken);
  const uid = decoded.uid;
  const email = (decoded.email || '').toLowerCase();

  const plat = await db.doc('platformTenants/' + uid).get();
  const settings = await db.doc('tenants/' + uid + '/settings/config').get();
  if (plat.exists || settings.exists) {
    return {
      uid,
      email,
      isOwner: true,
      isStaff: false,
      tenantId: uid,
      staffId: null,
      accessRole: 'owner',
      accountStatus: 'active',
      permissions: ROLE_PERMS.owner
    };
  }

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
    let role = (staff.accessRole || ix.accessRole || 'staff').toLowerCase();
    if (role !== 'manager' && role !== 'staff') role = 'staff';

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
      accessRole: role,
      accountStatus: 'active',
      staffName: staff.name || 'Staff',
      permissions: ROLE_PERMS[role] || ROLE_PERMS.staff
    };
  }

  if (email) {
    const byEmail = await db.collection('platformStaffIndex').where('accountEmail', '==', email).limit(3).get();
    if (!byEmail.empty) {
      let chosen = null;
      byEmail.forEach(function (d) {
        if (!chosen) chosen = { id: d.id, data: d.data(), ref: d.ref };
      });
      if (chosen && chosen.data.tenantId && chosen.data.staffId) {
        const staffRef = db.doc('tenants/' + chosen.data.tenantId + '/staff/' + chosen.data.staffId);
        const staffSnap = await staffRef.get();
        if (staffSnap.exists && staffSnap.data().accountStatus !== 'disabled') {
          let role = (staffSnap.data().accessRole || chosen.data.accessRole || 'staff').toLowerCase();
          if (role !== 'manager' && role !== 'staff') role = 'staff';
          if (chosen.id !== uid) {
            try { await chosen.ref.delete(); } catch (e) {}
          }
          await db.doc('platformStaffIndex/' + uid).set({
            tenantId: chosen.data.tenantId,
            staffId: chosen.data.staffId,
            accessRole: role,
            status: 'active',
            accountEmail: email,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
          await staffRef.set({
            authUid: uid,
            accountEmail: email,
            accountStatus: 'active',
            accessRole: role,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
          return {
            uid,
            email,
            isOwner: false,
            isStaff: true,
            tenantId: chosen.data.tenantId,
            staffId: chosen.data.staffId,
            accessRole: role,
            accountStatus: 'active',
            staffName: staffSnap.data().name || 'Staff',
            permissions: ROLE_PERMS[role] || ROLE_PERMS.staff
          };
        }
      }
    }
  }

  // New Firebase account with no staff link and no tenant docs yet:
  // treat as provisional owner so they can complete onboarding (not denied).
  // Owner identity remains server-side: tenantId === uid.
  return {
    uid,
    email,
    isOwner: true,
    isStaff: false,
    denied: false,
    needsOnboarding: true,
    tenantId: uid,
    staffId: null,
    accessRole: 'owner',
    accountStatus: 'pending_setup',
    permissions: ROLE_PERMS.owner,
    reason: null
  };
}

/**
 * opts.ownerOnly — must be tenant owner
 * opts.permission — required permission string
 * Returns membership; tenantId is always from server resolution.
 */
async function requireMembership(db, idToken, opts) {
  opts = opts || {};
  if (!idToken) {
    const err = new Error('Auth required');
    err.status = 401;
    throw err;
  }
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

/**
 * Business-local calendar date YYYY-MM-DD.
 * Priority: settings.timezoneOffsetMinutes → default +480 (Asia/Manila).
 * createdAt/updatedAt remain server timestamps (UTC) elsewhere.
 */
function businessLocalDateISO(settings, when) {
  const d = when instanceof Date ? when : new Date();
  let off = 480;
  if (settings && settings.timezoneOffsetMinutes != null && !isNaN(Number(settings.timezoneOffsetMinutes))) {
    off = Number(settings.timezoneOffsetMinutes);
  }
  const local = new Date(d.getTime() + off * 60000);
  return local.getUTCFullYear() + '-' +
    String(local.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(local.getUTCDate()).padStart(2, '0');
}

module.exports = {
  businessLocalDateISO,
  initAdmin,
  admin,
  ROLE_PERMS,
  hasPermission,
  resolveMembership,
  requireMembership
};
