// confirm-request.js
// Uses Firestore REST API + Resend — zero npm dependencies needed

const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;

const SKILL_LEVELS = {
  a:'A – Advanced', ub:'B+ – Upper B', lb:'B – Lower B',
  uc:'C+ – Upper C', lc:'C – Lower C', ud:'D+ – Upper D',
  d:'D – Beginner', rec:'Rec / Pickup'
};

// ---- JWT + OAuth ----
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

// ---- Firestore helpers ----
function parseDoc(fields) {
  if (!fields) return {};
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v.stringValue !== undefined) out[k] = v.stringValue;
    else if (v.booleanValue !== undefined) out[k] = v.booleanValue;
    else if (v.integerValue !== undefined) out[k] = parseInt(v.integerValue);
    else if (v.arrayValue) out[k] = (v.arrayValue.values || []).map(i => i.stringValue ?? i.integerValue ?? i.booleanValue ?? null);
    else out[k] = null;
  }
  return out;
}

async function queryWhere(token, col, field, value, isBoolean = false) {
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: col }],
          where: {
            fieldFilter: {
              field: { fieldPath: field },
              op: 'EQUAL',
              value: isBoolean ? { booleanValue: value } : { stringValue: value }
            }
          }
        }
      })
    }
  );
  return res.json();
}

