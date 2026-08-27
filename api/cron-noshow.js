/**
 * GET or POST /api/cron-noshow
 * Protected by CRON_SECRET (Vercel sets Authorization: Bearer $CRON_SECRET automatically
 * when the CRON_SECRET env var is configured).
 *
 * Schedule: every 15 minutes (vercel.json crons).
 *
 * Marks status=confirmed appointments as no_show when past grace period.
 * Idempotent: skips if noShowProcessedAt set or already checked_in/cancelled/completed.
 *
 * Past appointments remain historical; availability only cares about active statuses.
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
    console.error(e.message);
    return false;
  }
}

function authorize(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const h = req.headers['authorization'] || '';
  const bearer = h.startsWith('Bearer ') ? h.slice(7) : '';
  const q = (req.query && (req.query.secret || req.query.CRON_SECRET)) || '';
  const headerSecret = req.headers['x-cron-secret'] || '';
  return bearer === secret || q === secret || headerSecret === secret;
}

/** Wall-clock Asia/Manila (+480) default — matches create-booking default */
function parseBusinessLocalDateTime(dateStr, timeStr, tzOffsetMinutes) {
  const offset = typeof tzOffsetMinutes === 'number' ? tzOffsetMinutes : 480;
  const parts = String(dateStr || '').split('-').map(Number);
  const tp = String(timeStr || '00:00').split(':').map(Number);
  const utcMs =
    Date.UTC(parts[0], (parts[1] || 1) - 1, parts[2] || 1, tp[0] || 0, tp[1] || 0, 0) -
    offset * 60 * 1000;
  return new Date(utcMs);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!authorize(req)) {
    return res.status(401).json({ error: 'Unauthorized — set CRON_SECRET on Vercel' });
  }
  if (!initAdmin()) {
    return res.status(500).json({ error: 'Admin not configured' });
  }

  const db = admin.firestore();
  const now = admin.firestore.Timestamp.now();
  const nowMs = Date.now();
  let processed = 0;
  let scanned = 0;
  let skipped = 0;

  try {
    const tenantsSnap = await db.collection('platformTenants').limit(300).get();
    const tenantIds = [];
    tenantsSnap.forEach(function (d) {
      if (!d.data().deleted) tenantIds.push(d.id);
    });

    for (let t = 0; t < tenantIds.length; t++) {
      const tenantId = tenantIds[t];

      // Primary path: appointments with gracePeriodEndsAt set
      let q;
      try {
        q = await db
          .collection('tenants/' + tenantId + '/appointments')
          .where('status', '==', 'confirmed')
          .where('gracePeriodEndsAt', '<=', now)
          .limit(40)
          .get();
      } catch (indexErr) {
        // Missing composite index — fall back to status-only query
        console.warn('index fallback', tenantId, indexErr.message);
        q = await db
          .collection('tenants/' + tenantId + '/appointments')
          .where('status', '==', 'confirmed')
          .limit(40)
          .get();
      }

      for (let i = 0; i < q.docs.length; i++) {
        scanned++;
        const docRef = q.docs[i].ref;

        const changed = await db.runTransaction(async (tx) => {
          const snap = await tx.get(docRef);
          if (!snap.exists) return false;
          const data = snap.data();

          if (data.status !== 'confirmed') return false;
          if (data.noShowProcessedAt) return false;
          if (data.checkedInAt) return false;

          let graceMs = null;
          if (data.gracePeriodEndsAt && data.gracePeriodEndsAt.toMillis) {
            graceMs = data.gracePeriodEndsAt.toMillis();
          } else if (data.date && data.startTime) {
            // Legacy appointments without gracePeriodEndsAt
            const start = parseBusinessLocalDateTime(data.date, data.startTime, 480);
            graceMs = start.getTime() + 15 * 60 * 1000;
          } else {
            return false;
          }

          if (graceMs > nowMs) return false;

          tx.update(docRef, {
            status: 'no_show',
            noShowProcessedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
          return true;
        });

        if (changed) {
          processed++;
          try {
            await db.collection('tenants/' + tenantId + '/notifications').add({
              type: 'no_show',
              title: 'Customer no-show',
              message: 'An appointment was marked as no-show after the 15-minute grace period.',
              appointmentId: docRef.id,
              read: false,
              createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
          } catch (e) {}
        } else {
          skipped++;
        }
      }
    }

    return res.status(200).json({
      ok: true,
      scanned,
      processed,
      skipped,
      note: 'Idempotent. Checked-in / cancelled / completed never become no_show.'
    });
  } catch (err) {
    console.error('cron-noshow', err);
    return res.status(500).json({
      error: err.message,
      hint:
        'If Firebase asks for an index: appointments status ASC + gracePeriodEndsAt ASC'
    });
  }
};
