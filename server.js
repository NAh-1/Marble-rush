import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import nodemailer from 'nodemailer';
import QRCode from 'qrcode';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const PHOTO_DIR = '/tmp/marble-rush-photos';
const MAX_PHOTOS = 120;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const PUBLIC_DIR = path.join(__dirname, 'public');

// Trust Render / reverse-proxy headers (x-forwarded-host, x-forwarded-proto)
app.set('trust proxy', 1);

try {
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
} catch (err) {
  console.error('Could not create photo directory:', err);
}

/** @type {Map<string, { id: string, buffer: Buffer, mimeType: string, playerName: string, finalTime: string, rank: number | null, createdAt: number }>} */
const photoStore = new Map();

app.use(express.json({ limit: '12mb' }));
app.use(express.static(PUBLIC_DIR));

function isValidId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{4,32}$/.test(id);
}

function getBaseUrl(req) {
  const hostHeader = req.get('x-forwarded-host') || req.get('host') || `localhost:${PORT}`;
  const host = hostHeader.split(',')[0].trim();
  const isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(host);
  const proto = isLocal ? 'http' : 'https';
  return `${proto}://${host}`;
}

function parseImageDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') {
    return { error: 'Missing imageDataUrl.' };
  }
  const match = dataUrl.match(/^data:image\/(png|jpeg|jpg);base64,([A-Za-z0-9+/=\r\n]+)$/i);
  if (!match) {
    return { error: 'Invalid image format. Expected base64 PNG or JPEG data URL.' };
  }
  const kind = match[1].toLowerCase();
  const base64Clean = match[2].replace(/\s+/g, '');
  const buffer = Buffer.from(base64Clean, 'base64');
  if (!buffer.length) {
    return { error: 'Empty image payload.' };
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    return { error: 'Image exceeds maximum allowed size of 8 MB.' };
  }
  return {
    buffer,
    base64: base64Clean,
    mimeType: kind === 'png' ? 'image/png' : 'image/jpeg',
    ext: kind === 'png' ? 'png' : 'jpg',
  };
}

function sanitizeText(val, fallback = '', maxLen = 40) {
  if (val === null || val === undefined) return fallback;
  const s = String(val).trim().slice(0, maxLen);
  return s || fallback;
}

function sanitizeRank(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = Number(val);
  if (!Number.isFinite(n) || n < 1 || n > 999) return null;
  return Math.floor(n);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function putPhotoInMemory(record) {
  if (photoStore.has(record.id)) {
    photoStore.delete(record.id);
  }
  while (photoStore.size >= MAX_PHOTOS) {
    const oldestKey = photoStore.keys().next().value;
    if (!oldestKey) break;
    photoStore.delete(oldestKey);
  }
  photoStore.set(record.id, record);
}

function savePhoto(record) {
  putPhotoInMemory(record);
  const imgPath = path.join(PHOTO_DIR, `${record.id}.png`);
  const metaPath = path.join(PHOTO_DIR, `${record.id}.json`);
  try {
    fs.writeFileSync(imgPath, record.buffer);
    fs.writeFileSync(
      metaPath,
      JSON.stringify({
        id: record.id,
        mimeType: record.mimeType,
        playerName: record.playerName,
        finalTime: record.finalTime,
        rank: record.rank,
        createdAt: record.createdAt,
      })
    );
  } catch (err) {
    console.error('Disk photo write warning:', err.message);
  }
}

function getPhoto(id) {
  if (!isValidId(id)) return null;
  const mem = photoStore.get(id);
  if (mem) return mem;

  const imgPath = path.join(PHOTO_DIR, `${id}.png`);
  const metaPath = path.join(PHOTO_DIR, `${id}.json`);
  try {
    if (!fs.existsSync(imgPath)) return null;
    const buffer = fs.readFileSync(imgPath);
    let meta = {
      id,
      mimeType: 'image/png',
      playerName: 'PLAYER',
      finalTime: '',
      rank: null,
      createdAt: Date.now(),
    };
    if (fs.existsSync(metaPath)) {
      try {
        meta = { ...meta, ...JSON.parse(fs.readFileSync(metaPath, 'utf8')) };
      } catch {
        // Ignore malformed metadata and serve image with defaults
      }
    }
    const record = { ...meta, buffer };
    putPhotoInMemory(record);
    return record;
  } catch {
    return null;
  }
}

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/photos', async (req, res) => {
  try {
    const { imageDataUrl, playerName, finalTime, rank } = req.body || {};
    const parsed = parseImageDataUrl(imageDataUrl);
    if (parsed.error) {
      return res.status(400).json({ error: parsed.error });
    }

    let id = crypto.randomBytes(5).toString('base64url');
    while (photoStore.has(id)) {
      id = crypto.randomBytes(5).toString('base64url');
    }

    const record = {
      id,
      buffer: parsed.buffer,
      mimeType: parsed.mimeType,
      playerName: sanitizeText(playerName, 'PLAYER', 24),
      finalTime: sanitizeText(finalTime, '', 20),
      rank: sanitizeRank(rank),
      createdAt: Date.now(),
    };

    savePhoto(record);

    const baseUrl = getBaseUrl(req);
    const shareUrl = `${baseUrl}/photo/${id}`;
    const imageUrl = `${baseUrl}/api/photos/${id}/image`;
    const qrDataUrl = await QRCode.toDataURL(shareUrl, {
      width: 320,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: {
        dark: '#07152e',
        light: '#ffffff',
      },
    });

    return res.status(201).json({
      id,
      shareUrl,
      imageUrl,
      qrDataUrl,
    });
  } catch (err) {
    console.error('POST /api/photos error:', err);
    return res.status(500).json({ error: 'Failed to store photo.' });
  }
});

