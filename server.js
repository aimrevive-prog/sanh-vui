'use strict';
/* ============================================================
   SẢNH VUI v2 — server multiplayer (Node.js thuần)
   · 4 game: Tài Xỉu / Xóc Đĩa / Bầu Cua / Mini Poker
   · Phòng riêng bằng mã mờit · BXH tuần · Minh bạch SHA-256
   Chạy: node server.js   (PORT, ADMIN_PASS, BET_MS, REVEAL_MS)
   ============================================================ */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
const BET_MS = +process.env.BET_MS || 25000;
const REVEAL_MS = +process.env.REVEAL_MS || 7000;
const START_BALANCE = 100000;
const MAX_BET = 50000000;
const MAX_ROOMS = 100;
const DATA = path.join(__dirname, 'data.json');

const GAMES = ['taixiu', 'xocdia', 'baucua'];
const GAME_NAME = { taixiu: 'Tài Xỉu', xocdia: 'Xóc Đĩa', baucua: 'Bầu Cua' };
const TOTAL_ODDS = { 4:50,5:25,6:15,7:10,8:6,9:5,10:5,11:5,12:5,13:6,14:10,15:15,16:25,17:50 };
const BAU = ['nai','bau','cua','tom','ca','ga'];
const BET_KEYS = {
  taixiu: new Set(['tai','xiu','chan','le','bao',
    ...Array.from({length:14},(_,i)=>'t'+(i+4)),
    ...Array.from({length:6},(_,i)=>'s'+(i+1)),
    ...Array.from({length:6},(_,i)=>'d'+(i+1)),
    ...Array.from({length:6},(_,i)=>'b'+(i+1))]),
  xocdia: new Set(['chan','le','tai','xiu','v40','v04','v31','v13']),
  baucua: new Set(BAU),
};

/* ---------------- helpers ---------------- */
const fmt = n => Math.round(n).toLocaleString('vi-VN');
function fmtS(n){
  if(n>=1e6){const v=n/1e6; return (Number.isInteger(v)?v:+v.toFixed(1))+'M';}
  if(n>=1e3){const v=n/1e3; return (Number.isInteger(v)?v:+v.toFixed(1))+'K';}
  return ''+Math.round(n);
}
function esc(s){ return String(s).replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c])); }
const shabuf = s => crypto.createHash('sha256').update(s).digest();
const dstr = d => d.getFullYear()+'-'+(d.getMonth()+1)+'-'+d.getDate();
const randHex = () => crypto.randomBytes(16).toString('hex');

/* ---------------- tuần (giờ VN UTC+7, bắt đầu thứ 2) ---------------- */
function weekCalc(ts){
  const d = new Date((ts || Date.now()) + 7*3600e3);
  const day = (d.getUTCDay() + 6) % 7; // thứ 2 = 0
  const mon = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
  const wno = Math.floor((mon - Date.UTC(d.getUTCFullYear(), 0, 1)) / 6048e5) + 1;
  return { key: d.getUTCFullYear() + '-W' + String(wno).padStart(2, '0'), end: mon + 6048e5 - 7*3600e3 };
}
const WEEK_PRIZES = [500000, 300000, 200000];

/* ---------------- persistence ---------------- */
let players = {};           // token -> player
let lobbyHist = { taixiu: [], xocdia: [], baucua: [] };
let curWeek = weekCalc().key;
let lastWeek = null;
try {
  const raw = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  players = raw.players || {};
  if (raw.histories) lobbyHist = Object.assign(lobbyHist, raw.histories);
  if (raw.week) { curWeek = raw.week.curKey || curWeek; lastWeek = raw.week.lastWeek || null; }
} catch (e) { /* first run */ }
let saveTimer = null;
function save(){
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { fs.writeFileSync(DATA, JSON.stringify({ players, histories: lobbyHist, week: { curKey: curWeek, lastWeek } })); }
    catch (e) { console.log('save error', e.message); }
  }, 1200);
}
function newStats(){ return { rounds:0, wins:0, winStreak:0, bestStreak:0, jack:0, big:0, totalWon:0 }; }
function newPlayer(name){
  const token = crypto.randomBytes(16).toString('hex');
  players[token] = {
    token, id: crypto.randomBytes(3).toString('hex'),
    name: String(name || 'Khách').slice(0, 18) || 'Khách',
    balance: START_BALANCE, stats: newStats(), missions: {},
    gift: { date: '', streak: 0 }, room: 'main', weekKey: curWeek, wonWeek: 0,
  };
  save();
  return players[token];
}
const playerById = id => Object.values(players).find(p => p.id === id);

