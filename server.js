const WebSocket = require('ws');
const QRCode = require('qrcode');
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, exec } = require('child_process');

const HTTP_PORT = 8080;
const WS_PORT = 8765;
const TOKEN = Math.random().toString(36).slice(2, 10);

function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

const IP = getLocalIP();
// QR points to LOCAL HTTP server so Safari can connect via ws:// (no mixed content)
const QR_URL = `http://${IP}:${HTTP_PORT}?behost=${IP}&beport=${WS_PORT}&betoken=${TOKEN}`;

// ── HTTP server: serves Knightfall files to the iPhone ──
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

const httpServer = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  const filePath = path.join(__dirname, urlPath === '/' ? 'index.html' : urlPath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
});

httpServer.listen(HTTP_PORT, () => {
  console.log(`[HTTP] Serving Knightfall at http://${IP}:${HTTP_PORT}`);
});

// ── WebSocket server ──
const wss = new WebSocket.Server({ port: WS_PORT });

// Generate QR code as HTML and open in browser
QRCode.toDataURL(QR_URL, { width: 300, margin: 2 }, (err, dataUrl) => {
  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Brother Eye — Scan to Connect</title>
<style>
  body{background:#0a0a0a;color:#f0f0f0;font-family:system-ui;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center}
  h1{color:#F2C412;font-size:22px;margin-bottom:4px}
  p{color:#888;font-size:14px;margin-bottom:20px}
  img{border-radius:12px;border:4px solid #F2C412}
  .note{margin-top:16px;font-size:13px;color:#888;max-width:320px;line-height:1.5}
  .status{margin-top:14px;color:#30D158;font-size:13px}
</style>
</head>
<body>
  <h1>◉ Brother Eye</h1>
  <p>Scan with your iPhone Camera app<br>(both devices must be on the same WiFi)</p>
  <img src="${dataUrl}" width="260" height="260">
  <div class="note">Point your iPhone camera at this QR — it will open Knightfall and connect automatically.</div>
  <div class="status">Server running on ${IP} — waiting for connection…</div>
</body>
</html>`;

  const qrFile = path.join(__dirname, 'brother-eye-qr.html');
  fs.writeFileSync(qrFile, html);
  exec(`start "" "${qrFile}"`);

  console.log('\n╔══════════════════════════════════╗');
  console.log('║      BROTHER EYE SERVER          ║');
  console.log('╚══════════════════════════════════╝');
  console.log('');
  console.log('QR code opened in browser. Scan it with iPhone Camera.');
  console.log(`\nOR paste this into Brother Eye manually:`);
  console.log(`ws://${IP}:${WS_PORT}?token=${TOKEN}`);
  console.log('\nWaiting for connection...\n');
});

wss.on('connection', (ws, req) => {
  const urlParams = new URLSearchParams(req.url.replace('/?', '').replace('/', ''));
  if (urlParams.get('token') !== TOKEN) {
    ws.send(JSON.stringify({ type: 'error', text: 'Invalid token' }));
    ws.close();
    return;
  }

  console.log('✓ Brother Eye connected from iPhone!\n');
  ws.send(JSON.stringify({ type: 'status', text: 'Connected to your Lenovo. Claude Code is ready.' }));

  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    if (msg.type === 'prompt') {
      console.log(`[Brother Eye] → ${msg.text}`);
      ws.send(JSON.stringify({ type: 'thinking' }));

      const claude = spawn('claude', ['-p', msg.text, '--output-format', 'text'], {
        shell: true,
        cwd: process.cwd(),
      });

      let output = '';
      let errorOut = '';

      claude.stdout.on('data', (d) => { output += d.toString(); });
      claude.stderr.on('data', (d) => { errorOut += d.toString(); });

      claude.on('close', () => {
        const reply = output.trim() || errorOut.trim() || 'No response from Claude Code.';
        console.log(`[Claude Code] → ${reply.slice(0, 100)}...\n`);
        ws.send(JSON.stringify({ type: 'response', text: reply }));
      });

      claude.on('error', (err) => {
        ws.send(JSON.stringify({ type: 'response', text: `Error running Claude Code: ${err.message}` }));
      });
    }
  });

  ws.on('close', () => { console.log('Brother Eye disconnected.\n'); });
});

wss.on('error', (err) => { console.error('Server error:', err.message); });

process.on('SIGINT', () => {
  console.log('\nShutting down Brother Eye server...');
  process.exit(0);
});
