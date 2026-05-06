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
        };
      })
      .sort((a, b) => a.miles - b.miles);

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