/* ---------------- sockets ---------------- */
const ctxs = new Set();
function playerOfCtx(c){ return c.token ? players[c.token] : null; }
function isOnline(id){ for (const c of ctxs){ const p = playerOfCtx(c); if (p && p.id === id) return true; } return false; }
function onlineInRoom(code){
  const seen = new Map();
  for (const c of ctxs){ const p = playerOfCtx(c); if (p && (p.room || 'main') === code) seen.set(p.id, p); }
  return [...seen.values()];
}
const pubRoomPlayers = code => onlineInRoom(code).map(p => ({ id: p.id, name: p.name, balance: p.balance }));
function wsSend(ctx, obj){
  if (ctx.sock.destroyed) return;
  const data = Buffer.from(JSON.stringify(obj));
  const len = data.length; let head;
  if (len < 126){ head = Buffer.from([0x81, len]); }
  else if (len < 65536){ head = Buffer.alloc(4); head[0]=0x81; head[1]=126; head.writeUInt16BE(len,2); }
  else { head = Buffer.alloc(10); head[0]=0x81; head[1]=127; head.writeBigUInt64BE(BigInt(len),2); }
  try { ctx.sock.write(Buffer.concat([head, data])); } catch (e) {}
}
function bcastRoom(code, obj){ for (const c of ctxs){ const p = playerOfCtx(c); if (p && (p.room || 'main') === code) wsSend(c, obj); } }
function bcastAll(obj){ for (const c of ctxs) wsSend(c, obj); }
function sendToPlayer(id, obj){ for (const c of ctxs){ const p = playerOfCtx(c); if (p && p.id === id) wsSend(c, obj); } }
function kickPlayer(id){
  for (const c of ctxs){ const p = playerOfCtx(c); if (p && p.id === id){
    wsSend(c, { t: 'toast', kind: 'warn', msg: '👢 Bạn đã bị admin đá ra khỏi sảnh!' });
    c.token = null;
    bcastRoom(p.room || 'main', { t:'players', players: pubRoomPlayers(p.room || 'main') });
    try { c.sock.end(); } catch (e) {}
  } }
}

/* ---------------- phòng ---------------- */
const rooms = {};
function makeRoom(code, name, isLobby){
  const r = { code, name, isLobby: !!isLobby, round: 0, phase: 'bet', endsAt: Date.now() + BET_MS,
    seeds: {}, hashes: {}, outcomes: {}, feed: [], idleAt: Date.now(), bets: {}, histories: {} };
  GAMES.forEach(g => { r.bets[g] = {}; r.histories[g] = isLobby ? (lobbyHist[g] || []) : []; });
  rooms[code] = r;
  newRoundFor(r, true);
  return r;
}
function roomOf(p){ return rooms[p.room] || rooms.main; }
const ROOM_ABC = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function genCode(){
  for (let i = 0; i < 20; i++){
    let c = '';
    for (let j = 0; j < 6; j++) c += ROOM_ABC[Math.floor(Math.random() * ROOM_ABC.length)];
    if (!rooms[c]) return c;
  }
  return null;
}
function feed(r, text){
  r.feed.unshift(text); r.feed = r.feed.slice(0, 12);
  bcastRoom(r.code, { t: 'feed', text });
}

/* ---------------- BXH tuần ---------------- */
function ensureWeek(p){
  const k = weekCalc().key;
  if (p.weekKey !== k){ p.weekKey = k; p.wonWeek = 0; }
}
function addWonWeek(p, net){ ensureWeek(p); if (net > 0) p.wonWeek += net; }
function lbPayload(){
  const wk = weekCalc();
  const list = Object.values(players)
    .filter(p => p.weekKey === wk.key && p.wonWeek > 0)
    .sort((a, b) => b.wonWeek - a.wonWeek).slice(0, 20)
    .map(p => ({ id: p.id, name: p.name, won: p.wonWeek, online: isOnline(p.id) }));
  return { t: 'lb', week: wk.key, ends: wk.end, list, lastWeek };
}
function sendLbAll(){ const lb = lbPayload(); for (const code in rooms) bcastRoom(code, lb); }
setInterval(() => {  // kiểm tra sang tuần mới mỗi phút
  const k = weekCalc().key;
  if (k === curWeek) return;
  const board = Object.values(players)
    .filter(p => p.weekKey === curWeek && p.wonWeek > 0)
    .sort((a, b) => b.wonWeek - a.wonWeek).slice(0, 3);
  board.forEach((p, i) => {
    p.balance += WEEK_PRIZES[i];
    sendToPlayer(p.id, { t: 'toast', kind: 'mission', msg: `🏆 BXH tuần ${curWeek}: hạng ${i + 1}, thưởng <b>+${fmt(WEEK_PRIZES[i])}</b> xu!` });
    pushMe(p);
  });
  lastWeek = { key: curWeek, winners: board.map((p, i) => ({ name: p.name, won: p.wonWeek, prize: WEEK_PRIZES[i] })) };
  for (const p of Object.values(players)){ p.weekKey = k; p.wonWeek = 0; }
  curWeek = k;
  for (const code in rooms){
    feed(rooms[code], `🏁 <b>Tuần mới!</b> BXH đã reset — tranh top để nhận tới <b>500K</b>!` +
      (lastWeek.winners[0] ? ` 🥇 Tuần trước: <b>${esc(lastWeek.winners[0].name)}</b>` : ''));
    bcastRoom(code, { t: 'lb', ...lbPayload() });
  }
  save();
}, 60000);

