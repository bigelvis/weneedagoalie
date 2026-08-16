// manage-rinks.js
// Manages the "manualRinks" Firestore collection — rinks that Google Places
// missed but a real user found via "Can't find your rink?" custom search.
//
// action=capture (POST, no auth) — called from find-goalie.html / goalie-signup.html
//   whenever someone selects a rink from custom search results. Dedupes by
//   normalized name+address before writing.
//
// action=list|add|update|delete — admin-only (ADMIN_SECRET), same pattern as
// admin-stats.js, for reviewing/pruning what's been auto-captured.

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
    else out[k] = null;
  }
  return out;
}

function toFields(values) {
  const fields = {};
  for (const [k, v] of Object.entries(values)) {
    if (typeof v === 'string') fields[k] = { stringValue: v };
    else if (typeof v === 'boolean') fields[k] = { booleanValue: v };
    else if (typeof v === 'number') fields[k] = { doubleValue: v };
  }
  return fields;
}

function normalize(s) {
  return (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

async function getManualRinks(token) {
  const res = await fetch(`${FIRESTORE_BASE}/manualRinks?pageSize=300`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const data = await res.json();
  return (data.documents || []).map(d => ({
    id: d.name.split('/').pop(),
    ...parseDoc(d.fields)
  }));
}

async function addRink(token, values) {
  await fetch(`${FIRESTORE_BASE}/manualRinks`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFields(values) })
  });
}

async function updateRink(token, id, updates) {
  const mask = Object.keys(updates).map(k => `updateMask.fieldPaths=${k}`).join('&');
  await fetch(`${FIRESTORE_BASE}/manualRinks/${id}?${mask}`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFields(updates) })
  });
}

async function deleteRink(token, id) {
  await fetch(`${FIRESTORE_BASE}/manualRinks/${id}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` }
  });
}

const EXCLUDE_KEYWORDS = [
  'pro shop', 'sports store', 'equipment', 'apparel', 'inline', 'roller',
  'miniature', 'mini golf', 'bowling', 'supply', 'retail', 'warehouse',
  'hotel', 'resort spa', 'country club', 'fitness center', 'gym',
];

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const { secret, action, id } = event.queryStringParameters || {};

  try {
    // Public capture endpoint — no admin secret required, since it's called
    // from the public site. Security note: we do NOT trust client-submitted
    // name/address/coordinates here — anyone can POST to this URL directly,
    // bypassing the UI. Instead we take only a place_id and re-fetch the
    // authoritative details from Google server-side, so an attacker can only
    // ever reference a real place that actually exists — not inject arbitrary
    // text (which would otherwise render unescaped elsewhere in the app).
    if (event.httpMethod === 'POST' && action === 'capture') {
      const body = JSON.parse(event.body || '{}');
      const placeId = (body.place_id || '').trim();
      if (!placeId) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'place_id is required' }) };
      }

      const apiKey = process.env.GOOGLE_PLACES_API_KEY;
      const detailsRes = await fetch(
        `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=name,formatted_address,geometry&key=${apiKey}`
      );
      const detailsData = await detailsRes.json();
      if (detailsData.status !== 'OK' || !detailsData.result) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Could not verify this place with Google' }) };
      }

      const place = detailsData.result;
      const name = (place.name || '').trim().slice(0, 120);
      const parts = (place.formatted_address || '').split(',');
      const address = (parts[0] || '').trim().slice(0, 200);
      const city = parts.slice(1, 3).join(',').trim().slice(0, 120);
      const lat = place.geometry && place.geometry.location && place.geometry.location.lat;
      const lng = place.geometry && place.geometry.location && place.geometry.location.lng;

      if (!name || !address || typeof lat !== 'number' || typeof lng !== 'number') {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Incomplete place data from Google' }) };
      }
      if (EXCLUDE_KEYWORDS.some(kw => name.toLowerCase().includes(kw))) {
        // Silently accept-but-skip rather than error — this isn't the caller's
        // fault, and we don't want to surface an error over a normal selection.
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, skipped: true }) };
      }

      const token = await getAccessToken();
      const existing = await getManualRinks(token);
      const dup = existing.find(r => normalize(r.name) === normalize(name) && normalize(r.address) === normalize(address));
      if (dup) {
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, duplicate: true }) };
      }
      await addRink(token, { name, address, city, lat, lng, place_id: placeId, source: 'auto', capturedAt: new Date().toISOString() });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    // Everything below requires the admin secret
    if (secret !== process.env.ADMIN_SECRET) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    const token = await getAccessToken();

    if (event.httpMethod === 'POST' && action === 'update') {
      const body = JSON.parse(event.body || '{}');
      const updates = {};
      if (body.name !== undefined) updates.name = body.name.trim();
      if (body.address !== undefined) updates.address = body.address.trim();
      if (body.city !== undefined) updates.city = body.city.trim();
      if (body.lat !== undefined) updates.lat = Number(body.lat) || 0;
      if (body.lng !== undefined) updates.lng = Number(body.lng) || 0;
      await updateRink(token, id, updates);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    if (event.httpMethod === 'POST' && action === 'delete') {
      await deleteRink(token, id);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    // Default GET: list all manually-added rinks
    const rinks = await getManualRinks(token);
    rinks.sort((a, b) => (b.capturedAt || '').localeCompare(a.capturedAt || ''));
    return { statusCode: 200, headers, body: JSON.stringify({ rinks }) };

  } catch (e) {
    console.error('manage-rinks error:', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
