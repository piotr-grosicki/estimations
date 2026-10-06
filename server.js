// estimations: planning poker with no backend state. This process serves the static page and relays
// WebSocket messages between the sockets of one room; it never reads, stores or logs what they carry.
// The only thing it knows is which sockets are open right now, in memory.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

const PORT = 8000;
const PUBLIC = path.join(import.meta.dirname, 'public');
const ROOM_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_PER_ROOM = 60;
const MAX_MESSAGE = 16 * 1024;
const MAX_PER_10S = 200; // a client that floods is cut off; normal play sends a handful

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const files = new Map();
for (const name of fs.readdirSync(PUBLIC)) {
  files.set('/' + name, { body: fs.readFileSync(path.join(PUBLIC, name)), type: TYPES[path.extname(name)] || 'application/octet-stream' });
}

const HEADERS = {
  'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  let file = files.get(url.pathname);
  if (url.pathname === '/' || /^\/rooms\/[^/]+$/.test(url.pathname)) file = files.get('/index.html');
  if (!file || (req.method !== 'GET' && req.method !== 'HEAD')) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('not found');
  }
  res.writeHead(200, { ...HEADERS, 'Content-Type': file.type, 'Cache-Control': 'no-cache' });
  res.end(file.body);
});

const rooms = new Map(); // roomId -> Map(connId -> socket)
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });

server.on('upgrade', (req, socket, head) => {
  const m = /^\/ws\/([^/?]+)/.exec(req.url);
  const roomId = m && m[1].toLowerCase();
  if (!roomId || !ROOM_RE.test(roomId) || (rooms.get(roomId)?.size ?? 0) >= MAX_PER_ROOM) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => join(ws, roomId));
});

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(msg);
}

function join(ws, roomId) {
  const connId = crypto.randomUUID();
  let room = rooms.get(roomId);
  if (!room) rooms.set(roomId, (room = new Map()));

  send(ws, JSON.stringify({ t: 'welcome', connId, peers: [...room.keys()] }));
  const joined = JSON.stringify({ t: 'peer-join', connId });
  for (const peer of room.values()) send(peer, joined);
  room.set(connId, ws);

  ws.alive = true;
  ws.on('pong', () => (ws.alive = true));

  let windowStart = Date.now();
  let count = 0;
  ws.on('message', (data, isBinary) => {
    if (Date.now() - windowStart > 10_000) {
      windowStart = Date.now();
      count = 0;
    }
    if (++count > MAX_PER_10S) return ws.terminate();
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    // The relay stamps the sender so no client can speak for another connection.
    const to = typeof msg.to === 'string' ? msg.to : null;
    msg.from = connId;
    delete msg.to;
    const out = JSON.stringify(msg);
    if (to) {
      const target = room.get(to);
      if (target) send(target, out);
    } else {
      for (const [id, peer] of room) if (id !== connId) send(peer, out);
    }
  });

  ws.on('close', () => {
    room.delete(connId);
    if (room.size === 0) rooms.delete(roomId);
    const left = JSON.stringify({ t: 'peer-leave', connId });
    for (const peer of room.values()) send(peer, left);
  });
  ws.on('error', () => ws.terminate());
}

// Pings keep idle sockets alive through Cloudflare (it drops them after 100 s of silence) and clear out
// sockets whose browser vanished without a close.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) {
      ws.terminate();
      continue;
    }
    ws.alive = false;
    ws.ping();
  }
}, 25_000);

server.listen(PORT, () => console.log(`estimations listening on ${PORT}`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0));
