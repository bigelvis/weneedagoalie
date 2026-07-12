// donation-status.js
// Public read-only endpoint for the homepage donate meter.
// No secret required to call this — it only ever returns two numbers.
// Server-side Firestore access still goes through the service account, same as admin-stats.js.

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
    scope: 'https://www.googleapis.com/auth/datastore.readonly',
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
    else if (v.doubleValue !== undefined) out[k] = v.doubleValue;
    else out[k] = null;
  }
  return out;
}

exports.handler = async () => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=300', // 5 min edge cache — this number changes rarely
  };

  try {
    const token = await getAccessToken();
    const res = await fetch(`${FIRESTORE_BASE}/config/donations`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!res.ok) {
      // Doc doesn't exist yet (e.g. before first admin save) — return sane defaults
      return { statusCode: 200, headers, body: JSON.stringify({ amountRaised: 0, goal: 20 }) };
    }

    const data = await res.json();
    const doc = parseDoc(data.fields);
    return {
      statusCode: 200, headers,
      body: JSON.stringify({ amountRaised: doc.amountRaised ?? 0, goal: doc.goal ?? 20 })
    };
  } catch (e) {
    console.error('donation-status error:', e);
    // Fail soft — homepage meter just falls back to defaults, never shows an error to visitors
    return { statusCode: 200, headers, body: JSON.stringify({ amountRaised: 0, goal: 20 }) };
  }
};
