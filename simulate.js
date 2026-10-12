// اختبار آلي: مضيف + 3 مشاركين، يتحقق من القواعد الأساسية
const { spawn } = require('child_process');
const { io } = require('socket.io-client');
const QUESTIONS = require('../server/questions');
const PORT = 3111;
const URL = `http://localhost:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`); };
const ack = (s, ev, d) => new Promise((r) => s.emit(ev, d, r));
const once = (s, ev) => new Promise((r) => s.once(ev, r));

(async () => {
  const srv = spawn('node', ['server/index.js'], { env: { ...process.env, PORT }, stdio: 'ignore', cwd: require('path').join(__dirname, '..') });
  await wait(1000);
  const mk = () => io(URL, { transports: ['websocket'] });
  const host = mk(), A = mk(), B = mk(), C = mk(), X = mk();
  await wait(300);

  const room = await ack(host, 'host:create', { duration: 10, origin: URL });
  check('تم إنشاء الغرفة برمز من 6 أرقام وQR', room.ok && /^\d{6}$/.test(room.pin) && room.qr.startsWith('data:image/png'));
  check('رابط الانضمام يحمل الرمز', room.joinUrl.endsWith(`?pin=${room.pin}`));

  const bad = await ack(A, 'player:join', { pin: '000000', name: 'نور' });
  check('رمز خاطئ يُرفض برسالة', !bad.ok && /غير صحيح/.test(bad.err));
  const a = await ack(A, 'player:join', { pin: room.pin, name: 'نور' });
  const b = await ack(B, 'player:join', { pin: room.pin, name: 'سالم' });
  const c = await ack(C, 'player:join', { pin: room.pin, name: 'ليلى' });
  const dup = await ack(X, 'player:join', { pin: room.pin, name: 'نور' });
  check('انضمام 3 مشاركين إلى نفس الغرفة', a.ok && b.ok && c.ok);
  check('الاسم المكرر يُرفض', !dup.ok && /مستخدم/.test(dup.err));

  const qs = { A: [], B: [], C: [] };
  const revs = { A: [], B: [], C: [] };
  const finals = {};
  let leaked = false;
  for (const [k, s] of [['A', A], ['B', B], ['C', C]]) {
    s.on('question', (q) => { qs[k].push(q); if ('correct' in q || 'explain' in q) leaked = true; });
    s.on('reveal', (r) => revs[k].push(r));
    s.on('final', (f) => { finals[k] = f; });
  }
  const hostReveal = [];
  host.on('reveal', (r) => hostReveal.push(r));
  const hostFinal = once(host, 'final');

  const started = await ack(host, 'host:start');
  check('بدأت المسابقة', started.ok);

  let doubleRejected = null, lateRejected = null;
  for (let i = 0; i < QUESTIONS.length; i++) {
    await wait(250);
    const right = QUESTIONS[i].correct, wrong = (right + 1) % 4;
    const r1 = await ack(A, 'player:answer', right);
    if (i === 0) doubleRejected = await ack(A, 'player:answer', wrong); // محاولة تغيير الإجابة
    await wait(600);
    await ack(B, 'player:answer', right);
    await ack(C, 'player:answer', wrong);
    // كل اللاعبين أجابوا: يُغلق السؤال تلقائيًا
    await wait(150);
    if (i === 0) lateRejected = await ack(B, 'player:answer', right);
    const rv = once(host, 'reveal');
    await ack(host, 'host:reveal');
    await rv;
    await wait(100);
    await ack(host, 'host:next');
    if (!r1.ok) check(`قبول إجابة السؤال ${i + 1}`, false);
  }
  const fin = await hostFinal;
  await wait(300);

  check('إجابة ثانية على نفس السؤال تُرفض', doubleRejected && !doubleRejected.ok);
  check('إجابة بعد الإغلاق تُرفض', lateRejected && !lateRejected.ok);
  check('كل مشارك رأى 15 سؤالًا', ['A', 'B', 'C'].every((k) => qs[k].length === 15));
  check('الجميع رأوا نفس السؤال في كل مرة', qs.A.every((q, i) => q.text === qs.B[i].text && q.text === qs.C[i].text));
  check('الإجابة الصحيحة لا تصل للمشاركين قبل الكشف', !leaked);
  check('وصل الكشف لكل مشارك 15 مرة', ['A', 'B', 'C'].every((k) => revs[k].length === 15));

  const board = fin.board;
  const byName = Object.fromEntries(board.map((p) => [p.name, p]));
  check('المركز الأول: نور', board[0].name === 'نور' && board[0].rank === 1);
  check('المركز الثاني: سالم', board[1].name === 'سالم');
  check('المركز الثالث: ليلى (0 نقطة)', board[2].name === 'ليلى' && board[2].score === 0);
  check('نور أجابت 15 صحيحة بدقة 100%', byName['نور'].correct === 15 && byName['نور'].accuracy === 100);
  check('نقاط نور بين 14000 و15000 (حد أقصى 1000 للسؤال)', byName['نور'].score > 14000 && byName['نور'].score <= 15000, `(${byName['نور'].score})`);
  check('سالم أقل من نور (الأسرع يربح أكثر)', byName['سالم'].score < byName['نور'].score, `(${byName['سالم'].score})`);
  check('المجموع في الكشف الأخير يطابق النتيجة النهائية', revs.A[14].you.total === byName['نور'].score);

  // انقطاع واستئناف لا يفسد النقاط
  A.disconnect(); await wait(200);
  const A2 = mk(); await wait(200);
  const f2p = new Promise((r) => { A2.once('final', r); });
  const rs = await ack(A2, 'player:resume', { pin: room.pin, token: a.token });
  check('استئناف الجلسة بعد انقطاع', rs.ok);
  const f2 = await f2p;
  check('النقاط بعد الاستئناف كما هي', f2.board[0].score === byName['نور'].score);

  console.log(`\n${results.filter(Boolean).length}/${results.length} نجحت`);
  srv.kill(); process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
