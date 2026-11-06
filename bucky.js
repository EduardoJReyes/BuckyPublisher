// Bucky: the goo mascot. Moves between poses per screen, turns his head now
// and then, and gets pushed apart by the cursor. Click = a bigger splat (max every 0.5 s).
(function () {
  const POSES = { signin: { tx: -200, ty: 76, k: 1.2 }, progress: { tx: 0, ty: 0, k: 1 }, peek: { tx: 610, ty: 15, k: 0.5 } };
  const PIECES = [[1000, 270, 80], [930, 230, 70], [1070, 230, 70], [930, 320, 66], [1070, 320, 66], [1000, 188, 60], [1000, 352, 60]];
  const FACE = [
    { k: 'eyeL', p: [927, 230], g: 1.1, m: 1, c: [[50.3, 42, 41]] },
    { k: 'eyeR', p: [1067, 230], g: 1.1, m: 1, c: [[189.7, 42, 41]] },
    { k: 'nose', p: [997, 249], g: 0.9, m: 0.4, c: [[120, 61, 9]] },
    { k: 'mouth', p: [997, 296], g: 1, m: 1.3, c: [[72, 108, 16], [96, 108, 20], [120, 108, 20], [144, 108, 20], [168, 108, 16]] }
  ];
  const still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const st = { pose: 'signin', hover: false, mx: 0, my: 0, down: false, lastPop: 0 };
  let root, stage, parts = {}, pieces = [], heads = [], vis = [], sats = [];

  function tf(x, y) { return 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px)'; }

  function offv(cx, cy, gain) {
    if (!st.hover) return [0, 0];
    const w = POSES[st.pose], lx = (st.mx - w.tx) / w.k, ly = (st.my - w.ty) / w.k, R = 170;
    const dx = cx - lx, dy = cy - ly, d = Math.max(1, Math.hypot(dx, dy));
    if (d >= R) return [0, 0];
    const f = Math.pow(1 - d / R, 1.6) * (st.down ? 80 : 40) * gain;
    return [dx / d * f, dy / d * f];
  }

  function update() {
    PIECES.forEach((p, i) => { const o = offv(p[0], p[1], 1); pieces[i].style.transform = tf(o[0], o[1]); });
    const B = FACE.map((b) => ({ ...b, x: 0, y: 0 }));
    B.forEach((b) => { const o = offv(b.p[0], b.p[1], b.g); b.x = o[0]; b.y = o[1]; });
    for (let it = 0; it < 8; it++) {
      for (let i = 0; i < B.length; i++) for (let j = i + 1; j < B.length; j++) {
        const A = B[i], C = B[j];
        A.c.forEach((ca) => C.c.forEach((cc) => {
          const dx = (cc[0] + C.x) - (ca[0] + A.x), dy = (cc[1] + C.y) - (ca[1] + A.y);
          const d = Math.max(0.01, Math.hypot(dx, dy)), ov = ca[2] + cc[2] + 3 - d;
          if (ov > 0) { const wa = C.m / (A.m + C.m), wc = A.m / (A.m + C.m), nx = dx / d, ny = dy / d; A.x -= nx * ov * wa; A.y -= ny * ov * wa; C.x += nx * ov * wc; C.y += ny * ov * wc; }
        }));
      }
    }
    B.forEach((b) => { if (parts[b.k]) parts[b.k].style.transform = tf(b.x, b.y); });
    const eL = offv(885, 173, 1.1), eR = offv(1109, 173, 1.1);
    ['earL', 'inL'].forEach((k) => parts[k] && (parts[k].style.transform = tf(eL[0], eL[1])));
    ['earR', 'inR'].forEach((k) => parts[k] && (parts[k].style.transform = tf(eR[0], eR[1])));
  }

  function turn() {
    const r = (lo, hi) => lo + Math.random() * (hi - lo);
    const a = r(-12, 12), y = r(-22, 22), x = r(-8, 8);
    heads.forEach((h) => { h.style.transform = 'perspective(700px) translateX(' + x.toFixed(1) + 'px) rotate(' + a.toFixed(1) + 'deg) rotateY(' + y.toFixed(1) + 'deg)'; });
    setTimeout(turn, r(1600, 3400));
  }

  function burst() {
    st.down = true; update();
    clearTimeout(st.pop);
    st.pop = setTimeout(() => { st.down = false; update(); }, 320);
  }

  function setPose(p) {
    if (!POSES[p]) return;
    st.pose = p;
    const w = POSES[p];
    root.style.transform = 'translate(' + w.tx + 'px,' + w.ty + 'px) scale(' + w.k + ')';
    vis.forEach((v) => { v.style.opacity = p === 'signin' ? 0 : 1; });
    sats.forEach((s) => { s.style.opacity = p === 'signin' ? 1 : 0; });
    update();
  }

  function init() {
    root = document.getElementById('bucky');
    stage = document.getElementById('stage');
    document.querySelectorAll('[data-part]').forEach((el) => { parts[el.dataset.part] = el; });
    pieces = PIECES.map((p, i) => {
      const el = document.querySelector('[data-piece="' + i + '"]');
      Object.assign(el.style, { left: (p[0] - p[2]) + 'px', top: (p[1] - p[2]) + 'px', width: p[2] * 2 + 'px', height: p[2] * 2 + 'px', borderRadius: '50%' });
      return el;
    });
    heads = [...document.querySelectorAll('[data-head]')];
    vis = [...document.querySelectorAll('.facevis')];
    sats = [...document.querySelectorAll('.sat')];
    stage.addEventListener('mousemove', (e) => {
      const r = stage.getBoundingClientRect(), k = 1280 / r.width;
      st.hover = true; st.mx = (e.clientX - r.left) * k; st.my = (e.clientY - r.top) * k; update();
    });
    stage.addEventListener('mouseleave', () => { st.hover = false; update(); });
    stage.addEventListener('mousedown', () => { const n = Date.now(); if (n - st.lastPop < 500) return; st.lastPop = n; burst(); });
    setPose('signin');
    if (!still) turn();
  }

  window.Bucky = { init, setPose, burst };
})();
