/**
 * Vercel Serverless — Gemini AI Assistant (CommonJS for Vercel)
 * POST /api/gemini
 * Env: GEMINI_API_KEY
 */

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY is not set');
    return res.status(500).json({ error: 'AI assistant is not configured.' });
  }

  try {
    const body = req.body || {};
    const tenantContext = body.tenantContext || {};
    const userMessage = body.userMessage;

    if (!userMessage || typeof userMessage !== 'string' || userMessage.trim().length === 0) {
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
      'Do not claim that a booking has been confirmed or made.\n' +
      'Do not ask for payment details.\n' +
      'Keep answers concise and friendly.\n' +
      "If the user asks something outside this context, politely say you can only help with this business's services and hours.\n\n" +
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

    const model = 'gemini-1.5-flash';
    const url =
      'https://generativelanguage.googleapis.com/v1beta/models/' +
      model +
      ':generateContent?key=' +
      apiKey;

    const geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: systemPrompt + '\n\nCustomer question: ' + userMessage.trim() }]
          }
        ],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 400
        }
      })
    });

    if (!geminiRes.ok) {
      const errBody = await geminiRes.text();
      console.error('Gemini API error', geminiRes.status, errBody);
      return res.status(502).json({ error: 'AI service temporarily unavailable.' });
    }

    const geminiData = await geminiRes.json();
    let reply = 'I could not generate a response. Please try again.';
    try {
      reply = geminiData.candidates[0].content.parts[0].text.trim();
    } catch (e) {}

    return res.status(200).json({ reply: reply });
  } catch (err) {
    console.error('gemini handler error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
