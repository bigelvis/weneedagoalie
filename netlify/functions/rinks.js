exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const { zip, pagetoken } = event.queryStringParameters || {};

  if (!zip || !/^\d{5}$/.test(zip)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Valid 5-digit zip code required' }) };
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
    const types = place.types || [];
    if (EXCLUDE_KEYWORDS.some(kw => name.includes(kw))) return false;
    const positiveTerms = ['ice', 'rink', 'arena', 'hockey', 'skating', 'iceplex', 'iceport', 'icehouse', 'blade', 'freeze', 'frost', 'glacial', 'polar'];
    return positiveTerms.some(t => name.includes(t));
  }

  try {
    // Geocode the zip
    const geocodeRes = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${zip}&key=${apiKey}`);
    const geocodeData = await geocodeRes.json();

    if (!geocodeData.results || geocodeData.results.length === 0) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Zip code not found' }) };
    }

    const { lat, lng } = geocodeData.results[0].geometry.location;

    // Text search for "ice hockey rink" — much more precise than nearby keyword search
    let url;
    if (pagetoken) {
      url = `https://maps.googleapis.com/maps/api/place/textsearch/json?pagetoken=${encodeURIComponent(pagetoken)}&key=${apiKey}`;
    } else {
      url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=ice+hockey+rink&location=${lat},${lng}&radius=50000&key=${apiKey}`;
    }

    const placesRes = await fetch(url);
    const placesData = await placesRes.json();

    const rinks = (placesData.results || [])
      .filter(isLikelyHockeyRink)
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
        };
      })
      .sort((a, b) => a.miles - b.miles);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        rinks,
        next_page_token: placesData.next_page_token || null,
      }),
    };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
