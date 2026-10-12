const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const QUESTIONS = require('./questions');

const os = require('os');
const PORT = process.env.PORT || 3000;
function lanIps() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
}
// إن فُتح الموقع بعنوان localhost نستبدله بعنوان الشبكة المحلية ليعمل من الهواتف
function reachableBase(origin) {
  try {
    const u = new URL(origin);
    if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname)) {
      const ip = lanIps()[0];
      if (ip) u.hostname = ip;
    }
    return u.origin;
  } catch { const ip = lanIps()[0]; return ip ? `http://${ip}:${PORT}` : ''; }
}
const DURATIONS = [10, 15, 20, 30];
const MAX_PLAYERS = 200;
const ROOM_TTL_MS = 3 * 60 * 60 * 1000;
const RESULTS_FILE = path.join(__dirname, '..', 'data', 'results.json');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/health', (_, res) => res.send('ok'));

const rooms = new Map();
const rid = () => crypto.randomBytes(12).toString('hex');
const sanitize = (s) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim();

function newPin() {
  let pin;
  do { pin = String(crypto.randomInt(100000, 1000000)); } while (rooms.has(pin));
  return pin;
}

// معدّل محدود لكل اتصال
function limiter(socket, max = 30, perMs = 5000) {
  const now = Date.now();
  socket.data.hits = (socket.data.hits || []).filter((t) => now - t < perMs);
  socket.data.hits.push(now);
  return socket.data.hits.length <= max;
}

// ---------- الترتيب والنقاط ----------
// score = round(1000 × (0.5 + 0.5 × remaining / total))   (للإجابة الصحيحة فقط)
function calcScore(remainingMs, totalMs) {
  const r = Math.min(Math.max(remainingMs, 0), totalMs);
  return Math.round(1000 * (0.5 + 0.5 * (r / totalMs)));
}
// ترتيب: النقاط ↓ ثم عدد الإجابات الصحيحة ↓ ثم مجموع زمن الإجابات الصحيحة ↑
function ranked(room) {
  const list = [...room.players.values()].map((p) => ({
    id: p.id, name: p.name, score: p.score, correct: p.correct, time: p.timeMs, connected: p.connected, bot: !!p.bot,
  }));
  list.sort((a, b) => b.score - a.score || b.correct - a.correct || a.time - b.time || a.name.localeCompare(b.name, 'ar'));
  list.forEach((p, i) => { p.rank = i + 1; });
  return list;
}

function publicQuestion(room) {
  const q = QUESTIONS[room.qIndex];
  return { index: room.qIndex, total: QUESTIONS.length, text: q.q, options: q.options,
    duration: room.duration, endsAt: room.endsAt, serverNow: Date.now() };
}

function emitHost(room, ev, data) { if (room.hostSocket) io.to(room.hostSocket).emit(ev, data); }
function emitPlayer(p, ev, data) { if (p.socketId) io.to(p.socketId).emit(ev, data); }
function emitPlayers(room, ev, data) { for (const p of room.players.values()) emitPlayer(p, ev, data); }

function lobbyPayload(room) {
  return { pin: room.pin, duration: room.duration, count: room.players.size,
    players: [...room.players.values()].map((p) => ({ name: p.name, connected: p.connected, bot: !!p.bot })) };
}

function startQuestion(room) {
  room.state = 'question';
  room.answers = new Map();
  room.startedAt = Date.now();
  room.endsAt = room.startedAt + room.duration * 1000;
  clearTimeout(room.timer);
  room.timer = setTimeout(() => closeQuestion(room), room.duration * 1000 + 50);
  const pq = publicQuestion(room);
  emitHost(room, 'question', pq);
  emitPlayers(room, 'question', pq);
  scheduleBots(room);
}

function closeQuestion(room) {
  if (room.state !== 'question') return;
  clearTimeout(room.timer);
  room.state = 'closed';
  room.botTimers.forEach(clearTimeout); room.botTimers = [];
  emitHost(room, 'closed', { answered: room.answers.size });
  emitPlayers(room, 'closed', {});
}

