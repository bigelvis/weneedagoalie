const admin = require('firebase-admin');

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

function maskEmail(email) {
  if (!email) return '—';
  const [user, domain] = email.split('@');
  if (!domain) return email;
  return user.slice(0, 2) + '***@' + domain;
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

  try {
    const snap = await db.collection('goalies').get();
    const goalies = snap.docs.map(d => {
      const data = d.data();
      return {
        id: d.id,
        name: data.name || 'Unknown',
        email: maskEmail(data.email),
        levels: data.levels || [],
        rinks: data.rinks || [],
        zip: data.zip || null,
        location: data.location || null,
        active: data.active !== false,
      };
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ goalies, total: goalies.length }),
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
