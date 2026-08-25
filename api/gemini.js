/**
 * Vercel Serverless — Gemini AI Assistant (CommonJS)
 * POST /api/gemini
 * Env: GEMINI_API_KEY
 */

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY is not set on Vercel. Add it and Redeploy.' });
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
      ? services.map(function (s) {
          return '- ' + (s.name || '') + ': ' + (s.description || 'No description') +
            ' (' + (s.duration || '?') + ' min, price: ' + (s.price != null ? s.price : 'n/a') + ')';
        }).join('\n')
      : 'No services listed.';

    const hours = tenantContext.operatingHours || {};
    const hoursText = Object.keys(hours).length
      ? Object.keys(hours).map(function (day) {
          const h = hours[day];
          if (!h || !h.enabled) return day + ': Closed';
          return day + ': ' + h.open + ' – ' + h.close;
        }).join('\n')
      : 'Hours not provided.';

    const systemPrompt =
      'You are a helpful booking assistant for a business.\n' +
      'Answer ONLY using the business context below. Do not invent services, prices, or opening hours.\n' +
      'Do not claim that a booking has been confirmed.\n' +
      'Keep answers concise and friendly.\n\n' +
      'BUSINESS NAME: ' + (tenantContext.businessName || 'Unknown') + '\n' +
      'CATEGORY: ' + (tenantContext.businessCategory || 'N/A') + '\n' +
      'DESCRIPTION: ' + (tenantContext.businessDescription || 'N/A') + '\n\n' +
      'SERVICES:\n' + servicesText + '\n\n' +
      'OPERATING HOURS:\n' + hoursText;

    const promptText = systemPrompt + '\n\nCustomer question: ' + userMessage.trim();

    // Try multiple model IDs (API versions change over time)
    const models = [
      'gemini-2.0-flash',
      'gemini-1.5-flash',
      'gemini-1.5-flash-latest',
      'gemini-pro'
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
        try { data = JSON.parse(raw); } catch (e) {}

        if (!geminiRes.ok) {
          const msg = (data && data.error && data.error.message) || raw.slice(0, 200);
          console.error('Gemini model failed', model, geminiRes.status, msg);
          lastError = msg;
          // try next model
          continue;
        }

        let reply = null;
        try {
          reply = data.candidates[0].content.parts[0].text.trim();
        } catch (e) {
          lastError = 'Empty response from ' + model;
          continue;
        }

        return res.status(200).json({ reply: reply, model: model });
      } catch (e) {
        console.error('fetch error', model, e.message);
        lastError = e.message;
      }
    }

    return res.status(502).json({
      error: 'AI service temporarily unavailable.',
      detail: lastError || 'All models failed. Check GEMINI_API_KEY and that Generative Language API is enabled.'
    });
  } catch (err) {
    console.error('gemini handler error', err);
    return res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
};