function revealQuestion(room) {
  if (room.state !== 'closed') return;
  room.state = 'reveal';
  const q = QUESTIONS[room.qIndex];
  const counts = [0, 0, 0, 0];
  const gained = new Map();
  for (const [pid, a] of room.answers) {
    counts[a.choice]++;
    const p = room.players.get(pid);
    if (!p) continue;
    if (a.choice === q.correct) {
      const g = calcScore(room.endsAt - a.at, room.duration * 1000);
      p.score += g; p.correct += 1; p.timeMs += (a.at - room.startedAt);
      gained.set(pid, g);
    }
  }
  const board = ranked(room);
  const base = { correct: q.correct, explain: q.explain, counts, answered: room.answers.size,
    index: room.qIndex, total: QUESTIONS.length, top: board.slice(0, 5), leader: board[0] ? board[0].name : null,
    last: room.qIndex === QUESTIONS.length - 1 };
  room.revealCache = { host: { ...base, gainedList: board.slice(0, 5).map((b) => ({ name: b.name, gained: gained.get(b.id) || 0 })) }, players: new Map() };
  emitHost(room, 'reveal', room.revealCache.host);
  for (const p of room.players.values()) {
    const me = board.find((b) => b.id === p.id);
    const a = room.answers.get(p.id);
    const pl = { ...base, you: { chosen: a ? a.choice : null, isCorrect: !!a && a.choice === q.correct,
      gained: gained.get(p.id) || 0, total: p.score, rank: me ? me.rank : null, of: board.length } };
    room.revealCache.players.set(p.id, pl);
    emitPlayer(p, 'reveal', pl);
  }
}

function finalPayload(room) {
  return { total: QUESTIONS.length,
    board: ranked(room).map((b) => ({ ...b, accuracy: Math.round((b.correct / QUESTIONS.length) * 100) })) };
}
function finish(room) {
  room.state = 'final';
  const payload = finalPayload(room);
  emitHost(room, 'final', payload);
  emitPlayers(room, 'final', payload);
  try {
    fs.mkdirSync(path.dirname(RESULTS_FILE), { recursive: true });
    const old = fs.existsSync(RESULTS_FILE) ? JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8')) : [];
    old.push({ pin: room.pin, at: new Date().toISOString(), board: payload.board });
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(old, null, 1));
  } catch (e) { console.error('save results failed', e.message); }
}

// ---------- وضع التجربة: لاعبون وهميون ----------
function addBots(room) {
  const names = ['تجريبي ١', 'تجريبي ٢', 'تجريبي ٣'];
  for (const n of names) {
    if ([...room.players.values()].some((p) => p.name === n)) continue;
    const id = rid();
    room.players.set(id, { id, name: n, token: rid(), socketId: null, connected: true, score: 0, correct: 0, timeMs: 0, bot: true });
  }
  emitHost(room, 'lobby', lobbyPayload(room));
}
function scheduleBots(room) {
  room.botTimers = [];
  for (const p of room.players.values()) {
    if (!p.bot) continue;
    const delay = 1500 + Math.random() * (room.duration * 1000 * 0.7);
    room.botTimers.push(setTimeout(() => submitAnswer(room, p, Math.floor(Math.random() * 4)), delay));
  }
}

function submitAnswer(room, p, choice) {
  if (room.state !== 'question') return { ok: false, err: 'انتهى وقت السؤال' };
  const now = Date.now();
  if (now > room.endsAt) return { ok: false, err: 'انتهى وقت السؤال' };
  if (!Number.isInteger(choice) || choice < 0 || choice > 3) return { ok: false, err: 'إجابة غير صالحة' };
  if (room.answers.has(p.id)) return { ok: false, err: 'تم تسجيل إجابتك مسبقًا' };
  room.answers.set(p.id, { choice, at: now });
  const humans = [...room.players.values()].length;
  emitHost(room, 'answerCount', { answered: room.answers.size, total: humans });
  if (room.answers.size >= humans) closeQuestion(room);
  return { ok: true };
}

