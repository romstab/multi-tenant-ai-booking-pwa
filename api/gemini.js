/**
 * POST /api/gemini
 * AI with tenant cache + daily rate limit (server-side)
 * Env: GEMINI_API_KEY, FIREBASE_* (Admin)
 *
 * Body: { tenantId, tenantContext, userMessage }
 */

const admin = require('firebase-admin');

function cleanField(v, maxLen) {
  if (v == null) return '';
  let s = String(v).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').trim();
  if (!s || s === 'undefined' || s === 'null' || s === 'N/A') return '';
  if (maxLen) s = s.slice(0, maxLen);
  return s;
}


const MAX_AI_PER_DAY = 20;

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

function normalizeQuestion(q) {
  return String(q || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY is not set on Vercel.' });
  }

  try {
    const body = req.body || {};
    const tenantId = body.tenantId || null;
    const tenantContext = body.tenantContext || {};
    const userMessage = body.userMessage;

    if (!userMessage || typeof userMessage !== 'string' || !userMessage.trim()) {
      return res.status(400).json({ error: 'Missing userMessage' });
    }
    if (userMessage.length > 500) {
      return res.status(400).json({ error: 'Message too long (max 500 characters)' });
    }

    const normalized = normalizeQuestion(userMessage);
    const dbReady = initAdmin();

    // 1) Cache lookup
    if (dbReady && tenantId && normalized.length >= 3) {
      try {
        const cacheQ = await admin
          .firestore()
          .collection('tenants/' + tenantId + '/aiCache')
          .where('normalizedQuestion', '==', normalized)
          .limit(1)
          .get();
        if (!cacheQ.empty) {
          const doc = cacheQ.docs[0];
          const data = doc.data();
          doc.ref.set(
            {
              lastUsedAt: admin.firestore.FieldValue.serverTimestamp(),
              usageCount: admin.firestore.FieldValue.increment(1)
            },
            { merge: true }
          ).catch(function () {});
          return res.status(200).json({
            reply: data.answer,
            source: 'cache',
            model: null
          });
        }
      } catch (e) {
        console.warn('cache lookup', e.message);
      }
    }

    // 2) Rate limit
    if (dbReady && tenantId) {
      try {
        const usageRef = admin.firestore().doc('tenants/' + tenantId + '/usage/' + todayKey());
        const usageSnap = await usageRef.get();
        const used = usageSnap.exists ? Number(usageSnap.data().aiDynamicRequests || 0) : 0;
        if (used >= MAX_AI_PER_DAY) {
          return res.status(429).json({
            error:
              "The AI assistant has reached today's question limit. Please use the FAQ buttons or contact the business directly.",
            source: 'rate_limit'
          });
        }
      } catch (e) {
        console.warn('rate limit check', e.message);
      }
    }

    // 3) Build prompt
    const services = Array.isArray(tenantContext.services) ? tenantContext.services : [];
    const servicesText = services.length
      ? services
          .map(function (s) {
            return (
              '- ' +
              (s.name || '') +
              ': ' +
              (s.description || 'No description') +
              ' (' +
              (s.duration || '?') +
              ' min, price: ' +
              (s.price != null ? s.price : 'n/a') +
              ')'
            );
          })
          .join('\n')
      : 'No services listed.';

    const hours = tenantContext.operatingHours || {};
    const hoursText = Object.keys(hours).length
      ? Object.keys(hours)
          .map(function (day) {
            const h = hours[day];
            if (!h || !h.enabled) return day + ': Closed';
            return day + ': ' + h.open + ' – ' + h.close;
          })
          .join('\n')
      : 'Hours not provided.';

    const systemPrompt =
      'You are a helpful booking assistant for a business.\n' +
      'Answer ONLY using the business context below. Do not invent services, prices, or hours.\n' +
      'Do not claim a booking is confirmed.\n' +
      'If information is Not provided, say the business has not added it yet.\n' +
      'Never invent medical, legal, or unrelated facts.\n' +
      'Keep answers concise and friendly.\n\n' +
      'BUSINESS NAME: ' +
      (cleanField(tenantContext.businessName, 120) || 'This business') +
      '\nCATEGORY: ' +
      (cleanField(tenantContext.businessCategory, 80) || 'Not specified') +
      '\nDESCRIPTION: ' +
      (cleanField(tenantContext.businessDescription, 500) || 'Not provided') +
      '\nADDRESS: ' +
      (cleanField(tenantContext.address, 200) || 'Not provided by the business yet') +
      '\n\nSERVICES:\n' +
      servicesText +
      '\n\nOPERATING HOURS:\n' +
      hoursText;

    const promptText = systemPrompt + '\n\nCustomer question: ' + userMessage.trim();

    const models = [
      'gemini-2.5-flash',
      'gemini-3.5-flash',
      'gemini-3.6-flash',
      'gemini-3.5-flash-lite',
      'gemini-2.5-flash-lite'
    ];

    let lastError = null;
    let reply = null;
    let usedModel = null;

    for (let i = 0; i < models.length; i++) {
      const model = models[i];
      const url =
        'https://generativelanguage.googleapis.com/v1beta/models/' +
        model +
        ':generateContent?key=' +
        encodeURIComponent(apiKey);
      try {
        const geminiRes = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: promptText }] }],
            generationConfig: { temperature: 0.4, maxOutputTokens: 400 }
          })
        });
        const raw = await geminiRes.text();
        let data = null;
        try {
          data = JSON.parse(raw);
        } catch (e) {}
        if (!geminiRes.ok) {
          lastError = model + ': ' + ((data && data.error && data.error.message) || raw.slice(0, 200));
          continue;
        }
        try {
          reply = data.candidates[0].content.parts[0].text.trim();
          usedModel = model;
          break;
        } catch (e) {
          lastError = model + ': empty response';
        }
      } catch (e) {
        lastError = model + ': ' + e.message;
      }
    }

    if (!reply) {
      return res.status(502).json({
        error: 'AI service temporarily unavailable.',
        detail: lastError
      });
    }

    // 4) Increment usage + save cache
    if (dbReady && tenantId) {
      try {
        const usageRef = admin.firestore().doc('tenants/' + tenantId + '/usage/' + todayKey());
        await usageRef.set(
          {
            aiDynamicRequests: admin.firestore.FieldValue.increment(1),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          },
          { merge: true }
        );
      } catch (e) {
        console.warn('usage increment', e.message);
      }

      if (normalized.length >= 3 && reply.length < 2000) {
        try {
          await admin.firestore().collection('tenants/' + tenantId + '/aiCache').add({
            normalizedQuestion: normalized,
            originalQuestion: userMessage.trim().slice(0, 300),
            answer: reply,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            lastUsedAt: admin.firestore.FieldValue.serverTimestamp(),
            usageCount: 1
          });
        } catch (e) {
          console.warn('cache save', e.message);
        }
      }
    }

    return res.status(200).json({ reply: reply, source: 'gemini', model: usedModel });
  } catch (err) {
    console.error('gemini handler', err);
    return res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
};
