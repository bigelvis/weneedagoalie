// netlify/functions/stats.js
// Public read-only stats endpoint — no auth required
// Returns aggregated goalie + request data, no PII

const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;

async function getAccessToken() {
  const jwt = await makeJWT();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('OAuth failed: ' + JSON.stringify(data));
  return data.access_token;
}

async function makeJWT() {
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKeyRaw = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const pemBody = privateKeyRaw.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\n/g, '');
  const keyData = Buffer.from(pemBody, 'base64');
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: clientEmail, sub: clientEmail,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/datastore',
  };
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const signingInput = `${enc(header)}.${enc(payload)}`;
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', keyData,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, Buffer.from(signingInput));
  return `${signingInput}.${Buffer.from(sig).toString('base64url')}`;
}

function parseDoc(fields) {
  if (!fields) return {};
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v.stringValue !== undefined) out[k] = v.stringValue;
    else if (v.booleanValue !== undefined) out[k] = v.booleanValue;
    else if (v.integerValue !== undefined) out[k] = parseInt(v.integerValue);
    else if (v.timestampValue !== undefined) out[k] = v.timestampValue;
    else if (v.arrayValue) out[k] = (v.arrayValue.values || []).map(i => i.stringValue ?? i.integerValue ?? i.booleanValue ?? null);
    else out[k] = null;
  }
  return out;
}

async function getCollection(token, col) {
  const res = await fetch(`${FIRESTORE_BASE}/${col}?pageSize=500`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const data = await res.json();
  return (data.documents || []).map(d => ({
    id: d.name.split('/').pop(),
    ...parseDoc(d.fields)
  }));
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    // Cache for 5 minutes to avoid hammering Firestore on every page load
    'Cache-Control': 'public, max-age=300',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const token = await getAccessToken();
    const [goalies, requests] = await Promise.all([
      getCollection(token, 'goalies'),
      getCollection(token, 'requests'),
    ]);

    // --- Goalies by skill level ---
    const LEVELS = ['A', 'Upper B', 'Lower B', 'Upper C', 'Lower C', 'Upper D', 'Beginner', 'Pickup/Rec'];
    const byLevel = {};
    LEVELS.forEach(l => byLevel[l] = 0);
    goalies.forEach(g => {
      const lvl = g.skillLevel || g.level || '';
      if (byLevel[lvl] !== undefined) byLevel[lvl]++;
    });

    // --- Top 10 rinks by number of goalies who listed them ---
    const rinkCounts = {};
    goalies.forEach(g => {
      const rinks = Array.isArray(g.rinks) ? g.rinks : [];
      rinks.forEach(rink => {
        if (rink && rink.trim()) {
          rinkCounts[rink.trim()] = (rinkCounts[rink.trim()] || 0) + 1;
        }
      });
    });
    const topRinks = Object.entries(rinkCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, count }));

    // --- Signups per month (last 6 months) ---
    const now = new Date();
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({
        label: d.toLocaleString('en-US', { month: 'short' }),
        year: d.getFullYear(),
        month: d.getMonth(),
        count: 0,
      });
    }
    goalies.forEach(g => {
      if (!g.createdAt) return;
      const d = new Date(g.createdAt);
      const m = months.find(mo => mo.year === d.getFullYear() && mo.month === d.getMonth());
      if (m) m.count++;
    });

    // --- Unique rinks count ---
    const uniqueRinks = Object.keys(rinkCounts).length;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        totalGoalies: goalies.length,
        totalRequests: requests.length,
        uniqueRinks,
        byLevel,
        topRinks,
        signupsByMonth: months.map(m => ({ label: m.label, count: m.count })),
      }),
    };

  } catch (e) {
    console.error('stats error:', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
