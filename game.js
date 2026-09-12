'use strict';
// 词语领地 —— 纯逻辑状态机。服务端与测试共用，不做任何 IO。

const RELATION_TYPES = [
  { id: 'synonym',  name: '同义/近义',   example: '快乐 → 开心' },
  { id: 'antonym',  name: '反义/对立',   example: '白天 → 黑夜' },
  { id: 'hypernym', name: '上下位',      example: '苹果 → 水果' },
  { id: 'part',     name: '部分-整体',   example: '轮子 → 汽车' },
  { id: 'cause',    name: '因果',        example: '下雨 → 路滑' },
  { id: 'tool',     name: '工具-用途',   example: '钥匙 → 开锁' },
  { id: 'scene',    name: '场景共现',    example: '沙滩 → 贝壳' },
  { id: 'derive',   name: '词形/谐音衍生', example: '猫 → 猫腻' },
];

const START_WORD_POOL = [
  '火', '海', '时间', '桥', '镜子', '种子', '风', '地图',
  '灯', '雨', '山', '钥匙', '歌', '路', '梦', '石头',
];

const DEFAULT_RULESET = {
  allowedRelations: RELATION_TYPES.map(r => r.id),
  allowProperNouns: false,   // 是否允许专有名词（人名/地名/品牌）
  minReasonLen: 4,           // 关系解释最少字数（服务端可校验）
  turnSeconds: 90,
  apPerTurn: 3,
  rounds: 4,                 // 每名玩家的回合数
  startWordCount: 3,
  challengeTokens: 3,        // 每人整局的质疑次数
};

const PLAYER_COLORS = ['#e0533d', '#2e86de', '#27ae60', '#8e44ad', '#d4a017', '#16a085'];

