// signaling-server.js (room-aware)
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

const peers = new Map(); // peerId -> { ws, roomId, timestamp }
const rooms = new Map(); // roomId -> Set(peerId)

function generatePeerId() {
  return `peer-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

wss.on('connection', (ws) => {
  const peerId = generatePeerId();
  peers.set(peerId, { ws, roomId: null, timestamp: Date.now() });

  console.log('Peer connected', peerId);
  // send peerId immediately
  ws.send(JSON.stringify({ type: 'peerId', data: peerId }));

  ws.on('message', (data) => {
    let msg;
    try {
      const str = data instanceof Buffer ? data.toString('utf8') : data;
      msg = JSON.parse(str);
    } catch (e) {
      console.error('Invalid JSON', e);
      return;
    }
    handleMessage(peerId, msg);
  });

  ws.on('close', () => {
    handleDisconnect(peerId);
  });

  ws.on('error', (err) => {
    console.error('WS error', peerId, err);
    handleDisconnect(peerId);
  });
});

function handleMessage(from, msg) {
  const { type, roomId, to, data } = msg;
  switch (type) {
    case 'joinRoom':
      joinRoom(from, roomId);
      break;
    case 'leaveRoom':
      leaveRoom(from);
      break;
    case 'getRoomPeers':
      sendRoomPeers(from);
      break;
    case 'offer':
    case 'answer':
    case 'iceCandidate':
      forwardToPeer(from, to, { type, from, data });
      break;
    default:
      console.warn('Unknown msg type', type);
  }
}

function joinRoom(peerId, roomId) {
  const p = peers.get(peerId);
  if (!p) return;
  // leave previous room
  if (p.roomId) leaveRoom(peerId);

  p.roomId = roomId;
  p.timestamp = Date.now();
  if (!rooms.has(roomId)) rooms.set(roomId, new Set());
  rooms.get(roomId).add(peerId);

  // notify other members
  for (const otherId of rooms.get(roomId)) {
    if (otherId === peerId) continue;
    const other = peers.get(otherId);
    if (other && other.ws.readyState === WebSocket.OPEN) {
      other.ws.send(JSON.stringify({ type: 'peerJoined', data: { peerId } }));
    }
  }

  // reply with full peer list (including existing)
  sendRoomPeers(peerId);
  console.log(`peer ${peerId} joined room ${roomId}. members=${rooms.get(roomId).size}`);
}

function leaveRoom(peerId) {
  const p = peers.get(peerId);
  if (!p || !p.roomId) return;
  const roomId = p.roomId;
  const s = rooms.get(roomId);
  if (s) s.delete(peerId);
  p.roomId = null;

  // notify remaining members
  if (s) {
    for (const otherId of s) {
      const other = peers.get(otherId);
      if (other && other.ws.readyState === WebSocket.OPEN) {
        other.ws.send(JSON.stringify({ type: 'peerLeft', data: { peerId } }));
      }
    }
    if (s.size === 0) rooms.delete(roomId);
  }
  console.log(`peer ${peerId} left room ${roomId}`);
}

function sendRoomPeers(peerId) {
  const p = peers.get(peerId);
  if (!p) return;
  const roomId = p.roomId;
  const list = [];
  if (roomId && rooms.has(roomId)) {
    for (const id of rooms.get(roomId)) {
      if (id !== peerId) {
        list.push({ id, timestamp: peers.get(id).timestamp });
      }
    }
  }
  const ws = p.ws;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'roomPeers', data: list }));
  }
}

function forwardToPeer(from, to, payload) {
  const target = peers.get(to);
  if (target && target.ws && target.ws.readyState === WebSocket.OPEN) {
    target.ws.send(JSON.stringify(payload));
  } else {
    console.warn('Cannot forward to', to);
  }
}

function handleDisconnect(peerId) {
  const p = peers.get(peerId);
  if (!p) return;
  // Remove from room
  if (p.roomId) {
    const roomSet = rooms.get(p.roomId);
    if (roomSet) {
      roomSet.delete(peerId);
      // notify rest
      for (const otherId of roomSet) {
        const other = peers.get(otherId);
        if (other && other.ws.readyState === WebSocket.OPEN) {
          other.ws.send(JSON.stringify({ type: 'peerLeft', data: { peerId } }));
        }
      }
      if (roomSet.size === 0) rooms.delete(p.roomId);
    }
  }
  peers.delete(peerId);
  console.log('Peer disconnected', peerId);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Signaling server (rooms) listening on ${PORT}`));
