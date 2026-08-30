/**
 * GET/POST /api/cron-reminders
 * Vercel Cron: send booking reminder emails ~5 minutes before appointment.
 *
 * Idempotent:
 * - only processes reminderStatus === 'scheduled'
 * - marks reminderStatus = 'sent' + reminderSentAt before/after send carefully
 * - skips cancelled / completed / no_show
 *
 * Auth: Authorization: Bearer $CRON_SECRET when CRON_SECRET is set
 * (same pattern as api/cron-noshow.js).
 */

const admin = require('firebase-admin');
const { sendMail, isEmailConfigured } = require('../services/emailService');
const { buildBookingReminderEmail } = require('../templates/bookingReminderTemplate');

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

function authorize(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const q = (req.query && (req.query.secret || req.query.CRON_SECRET)) || '';
  return bearer === secret || q === secret;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  if (!authorize(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!initAdmin()) {
    return res.status(500).json({ ok: false, error: 'Firebase Admin not configured' });
  }

  const db = admin.firestore();
  const now = admin.firestore.Timestamp.now();
  const results = [];

  try {
    // Prefer collectionGroup when index exists; fallback scans recent platform tenants.
    let docs = [];
    try {
      const snap = await db
        .collectionGroup('appointments')
        .where('reminderStatus', '==', 'scheduled')
        .where('reminderScheduledFor', '<=', now)
        .limit(40)
        .get();
      docs = snap.docs;
    } catch (idxErr) {
      console.warn('[cron-reminders] collectionGroup query failed (index?):', idxErr.message);
      // Fallback: limited tenant scan
      const tenantsSnap = await db.collection('platformTenants').limit(80).get();
      for (const t of tenantsSnap.docs) {
        const q = await db
          .collection('tenants/' + t.id + '/appointments')
          .where('reminderStatus', '==', 'scheduled')
          .where('reminderScheduledFor', '<=', now)
          .limit(10)
          .get();
        docs = docs.concat(q.docs);
        if (docs.length >= 40) break;
      }
    }

    for (const doc of docs) {
      const data = doc.data() || {};
      const status = String(data.status || '');
      if (['cancelled', 'completed', 'no_show'].includes(status)) {
        await doc.ref.set(
          {
            reminderStatus: 'skipped',
            reminderSentAt: admin.firestore.FieldValue.serverTimestamp()
          },
          { merge: true }
        );
        results.push({ id: doc.id, skipped: true, reason: 'inactive_status' });
        continue;
      }
      if (data.reminderStatus === 'sent' || data.reminderSentAt) {
        results.push({ id: doc.id, skipped: true, reason: 'already_sent' });
        continue;
      }

      // Claim first (idempotent under concurrent cron)
      try {
        await db.runTransaction(async (tx) => {
          const fresh = await tx.get(doc.ref);
          const d = fresh.data() || {};
          if (d.reminderStatus !== 'scheduled' || d.reminderSentAt) {
            throw Object.assign(new Error('already_claimed'), { code: 'ALREADY' });
          }
          tx.update(doc.ref, {
            reminderStatus: 'sending',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
        });
      } catch (e) {
        results.push({ id: doc.id, skipped: true, reason: 'race_or_claimed' });
        continue;
      }

      const tenantId = data.tenantId || (doc.ref.parent && doc.ref.parent.parent && doc.ref.parent.parent.id);
      let tenant = { businessName: 'Business' };
      if (tenantId) {
        try {
          const s = await db.doc('tenants/' + tenantId + '/settings/config').get();
          if (s.exists) tenant = Object.assign({ tenantId }, s.data());
        } catch (_) {}
      }

      if (!isEmailConfigured() || !data.customerEmail) {
        await doc.ref.set(
          {
            reminderStatus: 'scheduled',
            reminderEmailError: 'email_not_configured_or_missing_customer',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          },
          { merge: true }
        );
        results.push({ id: doc.id, skipped: true, reason: 'no_email' });
        continue;
      }

      const tpl = buildBookingReminderEmail({
        tenant,
        booking: {
          customerName: data.customerName,
          bookingRef: data.bookingRef || data.bookingReference,
          date: data.date,
          startTime: data.startTime,
          serviceName: data.serviceName
        }
      });

      const mail = await sendMail({
        to: data.customerEmail,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text
      });

      if (mail.ok) {
        await doc.ref.set(
          {
            reminderStatus: 'sent',
            reminderSent: true,
            reminderSentAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          },
          { merge: true }
        );
        results.push({ id: doc.id, ok: true, bookingRef: data.bookingRef || null });
      } else {
        await doc.ref.set(
          {
            reminderStatus: 'scheduled',
            reminderEmailError: mail.error || 'send_failed',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          },
          { merge: true }
        );
        results.push({ id: doc.id, ok: false, error: mail.error || 'send_failed' });
      }
    }

    return res.status(200).json({
      ok: true,
      processed: results.length,
      emailConfigured: isEmailConfigured(),
      results
    });
  } catch (err) {
    console.error('[cron-reminders]', err);
    return res.status(500).json({ ok: false, error: 'Reminder job failed' });
  }
};
