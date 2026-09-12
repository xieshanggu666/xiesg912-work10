'use strict';
// 词语领地服务器：HTTP 静态文件 + WebSocket 实时同步 + 磁盘持久化。
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const game = require('./game');

const PORT = process.env.PORT || 8080;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'rooms.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- 房间存储 ----------

/** rooms: Map<code, room>; tokens: Map<token, {roomCode, playerId}> */
const rooms = new Map();
const tokens = new Map();
/** sockets: Map<playerId, Set<ws>> */
const sockets = new Map();

function loadRooms() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const room of raw.rooms) {
      rooms.set(room.code, room);
      // 重启后回合计时重新挂上
      if (room.phase === 'playing' && room.turn) {
        if (room.turn.deadline) {
          room.turn.deadline = Date.now() + room.ruleSet.turnSeconds * 1000;
        } else if (room.turn.pausedRemaining == null) {
          room.turn.deadline = Date.now() + room.ruleSet.turnSeconds * 1000;
        }
        scheduleTurnTimer(room);
      }
    }
    for (const [token, ref] of Object.entries(raw.tokens)) tokens.set(token, ref);
    console.log(`已恢复 ${rooms.size} 个房间`);
  } catch { /* 首次启动或数据损坏，忽略 */ }
}

let saveTimer = null;
function saveRooms() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const data = {
        rooms: [...rooms.values()],
        tokens: Object.fromEntries(tokens),
      };
      fs.writeFileSync(DATA_FILE, JSON.stringify(data));
    } catch (e) { console.error('保存失败', e); }
  }, 300);
}

// ---------- 广播 ----------

function broadcast(room) {
  for (const p of room.players) {
    const set = sockets.get(p.id);
    if (!set) continue;
    const view = JSON.stringify({ type: 'state', state: game.publicView(room, p.id) });
    for (const ws of set) if (ws.readyState === 1) ws.send(view);
  }
  saveRooms();
}

function sendTo(playerId, msg) {
  const set = sockets.get(playerId);
  if (!set) return;
  const s = JSON.stringify(msg);
  for (const ws of set) if (ws.readyState === 1) ws.send(s);
}

// ---------- 回合计时 ----------

const turnTimers = new Map();
function scheduleTurnTimer(room) {
  clearTimeout(turnTimers.get(room.code));
  if (room.phase !== 'playing' || !room.turn || !room.turn.deadline) return;
  const delay = Math.max(0, room.turn.deadline - Date.now());
  turnTimers.set(room.code, setTimeout(() => {
    if (room.phase !== 'playing' || !room.turn) return;
    const err = game.endTurn(room, room.turn.playerId, { auto: true });
    if (!err) { scheduleTurnTimer(room); broadcast(room); }
  }, delay + 50));
}