/* ---------------- missions ---------------- */
const MISSIONS = [
  { id:'first', ic:'🎯', nm:'Khởi nghiệp', ds:'Chơi ván đầu tiên', rw:5000,   max:1,  get:p=>Math.min(p.stats.rounds,1) },
  { id:'r10',   ic:'🎲', nm:'Làm quen sảnh', ds:'Chơi đủ 10 ván', rw:10000,   max:10, get:p=>Math.min(p.stats.rounds,10) },
  { id:'r50',   ic:'🔥', nm:'Dân chơi chính hiệu', ds:'Chơi đủ 50 ván', rw:50000, max:50, get:p=>Math.min(p.stats.rounds,50) },
  { id:'w5',    ic:'⚡', nm:'Hổ báo', ds:'Thắng liên tiếp 5 ván', rw:25000,   max:5,  get:p=>Math.min(p.stats.winStreak,5) },
  { id:'w20',   ic:'👑', nm:'Cao thủ', ds:'Thắng tổng cộng 20 ván', rw:40000, max:20, get:p=>Math.min(p.stats.wins,20) },
  { id:'jack',  ic:'💥', nm:'Trúng Jackpot', ds:'Trúng thưởng x25 trở lên ở bất kỳ game', rw:100000, max:1, get:p=>Math.min(p.stats.jack,1) },
  { id:'big',   ic:'💰', nm:'Ăn đậm', ds:'Thắng 1 ván từ 100.000 xu', rw:60000, max:1, get:p=>Math.min(p.stats.big,1) },
  { id:'mil',   ic:'🏦', nm:'Triệu phú', ds:'Sở hữu 1.000.000 xu', rw:50000,  max:1,  get:p=>p.balance >= 1e6 ? 1 : 0 },
];
function pushMe(p){
  const r = roomOf(p);
  const bets = {};
  for (const gname of GAMES){
    const row = r.bets[gname][p.token];
    if (row){ bets[gname] = Object.assign({}, row); }
  }
  sendToPlayer(p.id, { t:'me', id:p.id, name:p.name, balance:p.balance,
    stats:p.stats, missions:p.missions, gift:giftState(p), bets, room: r.code });
}
function checkMissions(p){
  let guard = 0, again = true;
  while (again && guard++ < 8){
    again = false;
    for (const m of MISSIONS){
      if (!p.missions[m.id] && m.get(p) >= m.max){
        p.missions[m.id] = 1; p.balance += m.rw; again = true;
        sendToPlayer(p.id, { t:'toast', kind:'mission', msg:`🏆 ${m.nm}: thưởng <b>+${fmt(m.rw)}</b> xu` });
        feed(roomOf(p), `🏆 <b>${esc(p.name)}</b> hoàn thành "${m.nm}" (+${fmtS(m.rw)})`);
      }
    }
  }
}
function giftState(p){
  const today = dstr(new Date()), yest = dstr(new Date(Date.now() - 864e5));
  const avail = p.gift.date !== today;
  const day = avail ? (p.gift.date === yest ? p.gift.streak + 1 : 1) : p.gift.streak;
  return { avail, day, rw: Math.min(20000 + (day - 1) * 5000, 50000) };
}
function applyRoundStats(p, net, jack){
  p.stats.rounds++;
  if (net > 0){ p.stats.wins++; p.stats.winStreak++; p.stats.bestStreak = Math.max(p.stats.bestStreak, p.stats.winStreak); }
  else if (net < 0){ p.stats.winStreak = 0; }
  if (net > 0) p.stats.totalWon += net;
  if (jack) p.stats.jack++;
  if (net >= 100000) p.stats.big++;
  addWonWeek(p, net);
  checkMissions(p);
}

/* ---------------- bộ bài & Mini Poker ---------------- */
const PK_PAY = { royal:250, sf:50, quad:25, fh:9, flush:6, straight:4, trips:3, twopair:2, jacks:1, none:0 };
const PK_NAME = { royal:'👑 THÙNG PHÁ SẢNH HOÀNG GIA', sf:'🌟 THÙNG PHÁ SẢNH', quad:'💥 TỨ QUÝ', fh:'🏠 CÙ LŨ',
  flush:'🌈 THÙNG', straight:'⛓ SẢNH', trips:'🎯 SÁM CÔ', twopair:'✌️ HAI ĐÔI', jacks:'🃏 ĐÔI J TRỞ LÊN', none:'TRƯỢT' };