let uidCounter = 0;
function uid(prefix) {
  uidCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${uidCounter}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

// ---------- 房间与玩家 ----------

function newRoom(code, hostId, hostName) {
  return {
    code,
    hostId,
    phase: 'lobby', // lobby | playing | ended
    ruleSet: { ...DEFAULT_RULESET },
    players: [],    // {id,name,color,connected,tokensLeft}
    startWords: [],
    nodes: [],      // {id,word,ownerId,parentId,relation,reason,reinforced,turnCreated,survivedAsRoot}
    log: [],        // 回放事件日志
    turn: null,     // {playerId,turnNumber,apLeft,deadline,pausedRemaining}
    pendingChallenge: null, // {id,nodeId,challengerId,adjudicatorId}
    winner: null,
    createdAt: Date.now(),
  };
}

function addPlayer(room, id, name) {
  if (room.players.length >= 6) return '房间已满（最多 6 人）';
  if (room.phase !== 'lobby') return '游戏已开始，无法加入';
  const color = PLAYER_COLORS[room.players.length % PLAYER_COLORS.length];
  room.players.push({
    id, name: String(name || '玩家').slice(0, 12), color,
    connected: true, tokensLeft: room.ruleSet.challengeTokens,
  });
  logEvent(room, 'join', { playerId: id, name });
  return null;
}

function setRuleSet(room, playerId, patch) {
  if (playerId !== room.hostId) return '只有房主可以修改规则';
  if (room.phase !== 'lobby') return '游戏开始后不能修改规则';
  const r = room.ruleSet;
  if (Array.isArray(patch.allowedRelations)) {
    const valid = patch.allowedRelations.filter(x => RELATION_TYPES.some(t => t.id === x));
    if (valid.length === 0) return '至少保留一种关系类型';
    r.allowedRelations = valid;
  }
  if (typeof patch.allowProperNouns === 'boolean') r.allowProperNouns = patch.allowProperNouns;
  if (Number.isInteger(patch.minReasonLen)) r.minReasonLen = clamp(patch.minReasonLen, 0, 50);
  if (Number.isInteger(patch.turnSeconds)) r.turnSeconds = clamp(patch.turnSeconds, 30, 300);
  if (Number.isInteger(patch.apPerTurn)) r.apPerTurn = clamp(patch.apPerTurn, 1, 6);
  if (Number.isInteger(patch.rounds)) r.rounds = clamp(patch.rounds, 1, 10);
  if (Number.isInteger(patch.challengeTokens)) r.challengeTokens = clamp(patch.challengeTokens, 0, 9);
  logEvent(room, 'rules', { ruleSet: r });
  return null;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ---------- 开局 ----------

function startGame(room, playerId, rng = Math.random) {
  if (playerId !== room.hostId) return '只有房主可以开始游戏';
  if (room.phase !== 'lobby') return '游戏已开始';
  if (room.players.length < 2) return '至少需要 2 名玩家';
  const pool = [...START_WORD_POOL];
  room.startWords = [];
  for (let i = 0; i < room.ruleSet.startWordCount; i++) {
    const idx = Math.floor(rng() * pool.length);
    room.startWords.push(pool.splice(idx, 1)[0]);
  }
  room.nodes = room.startWords.map((w, i) => ({
    id: `start${i}`, word: w, ownerId: null, parentId: null,
    relation: null, reason: '起始词', reinforced: true, turnCreated: 0,
  }));
  room.players.forEach(p => { p.tokensLeft = room.ruleSet.challengeTokens; });
  room.phase = 'playing';
  logEvent(room, 'start', { startWords: room.startWords, ruleSet: room.ruleSet,
    order: room.players.map(p => p.id) });
  beginTurn(room, 0);
  return null;
}

function beginTurn(room, playerIdx) {
  const player = room.players[playerIdx];
  room.turn = {
    playerId: player.id,
    turnNumber: (room.turn ? room.turn.turnNumber : 0) + 1,
    apLeft: room.ruleSet.apPerTurn,
    deadline: Date.now() + room.ruleSet.turnSeconds * 1000,
    pausedRemaining: null,
  };
  logEvent(room, 'turn', { playerId: player.id, turnNumber: room.turn.turnNumber,
    apLeft: room.turn.apLeft });
}

// ---------- 行动 ----------

function isActivePlayer(room, playerId) {
  return room.phase === 'playing' && room.turn && room.turn.playerId === playerId;
}

function playWord(room, playerId, { word, parentId, relation, reason }) {
  if (!isActivePlayer(room, playerId)) return '还没轮到你';
  if (room.pendingChallenge) return '有质疑正在裁定，请稍候';
  if (room.turn.apLeft < 1) return '行动点不足';
  word = String(word || '').trim();
  reason = String(reason || '').trim();
  if (!word || word.length > 12) return '词语需为 1~12 个字';
  if (/\s/.test(word)) return '词语中不能有空格';
  if (room.nodes.some(n => n.word === word)) return '这个词已经在场上了';
  const parent = room.nodes.find(n => n.id === parentId);
  if (!parent) return '要连接的词不存在';
  if (!room.ruleSet.allowedRelations.includes(relation)) return '该关系类型不在本局规则内';
  if (reason.length < room.ruleSet.minReasonLen) {
    return `解释至少需要 ${room.ruleSet.minReasonLen} 个字`;
  }
  const node = {
    id: uid('w'), word, ownerId: playerId, parentId,
    relation, reason, reinforced: false, turnCreated: room.turn.turnNumber,
  };
  room.nodes.push(node);
  room.turn.apLeft -= 1;
  logEvent(room, 'play', { node: { ...node }, apLeft: room.turn.apLeft });
  return null;
}

function reinforce(room, playerId, nodeId) {
  if (!isActivePlayer(room, playerId)) return '还没轮到你';
  if (room.pendingChallenge) return '有质疑正在裁定，请稍候';
  if (room.turn.apLeft < 1) return '行动点不足';
  const node = room.nodes.find(n => n.id === nodeId);
  if (!node) return '目标词不存在';
  if (node.ownerId !== playerId) return '只能加固自己的词';
  if (!node.parentId) return '起始词无需加固';
  if (node.reinforced) return '这条连接已经加固过了';
  node.reinforced = true;
  room.turn.apLeft -= 1;
  logEvent(room, 'reinforce', { nodeId, playerId, apLeft: room.turn.apLeft });
  return null;
}

function endTurn(room, playerId, { auto = false } = {}) {
  if (!isActivePlayer(room, playerId)) return '还没轮到你';
  if (room.pendingChallenge) return '有质疑正在裁定';
  logEvent(room, 'endTurn', { playerId, auto });
  advanceTurn(room);
  return null;
}

function advanceTurn(room) {
  const idx = room.players.findIndex(p => p.id === room.turn.playerId);
  const totalTurns = room.players.length * room.ruleSet.rounds;
  if (room.turn.turnNumber >= totalTurns) {
    finishGame(room);
    return;
  }
  beginTurn(room, (idx + 1) % room.players.length);
}

function finishGame(room) {
  room.phase = 'ended';
  room.turn = null;
  const scores = computeScores(room);
  const best = Math.max(...scores.map(s => s.total));
  const winners = scores.filter(s => s.total === best).map(s => s.playerId);
  room.winner = winners.length === 1 ? winners[0] : null; // 平局则无唯一胜者
  logEvent(room, 'end', { scores, winner: room.winner });
}

// ---------- 质疑与裁定 ----------

function challenge(room, playerId, nodeId) {
  if (room.phase !== 'playing') return '游戏未在进行中';
  if (room.pendingChallenge) return '已有质疑正在裁定';
  if (isActivePlayer(room, playerId)) return '自己的回合不能发起质疑';
  const player = room.players.find(p => p.id === playerId);
  if (!player) return '你不在房间中';
  if (player.tokensLeft <= 0) return '你的质疑次数已用完';
  const node = room.nodes.find(n => n.id === nodeId);
  if (!node || !node.ownerId) return '只能质疑玩家接出的词';
  if (node.ownerId === playerId) return '不能质疑自己的词';
  if (node.reinforced) return '加固过的连接免疫质疑';
  // 裁定者：房主；若涉及房主自己的词，则顺延给既不是词主也不是质疑者的玩家；
  // 两人局没有第三人时，仍由房主裁定（朋友局靠自觉）
  let adjudicator = room.hostId;
  if (node.ownerId === room.hostId) {
    const other = room.players.find(p => p.id !== node.ownerId && p.id !== playerId);
    if (other) adjudicator = other.id;
  }
  player.tokensLeft -= 1;
  room.pendingChallenge = {
    id: uid('c'), nodeId, challengerId: playerId, adjudicatorId: adjudicator,
  };
  // 暂停回合计时
  if (room.turn && room.turn.deadline) {
    room.turn.pausedRemaining = Math.max(0, room.turn.deadline - Date.now());
    room.turn.deadline = null;
  }
  logEvent(room, 'challenge', { challengeId: room.pendingChallenge.id, nodeId,
    challengerId: playerId, adjudicatorId: adjudicator, tokensLeft: player.tokensLeft });
  return null;
}

function resolveChallenge(room, playerId, verdict) {
  const ch = room.pendingChallenge;
  if (!ch) return '没有待裁定的质疑';
  if (ch.adjudicatorId !== playerId) return '只有裁定者可以判定';
  if (verdict !== 'uphold' && verdict !== 'reject') return '无效的裁定';
  const node = room.nodes.find(n => n.id === ch.nodeId);
  const removed = [];
  if (verdict === 'uphold' && node) {
    // 连接不成立：移除该词；未加固的下游级联移除，加固过的下游成为新根
    cascadeRemove(room, node.id, removed);
  }
  room.pendingChallenge = null;
  if (room.turn && room.turn.pausedRemaining != null) {
    room.turn.deadline = Date.now() + room.turn.pausedRemaining;
    room.turn.pausedRemaining = null;
  }
  logEvent(room, 'resolve', { challengeId: ch.id, verdict,
    removed: removed.map(n => n.id) });
  return null;
}

function cascadeRemove(room, nodeId, removed) {
  const node = room.nodes.find(n => n.id === nodeId);
  if (!node) return;
  removed.push(node);
  room.nodes = room.nodes.filter(n => n.id !== nodeId);
  for (const child of room.nodes.filter(n => n.parentId === nodeId)) {
    if (child.reinforced) {
      child.parentId = null; // 加固连接撑住了，成为新的领地根
      child.survivedAsRoot = true;
    } else {
      cascadeRemove(room, child.id, removed);
    }
  }
}

// 裁定者掉线时，把裁定权移交给在线的合格玩家，避免对局卡死
function ensureAdjudicatorOnline(room) {
  const ch = room.pendingChallenge;
  if (!ch) return false;
  const adj = room.players.find(p => p.id === ch.adjudicatorId);
  if (adj && adj.connected) return false;
  const node = room.nodes.find(n => n.id === ch.nodeId);
  const candidate = room.players.find(p =>
    p.connected && p.id !== ch.challengerId && (!node || p.id !== node.ownerId));
  if (!candidate) return false;
  ch.adjudicatorId = candidate.id;
  logEvent(room, 'adjudicator', { challengeId: ch.id, adjudicatorId: candidate.id });
  return true;
}

// ---------- 计分 ----------

function depthOf(room, node) {
  // 深度 = 向上追溯到根经过的玩家词数；中立的起始词不计入
  let d = 0, cur = node, guard = 0;
  while (cur.parentId && guard < 1000) {
    const parent = room.nodes.find(n => n.id === cur.parentId);
    if (!parent || parent.ownerId === null) break;
    d += 1; cur = parent; guard += 1;
  }
  return d;
}

function computeScores(room) {
  return room.players.map(p => {
    const mine = room.nodes.filter(n => n.ownerId === p.id);
    let total = 0, longest = 0;
    for (const n of mine) {
      const depth = depthOf(room, n);
      total += 1 + depth;                 // 越深（链越长）的词分越高
      if (n.reinforced && n.parentId) total += 1; // 加固奖励
      longest = Math.max(longest, depth + 1);
    }
    total += longest * 2;                 // 最长链奖励
    return { playerId: p.id, name: p.name, color: p.color,
      words: mine.length, longestChain: longest, total };
  }).sort((a, b) => b.total - a.total);
}

// ---------- 日志 / 回放 ----------

function logEvent(room, type, data) {
  room.log.push({ seq: room.log.length + 1, t: Date.now(), type, ...data });
}

// 由事件日志重建每一步的盘面快照，供回放使用
function buildReplay(room) {
  const frames = [];
  const snap = { nodes: [], turn: null, scores: null };
  const clone = o => JSON.parse(JSON.stringify(o));
  frames.push({ label: '房间创建', nodes: [], turn: null });
  for (const ev of room.log) {
    let label = null;
    switch (ev.type) {
      case 'start':
        snap.nodes = ev.startWords.map((w, i) => ({ id: `start${i}`, word: w,
          ownerId: null, parentId: null, reinforced: true, relation: null, reason: '起始词' }));
        label = `开局，起始词：${ev.startWords.join('、')}`;
        break;
      case 'turn':
        snap.turn = { playerId: ev.playerId, turnNumber: ev.turnNumber };
        label = `第 ${ev.turnNumber} 回合开始`;
        break;
      case 'play':
        snap.nodes.push(clone(ev.node));
        label = `接出「${ev.node.word}」`;
        break;
      case 'reinforce': {
        const n = snap.nodes.find(x => x.id === ev.nodeId);
        if (n) n.reinforced = true;
        label = '加固了一条连接';
        break;
      }
      case 'challenge':
        label = '发起质疑';
        break;
      case 'resolve':
        if (ev.removed && ev.removed.length) {
          snap.nodes = snap.nodes.filter(n => !ev.removed.includes(n.id));
          // 级联后幸存子节点成为根
          for (const n of snap.nodes) {
            if (n.parentId && !snap.nodes.some(p => p.id === n.parentId)) n.parentId = null;
          }
        }
        label = ev.verdict === 'uphold' ? '质疑成立，连接被拆除' : '质疑不成立，连接保留';
        break;
      case 'end':
        snap.scores = ev.scores;
        label = '游戏结束，结算';
        break;
      default:
        break;
    }
    if (label) frames.push({ label, nodes: clone(snap.nodes), turn: clone(snap.turn),
      scores: snap.scores ? clone(snap.scores) : null });
  }
  return frames;
}

// 发给客户端的个性化视图（目前所有信息都是公开的，直接整体发）
function publicView(room, forPlayerId) {
  return {
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    you: forPlayerId,
    ruleSet: room.ruleSet,
    players: room.players.map(p => ({ id: p.id, name: p.name, color: p.color,
      connected: p.connected, tokensLeft: p.tokensLeft })),
    startWords: room.startWords,
    nodes: room.nodes,
    turn: room.turn,
    pendingChallenge: room.pendingChallenge,
    winner: room.winner,
    scores: room.phase === 'ended' ? computeScores(room) : null,
    relationTypes: RELATION_TYPES,
  };
}

module.exports = {
  RELATION_TYPES, DEFAULT_RULESET, START_WORD_POOL,
  newRoom, addPlayer, setRuleSet, startGame,
  playWord, reinforce, endTurn, challenge, resolveChallenge, ensureAdjudicatorOnline,
  computeScores, buildReplay, publicView, cascadeRemove,
};