io.on('connection', (socket) => {
  const guard = (fn) => (...args) => {
    const ack = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : () => {};
    const rr = rooms.get(socket.data.hostPin || socket.data.pin); if (rr) rr.lastActive = Date.now();
    if (!limiter(socket)) return ack({ ok: false, err: 'محاولات كثيرة، انتظر قليلًا' });
    try { fn(...args); } catch (e) { console.error(e); ack({ ok: false, err: 'خطأ في الخادم' }); }
  };
  const hostRoom = () => { const r = rooms.get(socket.data.hostPin); return r && r.hostSocket === socket.id ? r : null; };

  // ===== المضيف =====
  socket.on('host:create', guard(async (data, ack) => {
    const pin = newPin();
    const duration = DURATIONS.includes(+data?.duration) ? +data.duration : 20;
    const room = { pin, hostToken: rid(), hostSocket: socket.id, players: new Map(), state: 'lobby', qIndex: -1,
      duration, answers: new Map(), botTimers: [], lastActive: Date.now() };
    rooms.set(pin, room);
    socket.data.hostPin = pin;
    const base = process.env.PUBLIC_URL || reachableBase(sanitize(data?.origin));
    const joinUrl = `${base.replace(/\/$/, '')}/?pin=${pin}`;
    const qr = await QRCode.toDataURL(joinUrl, { margin: 1, width: 360, color: { dark: '#0e2a5c', light: '#ffffff' } });
    ack({ ok: true, pin, hostToken: room.hostToken, joinUrl, qr, total: QUESTIONS.length });
    emitHost(room, 'lobby', lobbyPayload(room));
  }));

  socket.on('host:resume', guard((data, ack) => {
    const room = rooms.get(String(data?.pin));
    if (!room || room.hostToken !== data?.hostToken) return ack({ ok: false, err: 'الجلسة غير موجودة' });
    room.hostSocket = socket.id; socket.data.hostPin = room.pin;
    ack({ ok: true, state: room.state });
    if (room.state === 'lobby') emitHost(room, 'lobby', lobbyPayload(room));
    else if (room.state === 'question') emitHost(room, 'question', publicQuestion(room));
    else if (room.state === 'closed') emitHost(room, 'closed', { answered: room.answers.size });
    else if (room.state === 'reveal' && room.revealCache) emitHost(room, 'reveal', room.revealCache.host);
    else if (room.state === 'final') emitHost(room, 'final', finalPayload(room));
  }));

  socket.on('host:duration', guard((d, ack) => {
    const room = hostRoom(); if (!room || room.state !== 'lobby') return ack({ ok: false });
    if (!DURATIONS.includes(+d)) return ack({ ok: false });
    room.duration = +d; emitHost(room, 'lobby', lobbyPayload(room)); ack({ ok: true });
  }));
  socket.on('host:demo', guard((_, ack) => { const room = hostRoom(); if (!room || room.state !== 'lobby') return ack({ ok: false }); addBots(room); ack({ ok: true }); }));
  socket.on('host:start', guard((_, ack) => {
    const room = hostRoom(); if (!room || room.state !== 'lobby') return ack({ ok: false });
    if (room.players.size < 1) return ack({ ok: false, err: 'لا يوجد مشاركون بعد' });
    room.qIndex = 0; startQuestion(room); ack({ ok: true });
  }));
  socket.on('host:close', guard((_, ack) => { const room = hostRoom(); if (room) closeQuestion(room); ack({ ok: true }); }));
  socket.on('host:reveal', guard((_, ack) => { const room = hostRoom(); if (room) revealQuestion(room); ack({ ok: true }); }));
  socket.on('host:next', guard((_, ack) => {
    const room = hostRoom(); if (!room || room.state !== 'reveal') return ack({ ok: false });
    room.qIndex += 1;
    if (room.qIndex >= QUESTIONS.length) finish(room); else startQuestion(room);
    ack({ ok: true });
  }));
  socket.on('host:restart', guard((_, ack) => {
    const room = hostRoom(); if (!room) return ack({ ok: false });
    clearTimeout(room.timer); room.botTimers.forEach(clearTimeout);
    room.state = 'lobby'; room.qIndex = -1; room.answers = new Map();
    for (const p of room.players.values()) { p.score = 0; p.correct = 0; p.timeMs = 0; }
    emitHost(room, 'lobby', lobbyPayload(room)); emitPlayers(room, 'wait', {}); ack({ ok: true });
  }));

  // ===== المشارك =====
  socket.on('player:join', guard((data, ack) => {
    const pin = String(data?.pin || '').trim();
    const name = sanitize(data?.name).slice(0, 20);
    const room = rooms.get(pin);
    if (!/^\d{6}$/.test(pin) || !room) return ack({ ok: false, err: 'رمز الغرفة غير صحيح' });
    if (room.state !== 'lobby') return ack({ ok: false, err: 'بدأت المسابقة بالفعل' });
    if (name.length < 2) return ack({ ok: false, err: 'اكتب اسمًا مستعارًا من حرفين على الأقل' });
    if (room.players.size >= MAX_PLAYERS) return ack({ ok: false, err: 'الغرفة ممتلئة' });
    const dup = [...room.players.values()].some((p) => p.name.toLowerCase() === name.toLowerCase());
    if (dup) return ack({ ok: false, err: 'هذا الاسم مستخدم، اختر اسمًا آخر' });
    const id = rid();
    const p = { id, name, token: rid(), socketId: socket.id, connected: true, score: 0, correct: 0, timeMs: 0 };
    room.players.set(id, p);
    socket.data.pin = pin; socket.data.pid = id;
    ack({ ok: true, token: p.token, pid: id, name });
    emitHost(room, 'lobby', lobbyPayload(room));
  }));

  socket.on('player:resume', guard((data, ack) => {
    const room = rooms.get(String(data?.pin));
    const p = room && [...room.players.values()].find((x) => x.token === data?.token);
    if (!p) return ack({ ok: false, err: 'انتهت الجلسة، انضم من جديد' });
    p.socketId = socket.id; p.connected = true; socket.data.pin = room.pin; socket.data.pid = p.id;
    ack({ ok: true, name: p.name, state: room.state });
    if (room.state === 'question') {
      emitPlayer(p, 'question', { ...publicQuestion(room), answered: room.answers.has(p.id) ? room.answers.get(p.id).choice : null });
    } else if (room.state === 'closed') emitPlayer(p, 'closed', {});
    else if (room.state === 'reveal' && room.revealCache && room.revealCache.players.get(p.id)) emitPlayer(p, 'reveal', room.revealCache.players.get(p.id));
    else if (room.state === 'final') emitPlayer(p, 'final', finalPayload(room));
    else emitPlayer(p, 'wait', {});
    emitHost(room, 'lobby', lobbyPayload(room));
  }));

  socket.on('player:answer', guard((choice, ack) => {
    const room = rooms.get(socket.data.pin);
    const p = room && room.players.get(socket.data.pid);
    if (!p) return ack({ ok: false, err: 'الجلسة غير صالحة' });
    ack(submitAnswer(room, p, choice));
  }));

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.pin);
    if (room && room.players.get(socket.data.pid)) {
      room.players.get(socket.data.pid).connected = false;
      if (room.state === 'lobby') emitHost(room, 'lobby', lobbyPayload(room));
    }
  });
});

// تنظيف الغرف الخاملة
setInterval(() => {
  const now = Date.now();
  for (const [pin, r] of rooms) {
    if (now - (r.lastActive || now) > ROOM_TTL_MS) { clearTimeout(r.timer); rooms.delete(pin); }
  }
}, 10 * 60 * 1000).unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://localhost:${PORT}`);
  lanIps().forEach((ip) => console.log(`  من الأجهزة الأخرى على نفس الواي فاي: http://${ip}:${PORT}`));
});
module.exports = { calcScore };
