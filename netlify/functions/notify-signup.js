// notify-signup.js
// Sends an internal notification email to the site owner whenever a new goalie signs up.

const SKILL_LEVELS = {
  a:'A – Advanced', ub:'B+ – Upper B', lb:'B – Lower B',
  uc:'C+ – Upper C', lc:'C – Lower C', ud:'D+ – Upper D',
  d:'D – Beginner', rec:'Rec / Pickup'
};

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Email service not configured' }) };
  }

  let goalie;
  try {
    goalie = JSON.parse(event.body);
  } catch(e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { name, email, rinks, levels } = goalie;
  if (!name || !email) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing goalie data' }) };
  }

  const levelNames = (levels || []).map(l => SKILL_LEVELS[l] || l).join(', ');
  const rinkList = (rinks || []).join(', ');

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:'Helvetica Neue',Arial,sans-serif;background:#f0f8ff;margin:0;padding:24px;">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;border:1.5px solid #d0d8e8;">
    <div style="background:#0d2e5e;padding:24px 32px;text-align:center;">
      <div style="font-size:26px;font-weight:900;color:#fff;letter-spacing:1px;font-family:Arial,sans-serif;">New Goalie Signup 🥅</div>
    </div>
    <div style="padding:28px 32px;">
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr><td style="color:#5a6480;font-weight:700;padding:8px 0;width:90px;vertical-align:top;">Name</td><td style="font-weight:800;color:#1a2340;">${name}</td></tr>
        <tr><td style="color:#5a6480;font-weight:700;padding:8px 0;vertical-align:top;">Email</td><td style="font-weight:800;color:#1a2340;">${email}</td></tr>
        <tr><td style="color:#5a6480;font-weight:700;padding:8px 0;vertical-align:top;">Rinks</td><td style="font-weight:800;color:#1a2340;">${rinkList || '—'}</td></tr>
        <tr><td style="color:#5a6480;font-weight:700;padding:8px 0;vertical-align:top;">Level(s)</td><td style="font-weight:800;color:#c8102e;">${levelNames || '—'}</td></tr>
      </table>
    </div>
    <div style="background:#f8fafc;border-top:1.5px solid #d0d8e8;padding:14px 32px;text-align:center;">
      <p style="font-size:12px;color:#aab4c8;margin:0;">weneedagoalie.com · Admin notification</p>
    </div>
  </div>
</body></html>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'WE NEED A GOALIE <noreply@weneedagoalie.com>',
      to: 'rhuskey@gmail.com',
      subject: `🥅 New goalie signup: ${name}`,
      html,
    }),
  });
  const data = await res.json();
  return { statusCode: res.ok ? 200 : 500, headers, body: JSON.stringify({ ok: res.ok, id: data.id }) };
};