app.get('/api/photos/:id/image', (req, res) => {
  const record = getPhoto(req.params.id);
  if (!record) {
    return res.status(404).json({ error: 'Photo not found or expired.' });
  }
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Content-Disposition', `inline; filename="marble-rush-${record.id}.png"`);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  return res.send(record.buffer);
});

app.get('/photo/:id', (req, res) => {
  const id = req.params.id;
  const record = getPhoto(id);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (!record) {
    return res.status(404).send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Photo Not Found - Marble Rush</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;background:radial-gradient(circle at top,#0e2d61,#07152e 70%);color:#fff;font-family:'Arial Black',Arial,sans-serif;text-align:center}
    .card{width:min(94vw,460px);padding:28px 22px;border-radius:20px;background:#07152e;border:2px solid #22d3ee;box-shadow:0 0 28px rgba(34,211,238,.35)}
    h1{color:#facc15;font-size:28px;letter-spacing:1px;margin-bottom:10px}
    p{color:#bae6fd;font-family:system-ui,-apple-system,sans-serif;font-size:15px;line-height:1.5;margin-bottom:20px}
    a{display:inline-block;padding:12px 24px;border-radius:999px;background:linear-gradient(#facc15,#f59e0b);color:#07152e;text-decoration:none;font-size:15px}
  </style>
</head>
<body>
  <div class="card">
    <h1>PHOTO EXPIRED</h1>
    <p>This Marble Rush arcade photo is no longer available on the server. Take a new photo after your next run!</p>
    <a href="/">PLAY MARBLE RUSH</a>
  </div>
</body>
</html>`);
  }

  const safeId = escapeHtml(record.id);
  const safeName = escapeHtml(record.playerName || 'PLAYER');
  const safeTime = escapeHtml(record.finalTime || '');
  const safeRank = record.rank ? `#${record.rank}` : '';
  const imagePath = `/api/photos/${safeId}/image`;

  return res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <title>${safeName} - Marble Rush Photo</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{
      min-height:100vh;
      display:flex;
      flex-direction:column;
      align-items:center;
      justify-content:center;
      padding:20px 16px 32px;
      background:radial-gradient(circle at top,#0d2e66 0%,#07152e 65%,#040d1d 100%);
      color:#fff;
      font-family:Impact,'Arial Black',system-ui,sans-serif;
    }
    .wrap{
      width:min(96vw,480px);
      background:#07152e;
      border:2.5px solid #22d3ee;
      border-radius:24px;
      padding:20px 18px 22px;
      box-shadow:0 0 36px rgba(34,211,238,.35),inset 0 0 18px rgba(34,211,238,.12);
      text-align:center;
    }
    .brand{
      font-size:30px;
      letter-spacing:1.5px;
      color:#fff;
      text-shadow:0 3px 0 #0891b2;
      margin-bottom:4px;
    }
    .brand span{color:#facc15;text-shadow:0 3px 0 #a16207}
    .meta{
      display:flex;
      align-items:center;
      justify-content:center;
      gap:10px;
      flex-wrap:wrap;
      margin:8px 0 14px;
      font-family:system-ui,-apple-system,sans-serif;
      font-weight:800;
      font-size:14px;
      color:#67e8f9;
    }
    .pill{
      padding:4px 12px;
      border-radius:999px;
      background:rgba(34,211,238,.14);
      border:1px solid rgba(34,211,238,.45);
    }
    .pill.gold{
      background:rgba(250,204,21,.16);
      border-color:rgba(250,204,21,.6);
      color:#facc15;
    }
    .frame{
      background:#030b1a;
      border:2px solid #22d3ee;
      border-radius:16px;
      padding:8px;
      box-shadow:0 0 24px rgba(34,211,238,.25);
      margin-bottom:16px;
    }
    .frame img{
      display:block;
      width:100%;
      height:auto;
      border-radius:10px;
      -webkit-touch-callout:default;
    }
    .dl{
      display:block;
      width:100%;
      padding:15px 20px;
      border-radius:999px;
      background:linear-gradient(180deg,#facc15 0%,#f59e0b 100%);
      color:#07152e;
      text-decoration:none;
      font-size:22px;
      letter-spacing:1px;
      box-shadow:0 6px 20px rgba(250,204,21,.35);
    }
    .dl:active{transform:scale(.98)}
    .hint{
      margin-top:12px;
      font-family:system-ui,-apple-system,sans-serif;
      font-size:13px;
      line-height:1.45;
      color:#a5f3fc;
    }
  </style>
</head>
<body>
  <main class="wrap">
    <div class="brand">MARBLE <span>RUSH</span></div>
    <div class="meta">
      <span class="pill">${safeName}</span>
      ${safeTime ? `<span class="pill">${safeTime}</span>` : ''}
      ${safeRank ? `<span class="pill gold">TOP 10 &bull; ${safeRank}</span>` : ''}
    </div>
    <div class="frame">
      <img src="${imagePath}" alt="Marble Rush Arcade Photo for ${safeName}" />
    </div>
    <a class="dl" href="${imagePath}" download="marble-rush-${safeId}.png">DOWNLOAD PHOTO</a>
    <p class="hint">On iPhone or Android, tap <strong>DOWNLOAD PHOTO</strong> or press and hold the photo above to save it directly to your camera roll. No sign-in needed!</p>
  </main>
</body>
</html>`);
});

function buildEmailContent({ playerName, finalTime, rank, shareUrl }) {
  const safeName = escapeHtml(playerName || 'PLAYER');
  const safeTime = escapeHtml(finalTime || '--:--.--');
  const rankBadge = rank ? `<p style="margin:8px 0 0;color:#facc15;font-weight:700;font-size:16px;">TOP 10 RANK #${rank}</p>` : '';
  const validShareUrl =
    typeof shareUrl === 'string' && /^https?:\/\//i.test(shareUrl.trim()) ? shareUrl.trim() : '';

  const buttonHtml = validShareUrl
    ? `<div style="margin:24px 0 12px;">
         <a href="${escapeHtml(validShareUrl)}" style="display:inline-block;padding:14px 28px;border-radius:999px;background:#facc15;color:#07152e;font-weight:800;font-size:16px;text-decoration:none;letter-spacing:0.5px;">VIEW &amp; DOWNLOAD PHOTO</a>
       </div>`
    : '';

  const html = `
  <div style="background:#040d1d;padding:28px 16px;font-family:Arial,Helvetica,sans-serif;color:#ffffff;text-align:center;">
    <div style="max-width:520px;margin:0 auto;background:#07152e;border:2px solid #22d3ee;border-radius:20px;padding:28px 22px;">
      <h1 style="margin:0 0 6px;font-size:28px;letter-spacing:1px;color:#ffffff;">MARBLE <span style="color:#facc15;">RUSH</span></h1>
      <p style="margin:0 0 18px;color:#67e8f9;font-size:14px;">YOUR ARCADE PHOTO IS ATTACHED!</p>
      <div style="background:#0b2147;border:1px solid #22d3ee;border-radius:14px;padding:16px;margin-bottom:16px;">
        <p style="margin:0;font-size:20px;font-weight:800;color:#ffffff;">${safeName}</p>
        <p style="margin:6px 0 0;font-size:14px;color:#67e8f9;">FINAL TIME: <strong style="color:#facc15;font-size:18px;">${safeTime}</strong></p>
        ${rankBadge}
      </div>
      ${buttonHtml}
      <p style="margin:14px 0 0;font-size:13px;color:#bae6fd;line-height:1.5;">
        Your Marble Rush photo card is attached as a PNG image.${validShareUrl ? ' You can also tap the button above to open and save it on any device.' : ''}
      </p>
    </div>
  </div>`;

  const textLines = [
    'MARBLE RUSH - Your Arcade Photo',
    `Player: ${playerName || 'PLAYER'}`,
    `Final Time: ${finalTime || '--:--.--'}`,
    rank ? `Rank: Top 10 #${rank}` : null,
    validShareUrl ? `VIEW & DOWNLOAD PHOTO: ${validShareUrl}` : null,
    'Your PNG photo card is attached to this email.',
  ].filter(Boolean);

  return {
    subject: `Your Marble Rush Photo (${finalTime || 'Arcade Run'})`,
    html,
    text: textLines.join('\n'),
  };
}

app.post('/api/send-email', async (req, res) => {
  try {
    const { toEmail, imageDataUrl, playerName, finalTime, rank, shareUrl } = req.body || {};

    const cleanEmail = typeof toEmail === 'string' ? toEmail.trim() : '';
    if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(cleanEmail)) {
      return res.status(422).json({ sent: false, error: 'Please enter a valid email address.' });
    }

    const parsed = parseImageDataUrl(imageDataUrl);
    if (parsed.error) {
      return res.status(422).json({ sent: false, error: parsed.error });
    }

    const cleanName = sanitizeText(playerName, 'PLAYER', 24);
    const cleanTime = sanitizeText(finalTime, '', 20);
    const cleanRank = sanitizeRank(rank);
    const filename = `marble-rush-${cleanName.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'photo'}.${parsed.ext}`;
    const emailContent = buildEmailContent({
      playerName: cleanName,
      finalTime: cleanTime,
      rank: cleanRank,
      shareUrl,
    });

    const resendKey = (process.env.RESEND_API_KEY || '').trim();
    const emailFrom = (process.env.EMAIL_FROM || process.env.SMTP_FROM || '').trim();

    if (resendKey) {
      if (!emailFrom) {
        return res.status(422).json({
          sent: false,
          error: 'EMAIL_FROM is not configured for Resend.',
        });
      }

      const resendRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: emailFrom,
          to: [cleanEmail],
          subject: emailContent.subject,
          html: emailContent.html,
          text: emailContent.text,
          attachments: [
            {
              filename,
              content: parsed.base64,
            },
          ],
        }),
      });

      const resendRaw = await resendRes.text();
      let resendData = {};
      try {
        resendData = resendRaw ? JSON.parse(resendRaw) : {};
      } catch {
        resendData = {};
      }

      if (!resendRes.ok) {
        return res.status(422).json({
          sent: false,
          error:
            resendData.message ||
            resendData.error ||
            `Resend rejected the email (HTTP ${resendRes.status}).`,
        });
      }

      return res.json({ sent: true, provider: 'resend', id: resendData.id || null });
    }

    const smtpHost = (process.env.SMTP_HOST || '').trim();
    if (smtpHost) {
      const smtpPort = Number(process.env.SMTP_PORT || 587);
      const smtpUser = (process.env.SMTP_USER || '').trim();
      const smtpPass = process.env.SMTP_PASS || '';
      const smtpFrom = (process.env.SMTP_FROM || process.env.EMAIL_FROM || smtpUser || '').trim();

      if (!smtpFrom) {
        return res.status(422).json({
          sent: false,
          error: 'SMTP_FROM or SMTP_USER must be configured to send SMTP emails.',
        });
      }

      const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpPort === 465,
        auth: smtpUser ? { user: smtpUser, pass: smtpPass } : undefined,
      });

      await transporter.sendMail({
        from: smtpFrom,
        to: cleanEmail,
        subject: emailContent.subject,
        text: emailContent.text,
        html: emailContent.html,
        attachments: [
          {
            filename,
            content: parsed.buffer,
            contentType: parsed.mimeType,
          },
        ],
      });

      return res.json({ sent: true, provider: 'smtp' });
    }

    return res.status(422).json({
      sent: false,
      error:
        'Email is not configured on the server yet. Set RESEND_API_KEY + EMAIL_FROM or SMTP_* environment variables.',
    });
  } catch (err) {
    console.error('POST /api/send-email error:', err);
    return res.status(422).json({
      sent: false,
      error: err && err.message ? err.message : 'Unable to send email right now.',
    });
  }
});

// /api 404 JSON catch-all
app.use('/api', (_req, res) => {
  res.status(404).json({ sent: false, error: 'API endpoint not found.' });
});

// /api error middleware (ensures Express JSON parse / payload errors return JSON, not HTML)
app.use((err, req, res, next) => {
  if (req.path.startsWith('/api')) {
    const status = err && err.status === 413 ? 413 : 422;
    return res.status(status).json({
      sent: false,
      error: (err && err.message) || 'Request failed.',
    });
  }
  return next(err);
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Marble Rush server running on port ${PORT}`);
});
