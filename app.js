(() => {
  const socket = io();
  const $app = document.getElementById('app');
  const $net = document.getElementById('net');
  const SHAPES = ['◆', '▲', '●', '■'];
  const LETTERS = ['أ', 'ب', 'ج', 'د'];
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const emit = (ev, data) => new Promise((res) => socket.timeout(8000).emit(ev, data, (err, r) => res(err ? { ok: false, err: 'تعذّر الاتصال بالخادم' } : r)));

  const S = { role: null, pin: null, hostToken: null, token: null, name: null, offset: 0, tick: null, joinUrl: '', qr: '', duration: 20, last: null };
  const store = sessionStorage;

  // ---------- الاتصال وإعادة الاتصال ----------
  socket.on('disconnect', () => { $net.hidden = false; });
  socket.on('connect', async () => {
    $net.hidden = true;
    if (S.role === 'host' && S.pin) {
      const r = await emit('host:resume', { pin: S.pin, hostToken: S.hostToken });
      if (!r.ok) fatal('انتهت الجلسة', 'لم يعد الخادم يحتفظ بهذه الغرفة. أنشئ مسابقة جديدة.');
    } else if (S.role === 'player' && S.pin) {
      const r = await emit('player:resume', { pin: S.pin, token: S.token });
      if (!r.ok) fatal('انقطعت جلستك', r.err || 'انضم من جديد باستخدام الرمز.');
    }
  });

  function fatal(title, msg) {
    stopTimer();
    store.clear(); S.role = null; S.pin = null;
    $app.innerHTML = `<div class="status"><div class="em">⚠️</div><h2>${esc(title)}</h2><p class="muted">${esc(msg)}</p><button id="goHome">العودة إلى الرئيسية</button></div>`;
    document.getElementById('goHome').onclick = () => { location.href = '/'; };
  }

  // ---------- المؤقّت (متزامن مع ساعة الخادم) ----------
  function startTimer(q, onTick) {
    stopTimer();
    S.offset = q.serverNow - Date.now();
    const C = 2 * Math.PI * 38;
    S.tick = setInterval(() => {
      const left = Math.max(0, q.endsAt - (Date.now() + S.offset));
      const el = document.getElementById('timer');
      if (!el) return;
      const sec = Math.ceil(left / 1000);
      el.querySelector('b').textContent = sec;
      el.querySelector('.fg').style.strokeDashoffset = C * (1 - left / (q.duration * 1000));
      el.classList.toggle('low', sec <= 5);
      if (onTick) onTick(left);
      if (left <= 0) stopTimer();
    }, 100);
  }
  function stopTimer() { clearInterval(S.tick); S.tick = null; }
  const timerHtml = (q) => `<div class="timer" id="timer" role="timer"><svg viewBox="0 0 84 84"><circle class="bg" cx="42" cy="42" r="38"/><circle class="fg" cx="42" cy="42" r="38" stroke-dasharray="${2 * Math.PI * 38}" stroke-dashoffset="0"/></svg><b>${q.duration}</b></div>`;
  const topbar = (q, extra = '') => `<div class="top"><span class="qnum">${q.index + 1} / ${q.total}</span><div class="progress"><i style="width:${((q.index + 1) / q.total) * 100}%"></i></div>${extra}${timerHtml(q)}</div>`;

  // ---------- الرئيسية ----------
  function home(prefPin) {
    S.role = null; stopTimer();
    $app.innerHTML = `<section class="home">
      <div><span class="pill">مسابقة المدود ومراتب المدود</span></div>
      <h1>اختبر إتقانك للمدود<br>بالسرعة والدقة</h1>
      <div class="actions">
        <button id="bHost">إنشاء مسابقة</button>
        <button id="bJoin" class="alt">الانضمام إلى مسابقة</button>
      </div></section>`;
    document.getElementById('bHost').onclick = hostSetup;
    document.getElementById('bJoin').onclick = () => joinScreen(prefPin);
  }

  // ---------- المضيف ----------
  function hostSetup() {
    $app.innerHTML = `<section class="narrow card white stack">
      <h2>إنشاء مسابقة</h2>
      <label>مدة كل سؤال<select id="dur">${[10, 15, 20, 30].map((d) => `<option value="${d}" ${d === 20 ? 'selected' : ''}>${d} ثانية</option>`).join('')}</select></label>
      <p class="note">ستعرض هذه الشاشة على الجهاز الكبير. يدخل المشاركون من هواتفهم عبر رمز QR أو رمز الغرفة.</p>
      <div class="err" id="err"></div>
      <button id="go">إنشاء الغرفة</button><button class="alt" id="back">رجوع</button></section>`;
    document.getElementById('back').onclick = () => home();
    document.getElementById('go').onclick = async () => {
      const r = await emit('host:create', { duration: +document.getElementById('dur').value, origin: location.origin });
      if (!r.ok) return (document.getElementById('err').textContent = r.err || 'تعذّر إنشاء الغرفة');
      Object.assign(S, { role: 'host', pin: r.pin, hostToken: r.hostToken, joinUrl: r.joinUrl, qr: r.qr });
      store.setItem('host', JSON.stringify({ pin: r.pin, hostToken: r.hostToken, joinUrl: r.joinUrl, qr: r.qr }));
    };
  }

  socket.on('lobby', (d) => {
    if (S.role !== 'host') return;
    stopTimer(); S.duration = d.duration;
    $app.innerHTML = `<div class="lobby">
      <div class="stack">
        <div class="pinbox"><div>رمز الغرفة</div><div class="pin">${d.pin}</div></div>
        <div class="card white center stack"><div class="qr"><img src="${S.qr}" alt="رمز QR للانضمام"></div>
          <div>أو افتح الرابط:</div><div class="url">${esc(S.joinUrl)}</div></div>
      </div>
      <div class="stack">
        <div class="card stack">
          <div class="row"><h2 class="grow">المنضمّون (${d.count})</h2></div>
          <div class="names">${d.players.length ? d.players.map((p) => `<span class="chip ${p.connected ? '' : 'off'}">${esc(p.name)}${p.bot ? ' 🤖' : ''}</span>`).join('') : '<span class="muted">بانتظار انضمام المشاركين…</span>'}</div>
        </div>
        <div class="card white stack">
          <label>مدة السؤال<select id="dur">${[10, 15, 20, 30].map((x) => `<option value="${x}" ${x === d.duration ? 'selected' : ''}>${x} ثانية</option>`).join('')}</select></label>
          <div class="err" id="err"></div>
          <button id="start" ${d.count ? '' : 'disabled'}>ابدأ المسابقة</button>
          <button class="alt" id="demo">وضع التجربة: إضافة 3 لاعبين وهميين</button>
          <p class="note"><b>النقاط:</b> للإجابة الصحيحة فقط، وتصل إلى 1000 نقطة حسب سرعة الإجابة: النقاط = 1000 × (0.5 + 0.5 × الوقت المتبقي ÷ مدة السؤال).<br><b>التعادل:</b> الأكثر نقاطًا، ثم الأكثر إجابات صحيحة، ثم الأقل مجموع زمن للإجابات الصحيحة.</p>
        </div></div></div>`;
    document.getElementById('dur').onchange = (e) => emit('host:duration', +e.target.value);
    document.getElementById('demo').onclick = () => emit('host:demo');
    document.getElementById('start').onclick = async () => { const r = await emit('host:start'); if (!r.ok) document.getElementById('err').textContent = r.err || 'تعذّر البدء'; };
  });

  socket.on('question', (q) => {
    if (S.role === 'host') hostQuestion(q);
    else if (S.role === 'player') playerQuestion(q);
  });

  function hostQuestion(q) {
    $app.innerHTML = `${topbar(q, `<span class="big" id="ans">0 أجابوا</span>`)}
      <div class="qtext">${esc(q.text)}</div>
      <div class="opts">${q.options.map((o, i) => `<div class="opt static"><span class="sh">${SHAPES[i]}</span><span>${esc(o)}</span></div>`).join('')}</div>
      <div class="row" style="margin-top:20px"><button id="stop">إنهاء السؤال الآن</button></div>`;
    document.getElementById('stop').onclick = () => emit('host:close');
    startTimer(q);
  }
  socket.on('answerCount', (d) => { const el = document.getElementById('ans'); if (el) el.textContent = `${d.answered} / ${d.total} أجابوا`; });

  socket.on('closed', (d) => {
    stopTimer();
    if (S.role === 'host') {
      const t = document.getElementById('timer'); if (t) t.querySelector('b').textContent = '0';
      const row = document.querySelector('.row button');
      if (row) { row.textContent = 'كشف الإجابة'; row.onclick = () => emit('host:reveal'); }
      else $app.insertAdjacentHTML('beforeend', '<div class="row"><button id="rv">كشف الإجابة</button></div>');
      const rv = document.getElementById('rv'); if (rv) rv.onclick = () => emit('host:reveal');
    } else if (S.role === 'player') {
      status('⏱️', 'انتهى الوقت', 'بانتظار كشف الإجابة من المضيف…');
    }
  });

  function boardHtml(top, meName, gained) {
    return `<div class="board">${top.map((p) => `<div class="lrow ${p.rank === 1 ? 'first' : ''} ${p.name === meName ? 'me' : ''}"><span class="rk">${p.rank}</span><span class="nm">${p.rank === 1 ? '👑 ' : ''}${esc(p.name)}</span>${gained && gained[p.name] ? `<span class="gn">+${gained[p.name]}</span>` : ''}<span class="sc">${p.score}</span></div>`).join('')}</div>`;
  }

  socket.on('reveal', (d) => {
    stopTimer();
    if (S.role === 'host') {
      const gm = {}; d.gainedList.forEach((g) => { gm[g.name] = g.gained; });
      const max = Math.max(1, ...d.counts);
      const q = S.last;
      $app.innerHTML = `<div class="top"><span class="qnum">${d.index + 1} / ${d.total}</span><div class="progress"><i style="width:${((d.index + 1) / d.total) * 100}%"></i></div></div>
        <div class="reveal"><div class="stack">
          ${q ? `<div class="qtext">${esc(q.text)}</div>` : ''}
          <div class="opts">${(q ? q.options : ['', '', '', '']).map((o, i) => `<div class="opt static ${i === d.correct ? 'ok' : 'dim'}"><span class="sh">${SHAPES[i]}</span><span>${esc(o)}</span><span class="cnt">${d.counts[i]}</span></div>`).join('')}</div>
          <div class="explain"><b>الإجابة الصحيحة: ${LETTERS[d.correct]}.</b> ${esc(d.explain)}</div>
        </div><div class="stack"><h2>الترتيب الحالي</h2>${boardHtml(d.top, null, gm)}
          <button id="next">${d.last ? 'عرض النتائج النهائية' : 'السؤال التالي'}</button></div></div>`;
      document.getElementById('next').onclick = () => emit('host:next');
    } else if (S.role === 'player') {
      const y = d.you; const q = S.last;
      $app.innerHTML = `<div class="status"><div class="em">${y.chosen === null ? '⏱️' : y.isCorrect ? '✅' : '❌'}</div>
        <h2>${y.chosen === null ? 'لم تُجب هذه المرة' : y.isCorrect ? 'إجابة صحيحة!' : 'إجابة خاطئة'}</h2>
        ${y.isCorrect ? `<div class="big" style="color:var(--green)">+${y.gained} نقطة</div>` : ''}
        <div class="card white">الإجابة الصحيحة: <b>${LETTERS[d.correct]}${q ? ' — ' + esc(q.options[d.correct]) : ''}</b></div>
        <div class="explain">${esc(d.explain)}</div>
        <div class="big">مركزك ${y.rank} من ${y.of} — ${y.total} نقطة</div>
        <div style="width:min(520px,100%)">${boardHtml(d.top.slice(0, 3), S.name)}</div></div>`;
    }
  });

  // ---------- المشارك ----------
  function joinScreen(prefPin) {
    S.role = null;
    $app.innerHTML = `<section class="narrow card white stack"><h2>الانضمام إلى مسابقة</h2>
      <label>رمز الغرفة<input id="pin" inputmode="numeric" maxlength="6" autocomplete="off" value="${esc(prefPin || '')}" placeholder="٦ أرقام"></label>
      <label>الاسم المستعار<input id="nm" maxlength="20" autocomplete="off" placeholder="مثال: نور"></label>
      <div class="err" id="err"></div><button id="go">انضمام</button><button class="alt" id="back">رجوع</button></section>`;
    document.getElementById('back').onclick = () => home();
    document.getElementById('go').onclick = async () => {
      const r = await emit('player:join', { pin: document.getElementById('pin').value, name: document.getElementById('nm').value });
      if (!r.ok) return (document.getElementById('err').textContent = r.err);
      Object.assign(S, { role: 'player', pin: document.getElementById('pin').value.trim(), token: r.token, name: r.name });
      store.setItem('player', JSON.stringify({ pin: S.pin, token: r.token, name: r.name }));
      status('⏳', 'أنت في قائمة الانتظار', 'ستبدأ المسابقة قريبًا. أبقِ هذه الشاشة مفتوحة.');
    };
    document.getElementById(prefPin ? 'nm' : 'pin').focus();
  }
  function status(em, t, m) {
    stopTimer();
    $app.innerHTML = `<div class="status"><div class="em">${em}</div><h2>${esc(t)}</h2><p class="muted">${esc(m || '')}</p>${S.name ? `<span class="chip">${esc(S.name)}</span>` : ''}</div>`;
  }
  socket.on('wait', () => { if (S.role === 'player') status('⏳', 'أنت في قائمة الانتظار', 'ستبدأ المسابقة قريبًا.'); });

  function playerQuestion(q) {
    S.last = { text: q.text, options: q.options };
    $app.innerHTML = `${topbar(q)}<div class="qtext">${esc(q.text)}</div>
      <div class="opts" id="opts">${q.options.map((o, i) => `<button class="opt" data-i="${i}"><span class="sh">${SHAPES[i]}</span><span>${esc(o)}</span></button>`).join('')}</div>
      <div class="err" id="err" style="margin-top:12px"></div>`;
    startTimer(q);
    const lock = (chosen) => document.querySelectorAll('#opts .opt').forEach((b) => { b.disabled = true; b.classList.toggle('sel', +b.dataset.i === chosen); b.classList.toggle('dim', +b.dataset.i !== chosen); });
    if (q.answered !== undefined && q.answered !== null) lock(q.answered);
    document.querySelectorAll('#opts .opt').forEach((b) => {
      b.onclick = async () => {
        const i = +b.dataset.i; lock(i);
        const r = await emit('player:answer', i);
        if (!r.ok) { document.getElementById('err').textContent = r.err; return; }
        status('✔️', 'تم تسجيل إجابتك', 'بانتظار انتهاء الوقت وكشف النتيجة…');
      };
    });
  }

  // نحتفظ بنص السؤال لدى المضيف لعرضه في شاشة الكشف
  socket.on('question', (q) => { if (S.role === 'host') S.last = { text: q.text, options: q.options }; });

  // ---------- النتائج النهائية ----------
  socket.on('final', (d) => {
    stopTimer();
    const [a, b, c] = d.board;
    const pod = (p, cls, medal, place) => p ? `<div class="pod ${cls}"><div class="who">${esc(p.name)}</div><div class="blk"><span class="medal">${medal}</span><span>${place}</span><span>${p.score} نقطة</span></div></div>` : '';
    const me = S.role === 'player' ? d.board.find((x) => x.name === S.name) : null;
    $app.innerHTML = `<div class="center"><span class="pill">النتائج النهائية</span></div>
      <div class="podium">${pod(b, 'p2', '🥈', 'المركز الثاني')}${pod(a, 'p1', '🥇', 'المركز الأول')}${pod(c, 'p3', '🥉', 'المركز الثالث')}</div>
      ${a ? `<div class="center big">الفائز: ${esc(a.name)} — ${a.score} نقطة — دقة ${a.accuracy}%</div>` : ''}
      ${me ? `<div class="center big" style="margin-top:10px">مركزك: ${me.rank} — ${me.score} نقطة — ${me.correct} / ${d.total} صحيحة</div>` : ''}
      <h2 style="margin-top:24px">الترتيب الكامل</h2>
      <table><thead><tr><th>#</th><th>الاسم</th><th>النقاط</th><th>الصحيحة</th><th>الدقة</th></tr></thead><tbody>
      ${d.board.map((p) => `<tr><td>${p.rank}</td><td>${esc(p.name)}</td><td>${p.score}</td><td>${p.correct} / ${d.total}</td><td>${p.accuracy}%</td></tr>`).join('')}</tbody></table>
      ${S.role === 'host' ? `<div class="row" style="margin-top:20px"><button id="again">جولة جديدة</button><button class="alt" id="home">الصفحة الرئيسية</button></div>` : ''}`;
    if (S.role === 'host') {
      document.getElementById('again').onclick = () => emit('host:restart');
      document.getElementById('home').onclick = () => { store.clear(); location.href = '/'; };
    }
    setTimeout(confetti, 1900);
  });

  // ---------- قصاصات احتفالية (تُحترم إعدادات تقليل الحركة) ----------
  function confetti() {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const cv = document.getElementById('confetti'); const ctx = cv.getContext('2d');
    cv.width = innerWidth; cv.height = innerHeight;
    const cols = ['#004AAD', '#73A2E8', '#4BACC6', '#CDDEF4', '#6A2EE0', '#0A8F4E'];
    const ps = Array.from({ length: 140 }, () => ({ x: Math.random() * cv.width, y: -20 - Math.random() * cv.height * 0.5, vx: (Math.random() - 0.5) * 2, vy: 2 + Math.random() * 3, s: 6 + Math.random() * 6, c: cols[(Math.random() * cols.length) | 0], r: Math.random() * 6 }));
    let t = 0;
    (function frame() {
      ctx.clearRect(0, 0, cv.width, cv.height);
      ps.forEach((p) => { p.x += p.vx; p.y += p.vy; p.r += 0.1; ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c; ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); ctx.restore(); });
      if (++t < 260) requestAnimationFrame(frame); else ctx.clearRect(0, 0, cv.width, cv.height);
    })();
  }

  // ---------- الإقلاع واستئناف الجلسة بعد إعادة تحميل الصفحة ----------
  const params = new URLSearchParams(location.search);
  const h = store.getItem('host'), p = store.getItem('player');
  if (h) { const o = JSON.parse(h); Object.assign(S, { role: 'host', pin: o.pin, hostToken: o.hostToken, joinUrl: o.joinUrl, qr: o.qr }); status('⏳', 'جارٍ استعادة الجلسة…'); }
  else if (p) { const o = JSON.parse(p); Object.assign(S, { role: 'player', pin: o.pin, token: o.token, name: o.name }); status('⏳', 'جارٍ استعادة الجلسة…'); }
  else if (params.get('pin')) joinScreen(params.get('pin'));
  else home();
})();
