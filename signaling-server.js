const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Store active connections
const peers = new Map();

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// REST API to get peer list
app.get('/api/peers', (req, res) => {
    const peerList = Array.from(peers.keys()).map(id => ({
        id,
        timestamp: peers.get(id).timestamp
    }));
    res.json(peerList);
});

// WebSocket connection handling
wss.on('connection', (ws) => {
    const peerId = generatePeerId();
    const peerInfo = {
        ws,
        timestamp: Date.now(),
        connectedTo: new Set()
    };

    peers.set(peerId, peerInfo);

    console.log(`Peer connected: ${peerId}. Total peers: ${peers.size}`);

    // Send peer ID to client
    ws.send(JSON.stringify({
        type: 'peerId',
        data: peerId
    }));

    // Handle incoming messages
    ws.on('message', (message) => {
        try {
            const messageStr = message instanceof ArrayBuffer 
                ? Buffer.from(message).toString('utf-8')
                : message.toString('utf-8');
            const msg = JSON.parse(messageStr);
            handleSignalingMessage(msg, peerId);
        } catch (err) {
            console.error('Failed to parse message:', err);
        }
    });

    // Handle disconnection
    ws.on('close', () => {
        peers.delete(peerId);

        // Notify connected peers about disconnection
        peerInfo.connectedTo.forEach(targetId => {
            const targetPeer = peers.get(targetId);
            if (targetPeer && targetPeer.ws.readyState === WebSocket.OPEN) {
                targetPeer.ws.send(JSON.stringify({
                    type: 'peerDisconnected',
                    data: { peerId }
                }));
            }
        });

        console.log(`Peer disconnected: ${peerId}. Total peers: ${peers.size}`);
    });

    ws.on('error', (err) => {
        console.error(`WebSocket error for peer ${peerId}:`, err);
    });
});

function handleSignalingMessage(msg, fromPeerId) {
    const { type, to, data } = msg;

    switch (type) {
        case 'offer':
        case 'answer':
        case 'iceCandidate':
            // Forward to target peer
            if (to && peers.has(to)) {
                const targetPeer = peers.get(to);
                if (targetPeer.ws.readyState === WebSocket.OPEN) {
                    targetPeer.ws.send(JSON.stringify({
                        type,
                        from: fromPeerId,
                        data
                    }));

                    // Track connection
                    peers.get(fromPeerId).connectedTo.add(to);
                    targetPeer.connectedTo.add(fromPeerId);
                }
            }
            break;

        case 'getPeers':
            // Send list of available peers (excluding self)
            const peerList = Array.from(peers.keys())
                .filter(id => id !== fromPeerId)
                .map(id => ({
                    id,
                    timestamp: peers.get(id).timestamp
                }));

            const fromPeer = peers.get(fromPeerId);
            if (fromPeer && fromPeer.ws.readyState === WebSocket.OPEN) {
                fromPeer.ws.send(JSON.stringify({
                    type: 'peerList',
                    data: peerList
                }));
            }
            break;

        default:
            console.warn(`Unknown message type: ${type}`);
    }
}

function generatePeerId() {
    return `peer-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Signaling server running on ws://localhost:${PORT}`);
});
