// api/pair.js — Vercel Serverless Function (ESM)

import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import fs   from 'fs';
import path from 'path';
import os   from 'os';

const logger = pino({ level: 'silent' });

// Always return JSON — never let Vercel return an HTML error page
function jsonResponse(res, status, body) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.status(status).end(JSON.stringify(body));
}

export default async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') return jsonResponse(res, 200, {});
  if (req.method !== 'POST')    return jsonResponse(res, 405, { error: 'Method not allowed' });

  let phone;
  try {
    phone = (req.body?.phone || '').toString().replace(/[^0-9]/g, '');
  } catch (_) {
    return jsonResponse(res, 400, { error: 'Invalid request body' });
  }

  if (!phone || phone.length < 7) {
    return jsonResponse(res, 400, { error: 'Valid phone number required (with country code, no +)' });
  }

  const sessionDir = path.join(os.tmpdir(), `mb_${phone}_${Date.now()}`);
  fs.mkdirSync(sessionDir, { recursive: true });

  let sock;
  try {
    const { version }          = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      generateHighQualityLinkPreview: false,
      getMessage: async () => undefined,
    });

    // Wait a moment then request pair code
    await new Promise(r => setTimeout(r, 2500));
    const pairCode = await sock.requestPairingCode(phone);

    // Wait for WhatsApp to confirm the link (up to 2 min)
    const sessionId = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Timed out. You did not enter the code in time. Please try again.'));
      }, 115_000);

      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
        if (connection === 'open') {
          clearTimeout(timer);
          try {
            await saveCreds();
            // Encode all session files as a single base64 string
            const files = {};
            for (const f of fs.readdirSync(sessionDir)) {
              const fp = path.join(sessionDir, f);
              if (fs.statSync(fp).isFile()) {
                files[f] = fs.readFileSync(fp, 'utf8');
              }
            }
            resolve(Buffer.from(JSON.stringify(files)).toString('base64'));
          } catch (e) {
            reject(e);
          } finally {
            sock.end?.();
          }
        } else if (connection === 'close') {
          const code = lastDisconnect?.error?.output?.statusCode;
          if (code === DisconnectReason.loggedOut) {
            clearTimeout(timer);
            reject(new Error('WhatsApp rejected the session. Please try again.'));
          }
        }
      });
    });

    // Cleanup temp folder
    try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (_) {}

    return jsonResponse(res, 200, { success: true, pairCode, sessionId });

  } catch (err) {
    try { sock?.end?.(); } catch (_) {}
    try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (_) {}
    return jsonResponse(res, 500, { error: err.message || 'Internal server error' });
  }
}
