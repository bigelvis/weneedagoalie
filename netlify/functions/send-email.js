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

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch(e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { goalies, request } = payload;
  // goalies: array of { name, email, levels }
  // request: { team, contact, cemail, cphone, rink, date, time, notes, levels }

  if (!goalies || !goalies.length || !request) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing goalies or request data' }) };
  }

  const SKILL_LEVELS = {
    a:'A – Advanced', ub:'B+ – Upper B', lb:'B – Lower B',
    uc:'C+ – Upper C', lc:'C – Lower C', ud:'D+ – Upper D',
    d:'D – Beginner', rec:'Rec / Pickup'
  };

  const dt = new Date(request.date + 'T' + request.time);
  const fmtDate = dt.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' });
  const fmtTime = dt.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
  const levelNames = (request.levels || []).map(l => SKILL_LEVELS[l] || l).join(', ');

  const results = await Promise.all(goalies.map(async (goalie) => {
    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:'Helvetica Neue',Arial,sans-serif;background:#f0f8ff;margin:0;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;border:1.5px solid #d0d8e8;">

    <!-- Header -->
    <div style="background:#0d2e5e;padding:28px 32px;text-align:center;">
      <div style="font-size:32px;font-weight:900;color:#fff;letter-spacing:2px;font-family:Arial,sans-serif;">
        WENEEDAGOALIE<span style="color:#c8102e;">.</span>COM
      </div>
      <div style="color:rgba(255,255,255,0.7);font-size:13px;margin-top:6px;letter-spacing:1px;text-transform:uppercase;">A team needs you in net 🏒</div>
    </div>

    <!-- Body -->
    <div style="padding:32px;">
      <p style="font-size:17px;font-weight:700;color:#1a2340;margin:0 0 6px;">Hey ${goalie.name},</p>
      <p style="font-size:15px;color:#5a6480;margin:0 0 24px;">A team is looking for a goalie and you match their rink and skill level. Here are the details:</p>

      <!-- Game Card -->
      <div style="background:#f0f8ff;border-radius:10px;border:1.5px solid #d0d8e8;padding:20px;margin-bottom:24px;">
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <tr><td style="color:#5a6480;font-weight:700;padding:6px 0;width:110px;">Team</td><td style="font-weight:800;color:#1a2340;">${request.team}</td></tr>
          <tr><td style="color:#5a6480;font-weight:700;padding:6px 0;">Rink</td><td style="font-weight:800;color:#1a2340;">${request.rink}</td></tr>
          <tr><td style="color:#5a6480;font-weight:700;padding:6px 0;">Date</td><td style="font-weight:800;color:#1a2340;">${fmtDate}</td></tr>
          <tr><td style="color:#5a6480;font-weight:700;padding:6px 0;">Time</td><td style="font-weight:800;color:#1a2340;">${fmtTime}</td></tr>
          <tr><td style="color:#5a6480;font-weight:700;padding:6px 0;">Level</td><td style="font-weight:800;color:#c8102e;">${levelNames}</td></tr>
          ${request.notes ? `<tr><td style="color:#5a6480;font-weight:700;padding:6px 0;vertical-align:top;">Notes</td><td style="color:#1a2340;">${request.notes}</td></tr>` : ''}
        </table>
      </div>

      <!-- Contact -->
      <p style="font-size:14px;font-weight:800;color:#1a2340;margin:0 0 8px;">To confirm, reply directly to the team:</p>
      <div style="background:#fff;border-radius:10px;border:1.5px solid #d0d8e8;padding:16px;margin-bottom:24px;">
        <div style="font-size:15px;font-weight:800;color:#1a2340;">${request.contact}</div>
        <div style="font-size:14px;color:#2a5298;margin-top:4px;">${request.cemail}</div>
        ${request.cphone ? `<div style="font-size:14px;color:#5a6480;margin-top:4px;">${request.cphone}</div>` : ''}
      </div>

      <p style="font-size:13px;color:#5a6480;margin:0;">You're receiving this because you signed up as a goalie at <strong>${request.rink}</strong> on weneedagoalie.com.</p>
    </div>

    <!-- Footer -->
    <div style="background:#f8fafc;border-top:1.5px solid #d0d8e8;padding:16px 32px;text-align:center;">
      <p style="font-size:12px;color:#aab4c8;margin:0;">weneedagoalie.com · Matching Teams And Goalies</p>
    </div>
  </div>
</body>
</html>`;

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'WE NEED A GOALIE <noreply@weneedagoalie.com>',
        to: goalie.email,
        subject: `🏒 Game request: ${request.team} needs a goalie at ${request.rink}`,
        html,
      }),
    });

    const data = await res.json();
    return { goalie: goalie.name, ok: res.ok, id: data.id, error: data.message };
  }));

  const allOk = results.every(r => r.ok);
  return {
    statusCode: allOk ? 200 : 207,
    headers,
    body: JSON.stringify({ results }),
  };
};
