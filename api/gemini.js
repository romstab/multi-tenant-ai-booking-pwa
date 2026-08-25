/**
 * Vercel Serverless — Gemini AI Assistant (CommonJS)
 * POST /api/gemini
 * Env: GEMINI_API_KEY
 *
 * Uses current Gemini model IDs (as of 2026).
 */

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'GEMINI_API_KEY is not set on Vercel. Add it and Redeploy.'
    });
  }

  try {
    const body = req.body || {};
    const tenantContext = body.tenantContext || {};
    const userMessage = body.userMessage;

    if (!userMessage || typeof userMessage !== 'string' || !userMessage.trim()) {
      return res.status(400).json({ error: 'Missing userMessage' });
    }
    if (userMessage.length > 500) {
      return res.status(400).json({ error: 'Message too long (max 500 characters)' });
    }

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
      'Answer ONLY using the business context below. Do not invent services, prices, or opening hours.\n' +
      'Do not claim that a booking has been confirmed.\n' +
      'Keep answers concise and friendly.\n\n' +
      'BUSINESS NAME: ' +
      (tenantContext.businessName || 'Unknown') +
      '\nCATEGORY: ' +
      (tenantContext.businessCategory || 'N/A') +
      '\nDESCRIPTION: ' +
      (tenantContext.businessDescription || 'N/A') +
      '\n\nSERVICES:\n' +
      servicesText +
      '\n\nOPERATING HOURS:\n' +
      hoursText;

    const promptText = systemPrompt + '\n\nCustomer question: ' + userMessage.trim();

    // Current Gemini models (2026) — try in order until one works
    const models = [
      'gemini-2.5-flash',
      'gemini-3.5-flash',
      'gemini-3.6-flash',
      'gemini-3.5-flash-lite',
      'gemini-2.5-flash-lite'
    ];

    let lastError = null;

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
          const msg =
            (data && data.error && data.error.message) || raw.slice(0, 300);
          console.error('Gemini model failed', model, geminiRes.status, msg);
          lastError = model + ': ' + msg;
          continue;
        }

        let reply = null;
        try {
          reply = data.candidates[0].content.parts[0].text.trim();
        } catch (e) {
          lastError = model + ': empty response';
          continue;
        }

        return res.status(200).json({ reply: reply, model: model });
      } catch (e) {
        console.error('fetch error', model, e.message);
        lastError = model + ': ' + e.message;
      }
    }

    return res.status(502).json({
      error: 'AI service temporarily unavailable.',
      detail:
        lastError ||
        'All models failed. Check GEMINI_API_KEY and that the Generative Language API is enabled for your key.'
    });
  } catch (err) {
    console.error('gemini handler error', err);
    return res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
};
