exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const { zip } = event.queryStringParameters || {};

  if (!zip || !/^\d{5}$/.test(zip)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Valid 5-digit zip code required' }) };
  }

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;

  try {
    const geocodeRes = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${zip}&key=${apiKey}`);
    const geocodeData = await geocodeRes.json();

    if (!geocodeData.results || geocodeData.results.length === 0) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Zip code not found' }) };
    }

    const { lat, lng } = geocodeData.results[0].geometry.location;

    const placesRes = await fetch(`https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&rankby=distance&keyword=ice+rink+hockey+skating&key=${apiKey}`);
    const placesData = await placesRes.json();

    function distanceMiles(lat1, lng1, lat2, lng2) {
      const R = 3958.8;
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLng = (lng2 - lng1) * Math.PI / 180;
      const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLng/2) * Math.sin(dLng/2);
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    }

    const rinks = (placesData.results || []).slice(0, 10).map(place => {
      const pLat = place.geometry.location.lat;
      const pLng = place.geometry.location.lng;
      const miles = distanceMiles(lat, lng, pLat, pLng);
      const parts = (place.vicinity || '').split(',');
      return {
        name: place.name,
        address: parts[0] || '',
        city: parts.slice(1).join(',').trim() || '',
        miles: Math.round(miles * 10) / 10,
        place_id: place.place_id,
      };
    }).sort((a, b) => a.miles - b.miles);

    return { statusCode: 200, headers, body: JSON.stringify({ rinks }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