function mulberry32(a){ return function(){ a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function deckFromSeed(seed){
  const dig = shabuf(seed);
  const rnd = mulberry32((dig.readUInt32LE(0) ^ dig.readUInt32LE(8)) >>> 0);
  const deck = Array.from({ length: 52 }, (_, i) => i);
  for (let i = deck.length - 1; i > 0; i--){ const j = Math.floor(rnd() * (i + 1)); const t = deck[i]; deck[i] = deck[j]; deck[j] = t; }
  return deck;
}
const PK_RANKS = '23456789TJQKA', PK_SUITS = 'SHDC';
const cardStr = c => PK_RANKS[c % 13] + PK_SUITS[Math.floor(c / 13)];
function evalPk(cards){
  const ranks = cards.map(c => c % 13).sort((a, b) => a - b);
  const suits = new Set(cards.map(c => Math.floor(c / 13)));
  const flush = suits.size === 1;
  const uniq = [...new Set(ranks)];
  const straight = uniq.length === 5 && (uniq[4] - uniq[0] === 4 || (uniq[4] === 12 && uniq[3] === 3)); // sảnh thường hoặc A-2-3-4-5
  const cnt = {};
  ranks.forEach(r => cnt[r] = (cnt[r] || 0) + 1);
  const groups = Object.entries(cnt).map(([r, n]) => ({ r: +r, n })).sort((a, b) => b.n - a.n || b.r - a.r);
  if (flush && straight && uniq[4] === 12 && uniq[0] === 8) return 'royal';   // 10-J-Q-K-A đồng chất
  if (flush && straight) return 'sf';
  if (groups[0].n === 4) return 'quad';
  if (groups[0].n === 3 && groups[1] && groups[1].n === 2) return 'fh';
  if (flush) return 'flush';
  if (straight) return 'straight';
  if (groups[0].n === 3) return 'trips';
  if (groups[0].n === 2 && groups[1] && groups[1].n === 2) return 'twopair';
  if (groups[0].n === 2 && groups[0].r >= 9) return 'jacks'; // đôi J/Q/K/A (r: 9=J)
  return 'none';
}
const activePk = {}; // token -> {seed, deck, hash, bet, at}
setInterval(() => { // dọn ván poker bỏ dở quá 15 phút (xu coi như mất)
  const now = Date.now();
  for (const tk of Object.keys(activePk)) if (now - activePk[tk].at > 15 * 60e3) delete activePk[tk];
}, 60e3);

/* ---------------- kết quả xúc xắc / settle ---------------- */
function txMult(k, d, s, tr){
  if (k==='tai') return (!tr && s>=11) ? 1 : 0;
  if (k==='xiu') return (!tr && s<=10) ? 1 : 0;
  if (k==='chan') return (!tr && s%2===0) ? 1 : 0;
  if (k==='le') return (!tr && s%2===1) ? 1 : 0;
  if (k==='bao') return tr ? 8 : 0;
  const c = k[0], n = +k.slice(1);
  if (c==='t') return s===n ? TOTAL_ODDS[n] : 0;
  if (c==='s'){ const cnt = d.filter(x=>x===n).length; return cnt || 0; }
  if (c==='d'){ const cnt = d.filter(x=>x===n).length; return cnt>=2 ? 8 : 0; }
  if (c==='b') return (tr && d[0]===n) ? 30 : 0;
  return 0;
}
function xdMult(k, rc){
  if (k==='chan') return rc%2===0 ? 1 : 0;
  if (k==='le')   return rc%2===1 ? 1 : 0;
  if (k==='tai')  return rc>=3 ? 1 : 0;
  if (k==='xiu')  return rc<=1 ? 1 : 0;
  if (k==='v40')  return rc===4 ? 12 : 0;
  if (k==='v04')  return rc===0 ? 12 : 0;
  if (k==='v31')  return rc===3 ? 3 : 0;
  if (k==='v13')  return rc===1 ? 3 : 0;
  return 0;
}
function settleGame(r, game, out){
  const table = r.bets[game];
  for (const token of Object.keys(table)){
    const p = players[token]; if (!p) continue;
    const myBets = table[token]; let st = 0, ret = 0, jack = false;
    const lines = [];
    for (const k of Object.keys(myBets)){
      const a = myBets[k]; st += a; let m = 0;
      if (game === 'taixiu'){ const d = out.d, s = d[0]+d[1]+d[2], tr = d[0]===d[1] && d[1]===d[2];
        m = txMult(k, d, s, tr);
        if (m > 0 && (k==='t4' || k==='t17' || (k[0]==='b' && k!=='bao'))) jack = true;
      } else if (game === 'xocdia'){ const rc = out.r.reduce((x,y)=>x+y,0);
        m = xdMult(k, rc);
        if (m >= 12) jack = true;
      } else {
        m = out.d.filter(x => x === k).length;
        if (m === 3) jack = true;
      }
      if (m > 0){ const rr = a + a*m; ret += rr; lines.push({ k, m, r: rr }); }
    }
    p.balance += ret;
    const net = ret - st;
    applyRoundStats(p, net, jack);
    pushMe(p);
    sendToPlayer(p.id, { t:'myresult', game, net, st, ret, lines: lines.slice(0, 8), balance: p.balance });
    if (net >= 50000) feed(r, `🎉 <b>${esc(p.name)}</b> thắng <b>+${fmtS(net)}</b> ở ${GAME_NAME[game]}!`);
  }
  r.bets[game] = {};
}
function makeHist(game, out){
  if (game === 'taixiu'){ const d = out.d, s = d[0]+d[1]+d[2], tr = d[0]===d[1] && d[1]===d[2];
    return { s, d, bao: tr, tai: (!tr && s>=11), xiu: (!tr && s<=10) }; }
  if (game === 'xocdia'){ const rc = out.r.reduce((x,y)=>x+y,0); return { rc, r: out.r }; }
  return { d: out.d };
}

/* ---------------- round engine theo phòng ---------------- */
function newRoundFor(r, first){
  r.round++; r.phase = 'bet'; r.endsAt = Date.now() + BET_MS; r.seeds = {}; r.hashes = {};
  for (const g of GAMES){
    r.seeds[g] = randHex();
    r.hashes[g] = crypto.createHash('sha256').update(r.seeds[g]).digest('hex');
  }
  if (!first) bcastRoom(r.code, { t:'round', room: r.code, round: r.round, phase: 'bet', ends: r.endsAt, now: Date.now(), hashes: r.hashes });
}
function revealFor(r){
  r.phase = 'reveal'; r.endsAt = Date.now() + REVEAL_MS;
  r.outcomes = {};
  for (const g of GAMES){
    const dig = shabuf(r.seeds[g]);
    let out;
    if (g === 'taixiu') out = { d: [dig[0]%6+1, dig[1]%6+1, dig[2]%6+1] };
    else if (g === 'baucua') out = { d: [BAU[dig[0]%6], BAU[dig[1]%6], BAU[dig[2]%6]] };
    else out = { r: [dig[0]&1, dig[1]&1, dig[2]&1, dig[3]&1] };
    r.outcomes[g] = out;
    r.histories[g].unshift(makeHist(g, out));
    r.histories[g] = r.histories[g].slice(0, 60);
    if (r.isLobby) lobbyHist[g] = r.histories[g];
  }
  for (const g of GAMES) settleGame(r, g, r.outcomes[g]);
  save();
  bcastRoom(r.code, { t:'result', room: r.code, round: r.round, res: r.outcomes, seeds: r.seeds, now: Date.now(), ends: r.endsAt });
  bcastRoom(r.code, { t:'players', players: pubRoomPlayers(r.code) });
  bcastRoom(r.code, lbPayload());
}
function sumsOf(r){
  const sums = {};
  for (const g of GAMES){
    const agg = {};
    for (const token of Object.keys(r.bets[g]))
      for (const k of Object.keys(r.bets[g][token])) agg[k] = (agg[k] || 0) + r.bets[g][token][k];
    sums[g] = agg;
  }
  return sums;
}
function hasBets(r){ return GAMES.some(g => Object.keys(r.bets[g]).length > 0); }
makeRoom('main', 'Sảnh chính', true);
setInterval(() => {
  const now = Date.now();
  for (const code of Object.keys(rooms)){
    const r = rooms[code];
    if (r.phase === 'bet' && now >= r.endsAt) revealFor(r);
    else if (r.phase === 'reveal' && now >= r.endsAt) newRoundFor(r);
    const members = onlineInRoom(code).length;
    if (members > 0){
      r.idleAt = now;
      bcastRoom(code, { t:'tick', room: code, phase: r.phase, left: Math.max(0, Math.ceil((r.endsAt - now) / 1000)), now, sums: sumsOf(r) });
    } else if (!r.isLobby && now - r.idleAt > 30 * 60e3 && !hasBets(r)){
      delete rooms[code]; // dọn phòng trống quá 30 phút
    }
  }
}, 1000);

/* ---------------- snapshots & di chuyển phòng ---------------- */
function snapOf(r){
  return { t:'snap', room: { code: r.code, name: r.name, lobby: r.isLobby }, round: r.round, phase: r.phase,
    ends: r.endsAt, now: Date.now(), hashes: r.hashes, outcomes: r.outcomes,
    seeds: r.phase === 'reveal' ? r.seeds : null, histories: r.histories,
    players: pubRoomPlayers(r.code), feed: r.feed, lb: lbPayload() };
}
function joinRoom(ctx, p, r){
  const oldRoom = roomOf(p);
  p.room = r.code;
  wsSend(ctx, { t:'room_ok', room: { code: r.code, name: r.name, lobby: r.isLobby } });
  wsSend(ctx, snapOf(r));
  pushMe(p);
  feed(r, `👋 <b>${esc(p.name)}</b> đã vào phòng`);
  if (oldRoom !== r) bcastRoom(oldRoom.code, { t:'players', players: pubRoomPlayers(oldRoom.code) });
  bcastRoom(r.code, { t:'players', players: pubRoomPlayers(r.code) });
  save();
}

/* ---------------- xử lý message ---------------- */
function onMsg(ctx, m){
  try { m = JSON.parse(m); } catch (e) { return; }
  const t = m.t;

  if (t === 'hello'){
    if (m.token && players[m.token]){ ctx.token = m.token; }
    else { ctx.token = newPlayer(m.name).token; }
    const p = players[ctx.token];
    const r = roomOf(p);
    wsSend(ctx, { t:'welcome', token: ctx.token });
    wsSend(ctx, snapOf(r));
    pushMe(p);
    bcastRoom(r.code, { t:'players', players: pubRoomPlayers(r.code) });
    sendToPlayer(p.id, { t:'toast', kind:'', msg:`👋 Chào <b>${esc(p.name)}</b>, chúc may mắn!` });
    return;
  }
  const p = ctx.token && players[ctx.token];
  if (!p){ wsSend(ctx, { t:'needlogin' }); return; }
  const r = roomOf(p);

  if (t === 'name'){
    const nm = String(m.name || '').trim().slice(0, 18);
    if (nm){ p.name = nm; pushMe(p); bcastRoom(r.code, { t:'players', players: pubRoomPlayers(r.code) }); save(); }
    return;
  }
  if (t === 'chat'){
    const now = Date.now();
    if (ctx.chatAt && now - ctx.chatAt < 700) return;
    ctx.chatAt = now;
    const text = String(m.text || '').trim().slice(0, 200);
    if (text) bcastRoom(r.code, { t:'chat', id: p.id, name: p.name, text });
    return;
  }
  if (t === 'lb'){ wsSend(ctx, lbPayload()); return; }
  if (t === 'react'){
    const now = Date.now();
    if (ctx.reactAt && now - ctx.reactAt < 8000) return; // chống spam
    ctx.reactAt = now;
    if (m.kind === 'shake') bcastRoom(r.code, { t:'react', kind:'shake', id: p.id, name: p.name });
    return;
  }

  /* ---------- phòng ---------- */
  if (t === 'room_create'){
    if (Object.keys(rooms).length >= MAX_ROOMS){ wsSend(ctx, { t:'toast', kind:'warn', msg:'Server đang đầy phòng, thử lại sau nhé!' }); return; }
    const code = genCode();
    if (!code){ wsSend(ctx, { t:'toast', kind:'warn', msg:'Không tạo được mã phòng, thử lại!' }); return; }
    const name = String(m.name || 'Phòng của ' + p.name).slice(0, 24) || 'Phòng riêng';
    const nr = makeRoom(code, name, false);
    joinRoom(ctx, p, nr);
    sendToPlayer(p.id, { t:'toast', kind:'mission', msg:`🏠 Đã tạo phòng <b>${esc(name)}</b> — mã mờit: <b>${code}</b>. Gửi mã cho bạn bè để cùng chơi!` });
    return;
  }
  if (t === 'room_join'){
    const code = String(m.code || '').trim().toUpperCase();
    if (!rooms[code]){ wsSend(ctx, { t:'toast', kind:'warn', msg:'❌ Mã phòng không đúng hoặc phòng đã đóng!' }); return; }
    joinRoom(ctx, p, rooms[code]);
    return;
  }
  if (t === 'room_leave'){ joinRoom(ctx, p, rooms.main); return; }

  /* ---------- cược xúc xắc ---------- */
  if (t === 'bet'){
    if (r.phase !== 'bet'){ wsSend(ctx, { t:'toast', kind:'warn', msg:'⏳ Hết giờ đặt cược rồi!' }); return; }
    const game = m.game, key = m.key;
    if (!BET_KEYS[game] || !BET_KEYS[game].has(key)) return;
    let amount = Math.floor(+m.amount);
    if (!Number.isFinite(amount) || amount <= 0) return;
    amount = Math.min(amount, MAX_BET, p.balance);
    if (amount <= 0){ wsSend(ctx, { t:'toast', kind:'warn', msg:'Không đủ xu! 😅' }); return; }
    p.balance -= amount;
    const table = r.bets[game];
    table[ctx.token] = table[ctx.token] || {};
    table[ctx.token][key] = (table[ctx.token][key] || 0) + amount;
    pushMe(p);
    return;
  }
  if (t === 'clear'){
    const game = m.game;
    if (r.phase !== 'bet' || !BET_KEYS[game]) return;
    const mine = r.bets[game][ctx.token];
    if (mine){
      let refund = 0;
      for (const k of Object.keys(mine)) refund += mine[k];
      p.balance += refund;
      delete r.bets[game][ctx.token];
      pushMe(p);
    }
    return;
  }
  if (t === 'gift'){
    const g = giftState(p);
    if (!g.avail){ wsSend(ctx, { t:'toast', kind:'warn', msg:'Hôm nay bạn nhận rồi, mai quay lại nhé! ⏰' }); return; }
    p.gift = { date: dstr(new Date()), streak: g.day };
    p.balance += g.rw;
    sendToPlayer(p.id, { t:'toast', kind:'mission', msg:`🎁 Điểm danh ngày ${g.day}: +${fmt(g.rw)} xu!` });
    checkMissions(p); pushMe(p); save();
    return;
  }
  if (t === 'bail'){
    if (p.balance >= 1000){ wsSend(ctx, { t:'toast', kind:'warn', msg:'Bạn vẫn còn xu mà 😄' }); return; }
    p.balance += 10000;
    sendToPlayer(p.id, { t:'toast', kind:'mission', msg:'🆘 Cứu trợ khẩn cấp: +10.000 xu!' });
    checkMissions(p); pushMe(p); save();
    return;
  }

  /* ---------- Mini Poker ---------- */
  if (t === 'pk_start'){
    let bet = Math.floor(+m.bet);
    if (!Number.isFinite(bet)) return;
    bet = Math.min(Math.max(bet, 1000), MAX_BET);
    if (activePk[ctx.token]){ wsSend(ctx, { t:'toast', kind:'warn', msg:'Bạn đang có ván bài dở — đổi bài hoặc hủy đã!' }); return; }
    if (bet > p.balance){ wsSend(ctx, { t:'toast', kind:'warn', msg:'Không đủ xu! 😅' }); return; }
    p.balance -= bet;
    const seed = randHex();
    const hash = crypto.createHash('sha256').update(seed).digest('hex');
    const deck = deckFromSeed(seed);
    activePk[ctx.token] = { seed, deck, hash, bet, at: Date.now() };
    pushMe(p);
    wsSend(ctx, { t:'pk_deal', bet, hash, cards: deck.slice(0, 5).map(cardStr) });
    return;
  }
  if (t === 'pk_draw'){
    const hand = activePk[ctx.token];
    if (!hand){ wsSend(ctx, { t:'toast', kind:'warn', msg:'Không có ván bài nào!' }); return; }
    const holds = Array.isArray(m.holds) ? m.holds.slice(0, 5).map(Boolean) : [t,t,t,t,t].map(Boolean);
    let di = 5;
    const final = hand.deck.slice(0, 5).map((c, i) => holds[i] ? c : hand.deck[di++]);
    const rank = evalPk(final);
    const mult = PK_PAY[rank];
    const payout = hand.bet * mult;
    const net = payout - hand.bet;
    p.balance += payout;
    applyRoundStats(p, net, mult >= 25);
    pushMe(p);
    if (mult >= 9 || net >= 100000)
      feed(r, `🃏 <b>${esc(p.name)}</b> trúng <b>${PK_NAME[rank]}</b> (+${fmtS(net)} xu) game Poker!`);
    wsSend(ctx, { t:'pk_result', cards: final.map(cardStr), rank, rankName: PK_NAME[rank], mult, payout, net, seed: hand.seed, balance: p.balance });
    delete activePk[ctx.token];
    save();
    return;
  }
  if (t === 'pk_cancel'){
    const hand = activePk[ctx.token];
    if (hand){ p.balance += hand.bet; delete activePk[ctx.token]; pushMe(p); wsSend(ctx, { t:'toast', kind:'', msg:'Đã hủy ván bài, hoàn xu ✔' }); }
    return;
  }

  /* ---------- admin ---------- */
  if (t === 'admin'){
    if (m.pass === ADMIN_PASS){ ctx.admin = true; wsSend(ctx, { t:'admin_ok' }); wsSend(ctx, { t:'admin_players', players: pubAllPlayers() }); }
    else {
      ctx.tries = (ctx.tries || 0) + 1;
      wsSend(ctx, { t:'admin_fail' });
      if (ctx.tries >= 5){ try { ctx.sock.end(); } catch (e) {} }
    }
    return;
  }
  if (t === 'admin_list' && ctx.admin){ wsSend(ctx, { t:'admin_players', players: pubAllPlayers() }); return; }
  if (t === 'admin_gift' && ctx.admin){
    let amount = Math.floor(+m.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1e9) return;
    const target = m.target === '*' ? Object.values(players) : [playerById(m.target)].filter(Boolean);
    for (const tp of target){
      tp.balance += amount;
      sendToPlayer(tp.id, { t:'toast', kind:'mission', msg:`🎁 Admin tặng bạn <b>+${fmt(amount)}</b> xu!` });
      checkMissions(tp); pushMe(tp);
    }
    for (const c2 of Object.keys(rooms)){
      feed(rooms[c2], `🎁 Admin tặng <b>${fmtS(amount)}</b> xu cho ${m.target === '*' ? '<b>toàn sảnh</b>' : '<b>' + esc(target[0].name) + '</b>'}!`);
      bcastRoom(c2, { t:'players', players: pubRoomPlayers(c2) });
    }
    save();
    wsSend(ctx, { t:'admin_players', players: pubAllPlayers() });
    return;
  }
  if (t === 'admin_bc' && ctx.admin){
    const text = String(m.text || '').trim().slice(0, 200);
    if (text){
      bcastAll({ t:'chat', sys: true, text: '📢 ADMIN: ' + text });
      bcastAll({ t:'toast', kind:'mission', msg:'📢 ' + esc(text) });
    }
    return;
  }
  if (t === 'admin_kick' && ctx.admin){
    const tp = playerById(m.target);
    if (tp){
      kickPlayer(tp.id);
      for (const c2 of Object.keys(rooms)) feed(rooms[c2], `👢 Admin kick <b>${esc(tp.name)}</b>`);
      bcastRoom(r.code, { t:'players', players: pubRoomPlayers(r.code) });
      wsSend(ctx, { t:'admin_players', players: pubAllPlayers() });
    }
    return;
  }
  if (t === 'admin_backup' && ctx.admin){
    wsSend(ctx, { t:'backup', data: { players, histories: lobbyHist, week: { curKey: curWeek, lastWeek }, savedAt: Date.now(), version: 2 } });
    return;
  }
  if (t === 'admin_restore' && ctx.admin){
    const d = m.data;
    if (d && typeof d === 'object' && d.players && typeof d.players === 'object'){
      players = d.players;
      if (d.histories) lobbyHist = Object.assign({ taixiu: [], xocdia: [], baucua: [] }, d.histories);
      if (d.week){ curWeek = d.week.curKey || curWeek; lastWeek = d.week.lastWeek || null; }
      let n = 0;
      for (const tk of Object.keys(players)){
        const q = players[tk];
        if (!q || typeof q !== 'object' || !q.id || !q.name){ delete players[tk]; continue; }
        q.token = tk;
        q.balance = Math.max(0, Math.floor(+q.balance || 0));
        if (!q.stats) q.stats = newStats();
        if (!q.missions) q.missions = {};
        if (!q.gift) q.gift = { date:'', streak:0 };
        if (!q.room) q.room = 'main';
        if (q.weekKey !== curWeek){ q.weekKey = curWeek; q.wonWeek = 0; }
        n++;
      }
      save();
      bcastAll({ t:'toast', kind:'mission', msg:`♻️ Admin vừa khôi phục dữ liệu sảnh (<b>${n}</b> ngường chơi)!` });
      wsSend(ctx, { t:'admin_players', players: pubAllPlayers() });
    }
    return;
  }
}
function pubAllPlayers(){
  return Object.values(players).map(p => ({ id: p.id, name: p.name, balance: p.balance, online: isOnline(p.id), room: p.room || 'main' }));
}

/* ---------------- WebSocket framing (không thư viện) ---------------- */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function processBuf(ctx){
  let buf = ctx.buf;
  for (;;){
    if (buf.length < 2) break;
    const b0 = buf[0], b1 = buf[1];
    const fin = !!(b0 & 0x80), op = b0 & 0x0f, masked = !!(b1 & 0x80);
    let len = b1 & 0x7f, off = 2;
    if (len === 126){ if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127){ if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    if (len > 1 << 20){ try { ctx.sock.end(); } catch (e) {} return; }
    let mask = null;
    if (masked){ if (buf.length < off + 4) break; mask = buf.slice(off, off + 4); off += 4; }
    if (buf.length < off + len) break;
    let payload = buf.slice(off, off + len);
    if (mask){ const un = Buffer.alloc(len); for (let i = 0; i < len; i++) un[i] = payload[i] ^ mask[i & 3]; payload = un; }
    buf = buf.slice(off + len);
    if (op === 8){ try { ctx.sock.end(); } catch (e) {} return; }
    else if (op === 9){ try { ctx.sock.write(Buffer.concat([Buffer.from([0x8A, payload.length]), payload])); } catch (e) {} }
    else if (op === 10){ /* pong */ }
    else if (op === 1 || op === 0){
      ctx.frag = ctx.frag ? Buffer.concat([ctx.frag, payload]) : payload;
      if (fin){ const text = ctx.frag.toString('utf8'); ctx.frag = null; onMsg(ctx, text); }
    }
  }
  ctx.buf = buf;
}

/* ---------------- HTTP + WS server ---------------- */
const server = http.createServer((req, res) => {
  let f = decodeURIComponent((req.url || '/').split('?')[0]);
  if (f === '/') f = '/index.html';
  if (f === '/health'){ res.writeHead(200); res.end('ok'); return; }
  const p = path.normalize(path.join(__dirname, 'public', f));
  if (!p.startsWith(path.join(__dirname, 'public'))){ res.writeHead(403); res.end(); return; }
  fs.readFile(p, (err, buf) => {
    if (err){ res.writeHead(404); res.end('404'); return; }
    const ext = path.extname(p);
    const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
    res.end(buf);
  });
});
server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key){ sock.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  const ctx = { sock, buf: Buffer.alloc(0), frag: null, token: null, admin: false, tries: 0, chatAt: 0, reactAt: 0 };
  ctxs.add(ctx);
  sock.on('data', d => { ctx.buf = Buffer.concat([ctx.buf, d]); processBuf(ctx); });
  const bye = () => {
    const p = playerOfCtx(ctx);
    ctxs.delete(ctx);
    if (p) bcastRoom(p.room || 'main', { t:'players', players: pubRoomPlayers(p.room || 'main') });
  };
  sock.on('close', bye); sock.on('error', bye); sock.on('end', bye);
});
process.on('uncaughtException', e => console.error('uncaught:', e.message));
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎰 SẢNH VUI v2 tại http://0.0.0.0:${PORT} · ván ${BET_MS/1000}s/${REVEAL_MS/1000}s · tuần ${curWeek}`);
});
