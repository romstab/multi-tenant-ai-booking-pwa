/**
 * GET/POST /api/booking-debug
 * Safe runtime identity for deployment verification. No secrets.
 */
const SERVER_BUILD = 'CREATE-BOOKING-FIX-FINAL-2';
const DEPLOY_VERSION = '2.6.4-booking-fix';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  return res.status(200).json({
    ok: true,
    route: '/api/create-booking',
    debugRoute: '/api/booking-debug',
    serverBuild: SERVER_BUILD,
    deployVersion: DEPLOY_VERSION,
    commitSha: process.env.VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_GIT_COMMIT_REF || 'local',
    vercelEnv: process.env.VERCEL_ENV || null,
    region: process.env.VERCEL_REGION || null,
    runtime: 'vercel-serverless',
    node: process.version,
    time: new Date().toISOString()
  });
};
