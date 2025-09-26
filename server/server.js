// server/server.js

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 8080;

// 1. Create a standard HTTP server
const server = http.createServer((req, res) => {
    // This serves your index.html file
    const filePath = path.join(__dirname, '..', 'client', 'index.html');
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(500);
            return res.end('Error loading index.html');
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data);
    });
});

// 2. Attach the WebSocket server to the HTTP server
const wss = new WebSocketServer({ server });

console.log(`Server started on port ${PORT}`);

// --- All game logic below is identical to the previous version ---
let waitingPlayer = null;
const gameSessions = {};
const GRID_SIZE = 20;
const CANVAS_WIDTH = 400;
const POWERUP_COOLDOWN = 30000;

function sendMessage(ws, type, payload) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, payload })); }
function getSerializableState(session) {
    const now = Date.now();
    return {
        snakes: session.players.map(p => ({ id: p.id, segments: p.snake })),
        food: session.food,
        powerups: session.players.map(p => ({
            id: p.id,
            grow_self: { isReady: (now - p.powerups.grow_self.lastUsed) >= POWERUP_COOLDOWN, cooldownRemaining: Math.max(0, (POWERUP_COOLDOWN - (now - p.powerups.grow_self.lastUsed)) / 1000) },
            shrink_opponent: { isReady: (now - p.powerups.shrink_opponent.lastUsed) >= POWERUP_COOLDOWN, cooldownRemaining: Math.max(0, (POWERUP_COOLDOWN - (now - p.powerups.shrink_opponent.lastUsed)) / 1000) }
        }))
    };
}
function createGameSession(player1, player2) {
    const gameId = uuidv4();
    const startTime = Date.now();
    const session = {
        players: [
            { id: 1, ws: player1, snake: [{ x: 100, y: 100 }], dx: GRID_SIZE, dy: 0, powerups: { grow_self: { lastUsed: startTime }, shrink_opponent: { lastUsed: startTime } } },
            { id: 2, ws: player2, snake: [{ x: 300, y: 300 }], dx: -GRID_SIZE, dy: 0, powerups: { grow_self: { lastUsed: startTime }, shrink_opponent: { lastUsed: startTime } } }
        ],
        food: createFood(), isGameOver: false, gameId: gameId
    };
    gameSessions[gameId] = session;
    const initialStatePayload = getSerializableState(session);
    sendMessage(player1, 'game_start', { player_id: 1, state: initialStatePayload });
    sendMessage(player2, 'game_start', { player_id: 2, state: initialStatePayload });
    const gameInterval = setInterval(() => {
        const currentSession = gameSessions[gameId];
        if (!currentSession || currentSession.isGameOver) { clearInterval(gameInterval); return; }
        updateGameState(currentSession);
        broadcastGameState(currentSession);
    }, 1000 / 8);
    session.interval = gameInterval;
}
function createFood() { return { x: Math.floor(Math.random() * (CANVAS_WIDTH / GRID_SIZE)) * GRID_SIZE, y: Math.floor(Math.random() * (CANVAS_WIDTH / GRID_SIZE)) * GRID_SIZE }; }
function updateGameState(session) {
    session.players.forEach(player => {
        const head = { x: player.snake[0].x + player.dx, y: player.snake[0].y + player.dy };
        player.snake.unshift(head);
        if (head.x === session.food.x && head.y === session.food.y) { session.food = createFood(); } else { player.snake.pop(); }
        const opponent = session.players.find(p => p.id !== player.id);
        const hitWall = head.x < 0 || head.x >= CANVAS_WIDTH || head.y < 0 || head.y >= CANVAS_WIDTH;
        let hitSelf = player.snake.slice(1).some(segment => segment.x === head.x && segment.y === head.y);
        let hitOpponent = opponent.snake.some(segment => segment.x === head.x && segment.y === head.y);
        if (hitWall || hitSelf || hitOpponent) {
            session.isGameOver = true;
            const winnerId = opponent.id;
            sendMessage(player.ws, 'game_over', { winner_id: winnerId });
            sendMessage(opponent.ws, 'game_over', { winner_id: winnerId });
            clearInterval(session.interval);
            delete gameSessions[session.gameId];
        }
    });
}
function broadcastGameState(session) { const stateToSend = getSerializableState(session); session.players.forEach(player => sendMessage(player.ws, 'game_update', stateToSend)); }
function handlePowerup(ws, payload) {
    const now = Date.now();
    for (const gameId in gameSessions) {
        const session = gameSessions[gameId];
        const player = session.players.find(p => p.ws === ws);
        if (player) {
            const powerup = player.powerups[payload.type];
            if (powerup && (now - powerup.lastUsed) >= POWERUP_COOLDOWN) {
                const opponent = session.players.find(p => p.id !== player.id);
                if (payload.type === 'grow_self') { const tail = player.snake[player.snake.length - 1]; player.snake.push({ ...tail }); } 
                else if (payload.type === 'shrink_opponent') { if (opponent.snake.length > 2) opponent.snake.pop(); }
                powerup.lastUsed = now;
            }
            break;
        }
    }
}
wss.on('connection', (ws) => {
    console.log('Client connected.');
    ws.on('message', (message) => {
        try {
            const { type, payload } = JSON.parse(message);
            if (type === 'join_game') { if (waitingPlayer) { createGameSession(waitingPlayer, ws); waitingPlayer = null; } else { waitingPlayer = ws; sendMessage(ws, 'game_wait', {}); } }
            if (type === 'player_move') {
                for (const gameId in gameSessions) {
                    const player = gameSessions[gameId].players.find(p => p.ws === ws);
                    if (player) {
                        const { dx, dy } = player;
                        if (payload.direction === 'up' && dy === 0) { player.dx = 0; player.dy = -GRID_SIZE; }
                        if (payload.direction === 'down' && dy === 0) { player.dx = 0; player.dy = GRID_SIZE; }
                        if (payload.direction === 'left' && dx === 0) { player.dx = -GRID_SIZE; player.dy = 0; }
                        if (payload.direction === 'right' && dx === 0) { player.dx = GRID_SIZE; player.dy = 0; }
                        break;
                    }
                }
            }
            if (type === 'use_powerup') { handlePowerup(ws, payload); }
        } catch (error) { console.error("Failed to handle message:", error); }
    });
    ws.on('close', () => { console.log('Client disconnected.'); if (ws === waitingPlayer) waitingPlayer = null; });
    ws.on('error', (error) => console.error('WebSocket error:', error));
});

// 3. Start the HTTP server
server.listen(PORT, () => {
    console.log(`HTTP server listening on port ${PORT}`);
});