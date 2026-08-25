/**
 * Vercel Serverless Function — Gemini AI Assistant
 * -------------------------------------------------
 * POST /api/gemini
 * Body: { tenantContext: {...}, userMessage: "..." }
 *
 * Environment variable required:
 *   GEMINI_API_KEY
 *
 * Never expose the key to the browser.
 */

export default async function handler(req, res) {
  // CORS for same-origin / simple deployments
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
    const { tenantContext, userMessage } = req.body || {};

    if (!userMessage || typeof userMessage !== 'string' || userMessage.trim().length === 0) {
      return res.status(400).json({ error: 'Missing userMessage' });
    }
    if (userMessage.length > 500) {
      return res.status(400).json({ error: 'Message too long (max 500 characters)' });
    }

    // Build a strict, controlled system prompt from tenant context only
    const ctx = tenantContext || {};
    const servicesText = Array.isArray(ctx.services) && ctx.services.length
      ? ctx.services.map(s =>
          `- ${s.name}: ${s.description || 'No description'} (${s.duration || '?'} min, price: ${s.price ?? 'n/a'})`
        ).join('\n')
      : 'No services listed.';

    const hoursText = ctx.operatingHours
      ? Object.entries(ctx.operatingHours).map(([day, h]) => {
          if (!h || !h.enabled) return `${day}: Closed`;
          return `${day}: ${h.open} – ${h.close}`;
        }).join('\n')
      : 'Hours not provided.';

    const systemPrompt = `You are a helpful booking assistant for a business.
Answer ONLY using the business context below. Do not invent services, prices, or opening hours.
Do not claim that a booking has been confirmed or made.
Do not ask for payment details.
Keep answers concise and friendly.
If the user asks something outside this context, politely say you can only help with this business's services and hours.

BUSINESS NAME: ${ctx.businessName || 'Unknown'}
CATEGORY: ${ctx.businessCategory || 'N/A'}
DESCRIPTION: ${ctx.businessDescription || 'N/A'}

SERVICES:
${servicesText}

OPERATING HOURS:
${hoursText}`;

    // Gemini API (generateContent)
    const model = 'gemini-1.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: `${systemPrompt}\n\nCustomer question: ${userMessage.trim()}` }]
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
    const reply =
      geminiData?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ||
      'I could not generate a response. Please try again.';

    return res.status(200).json({ reply });
  } catch (err) {
    console.error('gemini handler error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
