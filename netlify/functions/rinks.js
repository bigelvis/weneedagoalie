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

function parseRinkDoc(fields) {
  if (!fields) return {};
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v.stringValue !== undefined) out[k] = v.stringValue;
    else if (v.doubleValue !== undefined) out[k] = v.doubleValue;
    else if (v.integerValue !== undefined) out[k] = parseInt(v.integerValue);
    else out[k] = null;
  }
  return out;
}

// Rinks that Google Places missed but a real user found via custom search.
// Failure here should never break the main rink search, so this is wrapped
// in try/catch by the caller and just returns [] on any problem.
async function getManualRinks() {
  const token = await getAccessToken();
  const res = await fetch(`${FIRESTORE_BASE}/manualRinks?pageSize=300`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const data = await res.json();
  return (data.documents || []).map(d => parseRinkDoc(d.fields));
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // Accept either `location` (free text) or `zip` (legacy 5-digit)
  const { location, zip, pagetoken, query } = event.queryStringParameters || {};

  const locationInput = location || zip || '';

  if (!locationInput.trim()) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'A location or zip code is required' }) };
  }

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;

  function distanceMiles(lat1, lng1, lat2, lng2) {
    const R = 3958.8;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLng/2) * Math.sin(dLng/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  const EXCLUDE_KEYWORDS = [
    'pro shop', 'sports store', 'equipment', 'apparel', 'inline', 'roller',
    'miniature', 'mini golf', 'bowling', 'supply', 'retail', 'warehouse',
    'hotel', 'resort spa', 'country club', 'fitness center', 'gym',
  ];

  function isLikelyHockeyRink(place) {
    const name = (place.name || '').toLowerCase();
    if (EXCLUDE_KEYWORDS.some(kw => name.includes(kw))) return false;
    const positiveTerms = ['ice', 'rink', 'arena', 'hockey', 'skating', 'iceplex', 'iceport',
      'icehouse', 'blade', 'freeze', 'frost', 'glacial', 'polar', 'skate', 'quest'];
    return positiveTerms.some(t => name.includes(t));
  }

  try {
    // Geocode the location (works for zip codes, cities, regions, full addresses)
    const geocodeRes = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(locationInput)}&key=${apiKey}`
    );
    const geocodeData = await geocodeRes.json();

    if (!geocodeData.results || geocodeData.results.length === 0) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: `Location not found: "${locationInput}". Try being more specific, e.g. "Toronto, ON, Canada".` })
      };
    }

    const { lat, lng } = geocodeData.results[0].geometry.location;
    const formattedAddress = geocodeData.results[0].formatted_address;

    // Build Places search URL
    const isCustomSearch = query && query.trim().length > 0;
    let url;

    if (pagetoken) {
      url = `https://maps.googleapis.com/maps/api/place/textsearch/json?pagetoken=${encodeURIComponent(pagetoken)}&key=${apiKey}`;
    } else if (isCustomSearch) {
      const encodedQuery = encodeURIComponent(query.trim());
      url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodedQuery}&location=${lat},${lng}&radius=80000&key=${apiKey}`;
    } else {
      url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=ice+hockey+rink&location=${lat},${lng}&radius=50000&key=${apiKey}`;
    }

    const placesRes = await fetch(url);
    const placesData = await placesRes.json();

    const rinks = (placesData.results || [])
      .filter(place => isCustomSearch
        ? !EXCLUDE_KEYWORDS.some(kw => (place.name || '').toLowerCase().includes(kw))
        : isLikelyHockeyRink(place)
      )
      .map(place => {
        const pLat = place.geometry.location.lat;
        const pLng = place.geometry.location.lng;
        const miles = distanceMiles(lat, lng, pLat, pLng);
        const parts = (place.formatted_address || place.vicinity || '').split(',');
        return {
          name: place.name,
          address: parts[0] || '',
          city: parts.slice(1, 3).join(',').trim() || '',
          miles: Math.round(miles * 10) / 10,
          place_id: place.place_id,
          lat: pLat,
          lng: pLng,
        };
      });

    // Merge in rinks that Google Places missed but a real user previously
    // found via "Can't find your rink?" and we auto-captured. Skipped on
    // pagetoken continuations so they don't reappear duplicated across pages.
    // Never let a Firestore hiccup break the main rink search.
    if (!pagetoken) {
      try {
        const manualRinks = await getManualRinks();
        const norm = s => (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
        const radiusMiles = isCustomSearch ? 49.7 : 31.1; // matches the 80km/50km Places radius above
        const already = new Set(rinks.map(r => norm(r.name) + '|' + norm(r.address)));

        manualRinks
          .filter(r => typeof r.lat === 'number' && typeof r.lng === 'number')
          .filter(r => distanceMiles(lat, lng, r.lat, r.lng) <= radiusMiles)
          .filter(r => !isCustomSearch || norm(r.name).includes(norm(query)))
          .forEach(r => {
            const key = norm(r.name) + '|' + norm(r.address);
            if (already.has(key)) return;
            already.add(key);
            rinks.push({
              name: r.name,
              address: r.address,
              city: r.city || '',
              miles: Math.round(distanceMiles(lat, lng, r.lat, r.lng) * 10) / 10,
              place_id: null,
              lat: r.lat,
              lng: r.lng,
            });
          });
      } catch (e) {
        console.error('manualRinks merge skipped:', e.message);
      }
    }

    rinks.sort((a, b) => a.miles - b.miles);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        rinks,
        next_page_token: placesData.next_page_token || null,
        // Return geocode info so the front-end can store lat/lng instead of zip
        geocode: {
          formattedAddress,
          lat,
          lng,
        },
      }),
    };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
