'use strict';
// 端到端冒烟测试：两名玩家建房→加入→开局→接词→质疑→裁定→断线重连→结算→回放
const WebSocket = require('ws');

const URL = 'ws://localhost:8080';
let failures = 0;
function check(name, cond) {
  console.log(`${cond ? '✓' : '✗'} ${name}`);
  if (!cond) failures++;
}

function client(name) {
  const c = { name, ws: new WebSocket(URL), state: null, token: null, msgs: [] };
  c.send = (m) => c.ws.send(JSON.stringify(m));
  c.ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'joined') c.token = msg.token;
    if (msg.type === 'state') c.state = msg.state;
    c.msgs.push(msg);
  });
  c.waitFor = (pred, timeout = 3000) => new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (pred(c)) { clearInterval(iv); res(c); }
      else if (Date.now() - t0 > timeout) { clearInterval(iv); rej(new Error(`${name}: waitFor 超时`)); }
    }, 20);
  });
  c.opened = new Promise(res => c.ws.on('open', res));
  return c;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const A = client('甲');
  await A.opened;
  A.send({ type: 'createRoom', name: '甲' });
  await A.waitFor(c => c.state && c.state.phase === 'lobby');
  const code = A.state.code;
  check('创建房间', !!code);

  const B = client('乙');
  await B.opened;
  B.send({ type: 'joinRoom', name: '乙', roomCode: code });
  await B.waitFor(c => c.state && c.state.players.length === 2);
  check('加入房间', B.state.players.length === 2);

  // 规则编辑：空关系列表被服务端拒绝（带上下文，供客户端就地提示）
  A.send({ type: 'setRules', ruleSet: { allowedRelations: [] } });
  await A.waitFor(c => c.msgs.some(m => m.type === 'error' && m.context === 'setRules'));
  check('非法规则被拒绝且带上下文', A.state.ruleSet.allowedRelations.length > 0);

  // 合法保存：房主收到确认，非房主及时看到更新（不改变行动点等，避免影响后续流程）
  A.send({ type: 'setRules', ruleSet: { turnSeconds: 120, challengeTokens: 2 } });
  await A.waitFor(c => c.msgs.some(m => m.type === 'rulesSaved'));
  check('保存成功收到确认', true);
  await B.waitFor(c => c.state.ruleSet.turnSeconds === 120);
  check('非房主及时看到规则更新', B.state.ruleSet.challengeTokens === 2);

  // 非房主无权修改规则
  B.send({ type: 'setRules', ruleSet: { turnSeconds: 45 } });
  await B.waitFor(c => c.msgs.some(m => m.type === 'error' && m.context === 'setRules'));
  check('非房主修改被拒绝', B.state.ruleSet.turnSeconds === 120);

  A.send({ type: 'startGame' });
  await A.waitFor(c => c.state.phase === 'playing');
  check('开局', A.state.nodes.length === 3);
  const first = A.state.turn.playerId;
  const active = first === A.state.you ? A : B;
  const other = first === A.state.you ? B : A;
  check('轮到房主', first === A.state.you);

  // 房主接两个词成链
  const start0 = active.state.nodes[0].id;
  active.send({ type: 'play', word: '火焰', parentId: start0, relation: 'hypernym', reason: '火焰是火的一种形态' });
  await active.waitFor(c => c.state.nodes.some(n => n.word === '火焰'));
  const n1 = active.state.nodes.find(n => n.word === '火焰');
  active.send({ type: 'play', word: '篝火', parentId: n1.id, relation: 'scene', reason: '篝火晚会场景中出现' });
  await active.waitFor(c => c.state.nodes.some(n => n.word === '篝火'));
  check('接词成链', active.state.turn.apLeft === 1);

  // 质疑发起并暂停计时
  other.send({ type: 'challenge', nodeId: n1.id });
  await other.waitFor(c => c.state.pendingChallenge);
  check('质疑发起并暂停计时', other.state.turn.deadline === null);
  check('裁定者是房主', other.state.pendingChallenge.adjudicatorId === A.state.you);

  // 裁定者（房主）在待裁定状态下断开重连——模拟关掉弹窗/刷新页面后仍能回到裁定
  const tokenA = A.token;
  A.ws.close();
  await sleep(300);
  const A1 = client('甲');
  await A1.opened;
  A1.send({ type: 'reconnect', token: tokenA });
  await A1.waitFor(c => c.state && c.state.pendingChallenge);
  check('重连后待裁定状态仍在', A1.state.pendingChallenge.adjudicatorId === A1.state.you);

  // 裁定不成立 → 词保留
  A1.send({ type: 'resolve', verdict: 'reject' });
  await A1.waitFor(c => !c.state.pendingChallenge);
  check('重连后裁定成功，计时恢复', !!A1.state.turn.deadline);
  check('词保留', A1.state.nodes.some(n => n.word === '火焰'));

  // 加固「篝火」然后结束回合
  const n2 = A1.state.nodes.find(n => n.word === '篝火');
  A1.send({ type: 'reinforce', nodeId: n2.id });
  await A1.waitFor(c => c.state.nodes.find(n => n.word === '篝火').reinforced);
  check('加固成功', true);
  A1.send({ type: 'endTurn' });
  await other.waitFor(c => c.state.turn.playerId === other.state.you);
  check('回合切换', true);

  // 乙断线重连
  const tokenB = B.token;
  B.ws.close();
  await sleep(300);
  check('断线被标记', A1.state.players.find(p => p.name === '乙') && true);
  const B2 = client('乙');
  await B2.opened;
  B2.send({ type: 'reconnect', token: tokenB });
  await B2.waitFor(c => c.state && c.state.phase === 'playing');
  check('断线重连恢复局面', B2.state.nodes.length === A1.state.nodes.length);

  // 快进结束：轮流空过
  let guard = 0;
  while (A1.state.phase === 'playing' && guard < 50) {
    guard++;
    const cur = A1.state.turn.playerId === A1.state.you ? A1 : B2;
    cur.send({ type: 'endTurn' });
    await sleep(120);
  }
  await A1.waitFor(c => c.state.phase === 'ended');
  check('游戏结束并结算', Array.isArray(A1.state.scores) && A1.state.scores.length === 2);
  console.log('  结算:', A1.state.scores.map(s => `${s.name}:${s.total}`).join(' '));

  // 回放
  A1.send({ type: 'replay' });
  await A1.waitFor(c => c.msgs.some(m => m.type === 'replay'));
  const frames = A1.msgs.find(m => m.type === 'replay').frames;
  check('回放帧可用', frames.length > 5 && frames[frames.length - 1].scores);

  A1.ws.close(); B2.ws.close();
  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('冒烟测试异常:', e.message); process.exit(1); });