// ---------- 消息处理 ----------

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[crypto.randomInt(chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function issueToken(roomCode, playerId) {
  const token = crypto.randomBytes(16).toString('hex');
  tokens.set(token, { roomCode, playerId });
  return token;
}

function attachSocket(playerId, ws) {
  if (!sockets.has(playerId)) sockets.set(playerId, new Set());
  sockets.get(playerId).add(ws);
}

function detachSocket(playerId, ws) {
  const set = sockets.get(playerId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) {
    sockets.delete(playerId);
    // 标记断线并广播；若待裁定质疑的裁定者掉线，移交裁定权
    for (const room of rooms.values()) {
      const p = room.players.find(x => x.id === playerId);
      if (p && p.connected) {
        p.connected = false;
        game.ensureAdjudicatorOnline(room);
        broadcast(room);
      }
    }
  }
}

const handlers = {
  createRoom(ws, ctx, msg) {
    const code = makeRoomCode();
    const playerId = crypto.randomBytes(8).toString('hex');
    const room = game.newRoom(code, playerId, msg.name);
    game.addPlayer(room, playerId, msg.name);
    if (msg.ruleSet) game.setRuleSet(room, playerId, msg.ruleSet);
    rooms.set(code, room);
    const token = issueToken(code, playerId);
    ctx.playerId = playerId; ctx.roomCode = code;
    attachSocket(playerId, ws);
    ws.send(JSON.stringify({ type: 'joined', token, roomCode: code, playerId }));
    broadcast(room);
  },

  joinRoom(ws, ctx, msg) {
    const room = rooms.get(String(msg.roomCode || '').toUpperCase());
    if (!room) return sendErr(ws, '房间不存在，请检查房间码');
    const playerId = crypto.randomBytes(8).toString('hex');
    const err = game.addPlayer(room, playerId, msg.name);
    if (err) return sendErr(ws, err);
    const token = issueToken(room.code, playerId);
    ctx.playerId = playerId; ctx.roomCode = room.code;
    attachSocket(playerId, ws);
    ws.send(JSON.stringify({ type: 'joined', token, roomCode: room.code, playerId }));
    broadcast(room);
  },

  // 断线重连：凭 token 恢复身份
  reconnect(ws, ctx, msg) {
    const ref = tokens.get(msg.token);
    if (!ref) return sendErr(ws, '会话已失效，请重新加入');
    const room = rooms.get(ref.roomCode);
    if (!room) return sendErr(ws, '房间已不存在');
    const p = room.players.find(x => x.id === ref.playerId);
    if (!p) return sendErr(ws, '你不在该房间中');
    p.connected = true;
    ctx.playerId = ref.playerId; ctx.roomCode = room.code;
    attachSocket(ref.playerId, ws);
    ws.send(JSON.stringify({ type: 'joined', token: msg.token,
      roomCode: room.code, playerId: ref.playerId }));
    broadcast(room);
  },

  setRules(ws, ctx, msg) {
    const room = ctxRoom(ctx);
    if (!room) return;
    const err = game.setRuleSet(room, ctx.playerId, msg.ruleSet || {});
    if (err) return sendErr(ws, err);
    broadcast(room);
  },

  startGame(ws, ctx) {
    const room = ctxRoom(ctx);
    if (!room) return;
    const err = game.startGame(room, ctx.playerId);
    if (err) return sendErr(ws, err);
    scheduleTurnTimer(room);
    broadcast(room);
  },

  play(ws, ctx, msg) {
    const room = ctxRoom(ctx);
    if (!room) return;
    const err = game.playWord(room, ctx.playerId, msg);
    if (err) return sendErr(ws, err);
    broadcast(room);
  },

  reinforce(ws, ctx, msg) {
    const room = ctxRoom(ctx);
    if (!room) return;
    const err = game.reinforce(room, ctx.playerId, msg.nodeId);
    if (err) return sendErr(ws, err);
    broadcast(room);
  },

  endTurn(ws, ctx) {
    const room = ctxRoom(ctx);
    if (!room) return;
    const err = game.endTurn(room, ctx.playerId);
    if (err) return sendErr(ws, err);
    scheduleTurnTimer(room);
    broadcast(room);
  },

  challenge(ws, ctx, msg) {
    const room = ctxRoom(ctx);
    if (!room) return;
    const err = game.challenge(room, ctx.playerId, msg.nodeId);
    if (err) return sendErr(ws, err);
    clearTimeout(turnTimers.get(room.code)); // 计时已暂停
    broadcast(room);
  },

  resolve(ws, ctx, msg) {
    const room = ctxRoom(ctx);
    if (!room) return;
    const err = game.resolveChallenge(room, ctx.playerId, msg.verdict);
    if (err) return sendErr(ws, err);
    scheduleTurnTimer(room); // 恢复计时
    broadcast(room);
  },

  replay(ws, ctx) {
    const room = ctxRoom(ctx);
    if (!room) return;
    if (room.phase !== 'ended') return sendErr(ws, '游戏结束后才能回放');
    sendTo(ctx.playerId, { type: 'replay', frames: game.buildReplay(room) });
  },
};

function ctxRoom(ctx) {
  const room = rooms.get(ctx.roomCode);
  if (!room) return null;
  return room;
}

function sendErr(ws, message) {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'error', message }));
}

// ---------- HTTP + WS ----------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(p).replace(/^([/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  const ctx = { playerId: null, roomCode: null };
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const h = handlers[msg.type];
    if (h) {
      try { h(ws, ctx, msg); }
      catch (e) { console.error(e); sendErr(ws, '服务器开小差了，请重试'); }
    }
  });
  ws.on('close', () => { if (ctx.playerId) detachSocket(ctx.playerId, ws); });
});

loadRooms();
server.listen(PORT, () => {
  console.log(`词语领地服务器已启动: http://localhost:${PORT}`);
});
