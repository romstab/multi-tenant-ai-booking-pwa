/**
 * GET/POST /api/booking-debug — proves which serverless code is deployed.
 * No secrets.
 */
const SERVER_BUILD = 'CREATE-BOOKING-RUNTIME-TRACE-3';
const DEPLOY_VERSION = '2.6.4-runtime-trace-3';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  return res.status(200).json({
    ok: true,
    fingerprint: 'CREATE-BOOKING-RUNTIME-TRACE-3',
    serverBuild: SERVER_BUILD,
    deployVersion: DEPLOY_VERSION,
    commitSha: process.env.VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_GIT_COMMIT_REF || 'local',
    vercelEnv: process.env.VERCEL_ENV || null,
    region: process.env.VERCEL_REGION || null,
    runtime: 'vercel-serverless',
    node: process.version,
    expectedCreateRoute: '/api/create-booking',
    time: new Date().toISOString(),
    note: 'If create-booking errors mention startMin, this file is NOT the code handling that request.'
  });
};