async function patchDoc(token, docPath, updates) {
  const fields = {};
  for (const [k, v] of Object.entries(updates)) {
    if (typeof v === 'string') fields[k] = { stringValue: v };
    else if (typeof v === 'boolean') fields[k] = { booleanValue: v };
  }
  const mask = Object.keys(updates).map(k => `updateMask.fieldPaths=${k}`).join('&');
  await fetch(`${FIRESTORE_BASE}/${docPath}?${mask}`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
}

// ---- HTML pages ----
function page(title, emoji, heading, msg, color = '#1A7A3E') {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title} — We Need A Goalie</title>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Nunito:wght@400;700;800&display=swap" rel="stylesheet"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Nunito',sans-serif;background:#F0F8FF;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
.card{background:#fff;border-radius:16px;border:1.5px solid #D0D8E8;padding:2.5rem;max-width:480px;width:100%;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,0.07)}
.emoji{font-size:56px;margin-bottom:1rem}
.title{font-family:'Bebas Neue',sans-serif;font-size:36px;letter-spacing:2px;color:${color};margin-bottom:12px}
.msg{font-size:15px;color:#5A6480;line-height:1.7}
.home{display:inline-block;margin-top:1.5rem;padding:12px 28px;background:#0A1628;color:#fff;border-radius:10px;font-weight:800;font-size:14px;text-decoration:none}
</style></head>
<body><div class="card">
<div class="emoji">${emoji}</div>
<div class="title">${heading}</div>
<div class="msg">${msg}</div>
<a class="home" href="https://weneedagoalie.com">← Back to homepage</a>
</div></body></html>`;
}

// ---- Handler ----
exports.handler = async (event) => {
  const HTML = { 'Content-Type': 'text/html' };
  const { token } = event.queryStringParameters || {};

  if (!token) return { statusCode: 400, headers: HTML, body: page('Error','❌','Invalid Link','This confirmation link is missing a token.','#CC2200') };

  try {
    const accessToken = await getAccessToken();
    console.log('✓ Got access token');

    // Find request by confirmToken
    const rows = await queryWhere(accessToken, 'requests', 'confirmToken', token);
    const hit = (rows || []).find(r => r.document);
    if (!hit) return { statusCode: 404, headers: HTML, body: page('Not Found','🤔','Link Not Found','This confirmation link is invalid or has already been used.','#CC2200') };

    const docId = hit.document.name.split('/').pop();
    const req = parseDoc(hit.document.fields);
    console.log('✓ Found request:', req.team, req.rink, 'status:', req.status);

    if (req.status === 'confirmed') {
      return { statusCode: 200, headers: HTML, body: page('Already Sent','✅','Already Confirmed!',`Goalies were already notified for <strong>${req.team}</strong>'s game at <strong>${req.rink}</strong>.`) };
    }

    // Get matching active goalies
    const goalieRows = await queryWhere(accessToken, 'goalies', 'active', true, true);
    console.log('✓ Total active goalies found:', (goalieRows || []).filter(r => r.document).length);
    const matched = [];
    for (const row of goalieRows || []) {
      if (!row.document) continue;
      const g = parseDoc(row.document.fields);
      const rinkOk = Array.isArray(g.rinks) && g.rinks.includes(req.rink);
      const levelOk = Array.isArray(g.levels) && Array.isArray(req.levels) && g.levels.some(l => req.levels.includes(l));
      console.log(`  Goalie ${g.name}: rinks=${JSON.stringify(g.rinks)}, rinkOk=${rinkOk}, levelOk=${levelOk}`);
      if (rinkOk && levelOk && g.email) matched.push(g);
    }
    console.log('✓ Matched goalies:', matched.map(g => g.name));

    // Format date/time
    const dt = new Date(req.date + 'T' + req.time);
    const fmtDate = dt.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' });
    const fmtTime = dt.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
    const levelNames = (req.levels || []).map(l => SKILL_LEVELS[l] || l).join(', ');

    // Send goalie emails
    if (matched.length > 0) {
      await Promise.all(matched.map(goalie => {
        const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:'Helvetica Neue',Arial,sans-serif;background:#f0f8ff;margin:0;padding:24px;">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;border:1.5px solid #d0d8e8;">
  <div style="background:#0d2e5e;padding:28px 32px;text-align:center;">
    <div style="font-size:32px;font-weight:900;color:#fff;letter-spacing:2px;font-family:Arial,sans-serif;">WENEEDAGOALIE<span style="color:#c8102e;">.</span>COM</div>
    <div style="color:rgba(255,255,255,0.7);font-size:13px;margin-top:6px;letter-spacing:1px;text-transform:uppercase;">A team needs you in net 🏒</div>
  </div>
  <div style="padding:32px;">
    <p style="font-size:17px;font-weight:700;color:#1a2340;margin:0 0 6px;">Hey ${goalie.name},</p>
    <p style="font-size:15px;color:#5a6480;margin:0 0 24px;">A team is looking for a goalie and you match their rink and skill level:</p>
    <div style="background:#f0f8ff;border-radius:10px;border:1.5px solid #d0d8e8;padding:20px;margin-bottom:24px;">
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr><td style="color:#5a6480;font-weight:700;padding:6px 0;width:110px;">Team</td><td style="font-weight:800;color:#1a2340;">${req.team}</td></tr>
        <tr><td style="color:#5a6480;font-weight:700;padding:6px 0;">Rink</td><td style="font-weight:800;color:#1a2340;">${req.rink}</td></tr>
        <tr><td style="color:#5a6480;font-weight:700;padding:6px 0;">Date</td><td style="font-weight:800;color:#1a2340;">${fmtDate}</td></tr>
        <tr><td style="color:#5a6480;font-weight:700;padding:6px 0;">Time</td><td style="font-weight:800;color:#1a2340;">${fmtTime}</td></tr>
        <tr><td style="color:#5a6480;font-weight:700;padding:6px 0;">Level</td><td style="font-weight:800;color:#c8102e;">${levelNames}</td></tr>
        ${req.notes ? `<tr><td style="color:#5a6480;font-weight:700;padding:6px 0;vertical-align:top;">Notes</td><td style="color:#1a2340;">${req.notes}</td></tr>` : ''}
      </table>
    </div>
    <p style="font-size:14px;font-weight:800;color:#1a2340;margin:0 0 8px;">Reply directly to the team to confirm:</p>
    <div style="background:#fff;border-radius:10px;border:1.5px solid #d0d8e8;padding:16px;margin-bottom:24px;">
      <div style="font-size:15px;font-weight:800;color:#1a2340;">${req.contact}</div>
      <div style="font-size:14px;color:#2a5298;margin-top:4px;">${req.cemail}</div>
      ${req.cphone ? `<div style="font-size:14px;color:#5a6480;margin-top:4px;">${req.cphone}</div>` : ''}
    </div>
    <p style="font-size:13px;color:#5a6480;">You're receiving this because you signed up at <strong>${req.rink}</strong> on weneedagoalie.com. <a href="https://weneedagoalie.com/unsubscribe.html?email=${encodeURIComponent(goalie.email)}" style="color:#2a5298;">Unsubscribe</a></p>
  </div>
  <div style="background:#f8fafc;border-top:1.5px solid #d0d8e8;padding:16px 32px;text-align:center;">
    <p style="font-size:12px;color:#aab4c8;margin:0;">weneedagoalie.com · Matching Teams And Goalies</p>
  </div>
</div></body></html>`;

        return fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'WE NEED A GOALIE <noreply@weneedagoalie.com>',
            to: goalie.email,
            subject: `🏒 Game request: ${req.team} needs a goalie at ${req.rink}`,
            html,
          }),
        }).then(async r => {
          const d = await r.json();
          console.log(`Resend → ${goalie.email}: status=${r.status}`, JSON.stringify(d));
        });
      }));
    }

    // Mark confirmed
    await patchDoc(accessToken, `requests/${docId}`, { status: 'confirmed' });

    const n = matched.length;
    const body = n > 0
      ? `<strong>${n} goalie${n>1?'s':''}</strong> at <strong>${req.rink}</strong> have been notified about <strong>${req.team}</strong>'s game on ${fmtDate} at ${fmtTime}.<br><br>They'll reply to <strong>${req.cemail}</strong> to confirm.`
      : `No goalies are currently registered at <strong>${req.rink}</strong> for those skill levels. You may want to post in your league group as a backup.`;

    return {
      statusCode: 200, headers: HTML,
      body: page(
        n > 0 ? 'Goalies Notified' : 'No Matches',
        n > 0 ? '🏒' : '😕',
        n > 0 ? 'Goalies Notified!' : 'No Matches Found',
        body,
        n > 0 ? '#1A7A3E' : '#CC2200'
      )
    };

  } catch(e) {
    console.error('confirm-request error:', e);
    return { statusCode: 500, headers: HTML, body: page('Error','❌','Something Went Wrong',`${e.message}`,'#CC2200') };
  }
};
