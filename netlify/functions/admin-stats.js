// admin-stats.js
// Reads all goalies and requests server-side using service account
// Protected by ADMIN_SECRET env var

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
    else if (v.doubleValue !== undefined) out[k] = v.doubleValue;
    else if (v.timestampValue !== undefined) out[k] = v.timestampValue;
    else if (v.arrayValue) out[k] = (v.arrayValue.values || []).map(i => i.stringValue ?? i.integerValue ?? i.booleanValue ?? null);
    else out[k] = null;
  }
  return out;
}

async function getCollection(token, col) {
  const res = await fetch(`${FIRESTORE_BASE}/${col}?pageSize=200`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const data = await res.json();
  return (data.documents || []).map(d => ({
    id: d.name.split('/').pop(),
    ...parseDoc(d.fields)
  }));
}

async function updateGoalie(token, id, updates) {
  const fields = {};
  for (const [k, v] of Object.entries(updates)) {
    if (typeof v === 'string') fields[k] = { stringValue: v };
    else if (typeof v === 'boolean') fields[k] = { booleanValue: v };
    else if (Array.isArray(v)) fields[k] = { arrayValue: { values: v.map(s => ({ stringValue: s })) } };
  }
  const mask = Object.keys(updates).map(k => `updateMask.fieldPaths=${k}`).join('&');
  await fetch(`${FIRESTORE_BASE}/goalies/${id}?${mask}`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
}

async function getDoc(token, path) {
  const res = await fetch(`${FIRESTORE_BASE}/${path}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) return {}; // doc doesn't exist yet — treat as empty
  const data = await res.json();
  return parseDoc(data.fields);
}

async function setDoc(token, path, values) {
  const fields = {};
  for (const [k, v] of Object.entries(values)) {
    if (typeof v === 'string') fields[k] = { stringValue: v };
    else if (typeof v === 'boolean') fields[k] = { booleanValue: v };
    else if (typeof v === 'number') fields[k] = { doubleValue: v };
  }
  await fetch(`${FIRESTORE_BASE}/${path}`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
}

async function deleteGoalie(token, id) {
  await fetch(`${FIRESTORE_BASE}/goalies/${id}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` }
  });
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  // Check admin secret
  const { secret, action, id } = event.queryStringParameters || {};
  if (secret !== process.env.ADMIN_SECRET) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    const token = await getAccessToken();

    // Handle mutations
    if (event.httpMethod === 'POST' && action === 'update') {
      const body = JSON.parse(event.body || '{}');
      await updateGoalie(token, id, body);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    if (event.httpMethod === 'POST' && action === 'delete') {
      await deleteGoalie(token, id);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    if (event.httpMethod === 'POST' && action === 'toggle') {
      const body = JSON.parse(event.body || '{}');
      await updateGoalie(token, id, { active: body.active });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    if (event.httpMethod === 'GET' && action === 'getDonation') {
      const doc = await getDoc(token, 'config/donations');
      return {
        statusCode: 200, headers,
        body: JSON.stringify({ amountRaised: doc.amountRaised ?? 0, goal: doc.goal ?? 20 })
      };
    }

    if (event.httpMethod === 'POST' && action === 'setDonation') {
      const body = JSON.parse(event.body || '{}');
      await setDoc(token, 'config/donations', {
        amountRaised: Number(body.amountRaised) || 0,
        goal: Number(body.goal) || 20,
      });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    // Default: GET all goalies + requests
    const [goalies, requests] = await Promise.all([
      getCollection(token, 'goalies'),
      getCollection(token, 'requests'),
    ]);

    return {
      statusCode: 200, headers,
      body: JSON.stringify({ goalies, requests })
    };

  } catch(e) {
    console.error('admin-stats error:', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
