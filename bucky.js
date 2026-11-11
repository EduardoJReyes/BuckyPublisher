// Bucky: the goo mascot, drawn with WebGL.
//
// The look is the same as the old SVG filter (blur 18 > alpha threshold > blur 5 >
// specular light at 760,-60,260), but worked out per pixel on the graphics card, so
// it runs at full frame rate. All motion (drift, drips, head turns, mouse push,
// moving between screens) is driven here so the goo and the DOM face stay in sync.
// Without WebGL it falls back to the old CSS/SVG version (bucky-legacy.js).
(function () {
  const POSES = { signin: { tx: -200, ty: 76, k: 1.2 }, progress: { tx: 0, ty: 0, k: 1 }, peek: { tx: 610, ty: 15, k: 0.5 } };
  const PIECES = [[1000, 270, 80], [930, 230, 70], [1070, 230, 70], [930, 320, 66], [1070, 320, 66], [1000, 188, 60], [1000, 352, 60]];
  // left, top, size, motion
  const BLOBS = [[1010, 250, 190, 'g2'], [820, 300, 150, 'g3'], [1080, 110, 120, 'g2'], [960, 330, 70, 'gd'], [1090, 360, 54, 'gd2']];
  const SATS = [[1150, 90, 170, 'g1'], [760, 520, 150, 'g2'], [1150, 470, 190, 'g3'], [980, 600, 120, 'g2'], [760, 110, 110, 'g3'], [1230, 330, 110, 'g1']];
  const DRIFT = { g1: [14, [-70, 50], [40, -30], 7], g2: [17, [90, -40], [-50, 60], 9], g3: [12, [-40, -70], [60, 30], 8] };
  const EARS = { box: [832, 108], origin: [165, 150], L: [[25, 130], [125, 55], [10, 10]], R: [[305, 130], [205, 55], [320, 10]] };
  const FACE = [
    { k: 'eyeL', p: [927, 230], g: 1.1, m: 1, c: [[50.3, 42, 41]] },
    { k: 'eyeR', p: [1067, 230], g: 1.1, m: 1, c: [[189.7, 42, 41]] },
    { k: 'nose', p: [997, 249], g: 0.9, m: 0.4, c: [[120, 61, 9]] },
    { k: 'mouth', p: [997, 296], g: 1, m: 1.3, c: [[72, 108, 16], [96, 108, 20], [120, 108, 20], [144, 108, 20], [168, 108, 16]] }
  ];
  const MAX = 20;
  const still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- easing + tweens (same curves the CSS used) -----------------------
  function bezier(x1, y1, x2, y2) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx, cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const sx = (t) => ((ax * t + bx) * t + cx) * t, sy = (t) => ((ay * t + by) * t + cy) * t, dx = (t) => (3 * ax * t + 2 * bx) * t + cx;
    return (x) => {
      if (x <= 0) return 0; if (x >= 1) return 1;
      let t = x;
      for (let i = 0; i < 6; i++) { const e = sx(t) - x, d = dx(t); if (Math.abs(e) < 1e-5 || Math.abs(d) < 1e-6) break; t -= e / d; }
      return sy(Math.min(1, Math.max(0, t)));
    };
  }
  const EASE = { inout: bezier(0.42, 0, 0.58, 1), drip: bezier(0.5, 0, 0.5, 1), head: bezier(0.4, 0, 0.2, 1), pose: bezier(0.65, 0, 0.35, 1), fade: bezier(0.25, 0.1, 0.25, 1) };

  function Tween(v, dur, ease) { this.from = v; this.to = v; this.t0 = 0; this.dur = dur; this.ease = ease; }
  Tween.prototype.at = function (now) {
    const k = this.ease(Math.min(1, (now - this.t0) / this.dur));
    if (Array.isArray(this.to)) return this.to.map((x, i) => this.from[i] + (x - this.from[i]) * k);
    return this.from + (this.to - this.from) * k;
  };
  Tween.prototype.go = function (to, now) { this.from = this.at(now); this.to = to; this.t0 = now; };

  // ---- state -------------------------------------------------------------
  const st = { pose: 'signin', hover: false, mx: 0, my: 0, down: false, lastPop: 0, w: [0, 0, 1], n: 0 };
  let gl, prog, loc, canvas, stage, root, dpr = 1, scaleK = 1;
  let parts = {}, heads = [], vis = [], t0 = performance.now(), lastNow = t0;
  const pose = new Tween([-200, 76, 1.2], 1100, EASE.pose);
  const faceOn = new Tween(0, 600, EASE.fade);
  const head = new Tween([0, 0, 0], 1400, EASE.head);
  const smooth = {};  // mouse offsets, eased like the old 1 s ease-out transition

  function offv(cx, cy, gain, w) {
    if (!st.hover) return [0, 0];
    const lx = (st.mx - w[0]) / w[2], ly = (st.my - w[1]) / w[2], R = 170;
    const dx = cx - lx, dy = cy - ly, d = Math.max(1, Math.hypot(dx, dy));
    if (d >= R) return [0, 0];
    const f = Math.pow(1 - d / R, 1.6) * (st.down ? 80 : 40) * gain;
    return [dx / d * f, dy / d * f];
  }

  function ease(key, target, dt) {
    const s = smooth[key] || (smooth[key] = [0, 0]);
    const a = 1 - Math.exp(-dt / 220);
    s[0] += (target[0] - s[0]) * a; s[1] += (target[1] - s[1]) * a;
    return s;
  }

  function faceTargets(w) {
    const B = FACE.map((b) => { const o = offv(b.p[0], b.p[1], b.g, w); return { ...b, x: o[0], y: o[1] }; });
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
    return B;
  }

  // CSS animation equivalents ---------------------------------------------
  function drift(kind, t) {
    const d = DRIFT[kind], T = d[0];
    let p = (t / T) % 2; if (p > 1) p = 2 - p;          // alternate
    const a = p < 0.5 ? [0, 0] : d[1], b = p < 0.5 ? d[1] : d[2], k = EASE.inout(p < 0.5 ? p * 2 : (p - 0.5) * 2);
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
  }
  // drip: translate + scale keyframes at 0/15/55/80/100 %
  const DRIP = [[0, 0, 0, 1, 1], [0.15, 0, 0, 1, 1], [0.55, 6, 170, 0.7, 1.2], [0.8, 0, 210, 0.55, 0.55], [1, 0, 0, 1, 1]];
  function drip(t, T, delay) {
    if (t < delay) return [0, 0, 1, 1];
    const p = ((t - delay) / T) % 1;
    for (let i = 0; i < DRIP.length - 1; i++) {
      const a = DRIP[i], b = DRIP[i + 1];
      if (p <= b[0]) { const k = EASE.drip((p - a[0]) / (b[0] - a[0])); return [1, 2, 3, 4].map((j) => a[j] + (b[j] - a[j]) * k); }
    }
    return [0, 0, 1, 1];
  }

  // CSS transform "perspective(700px) translateX(x) rotate(a) rotateY(y)" around the ears' origin
  function headPoint(px, py, h) {
    const rx = px - EARS.origin[0], ry = py - EARS.origin[1];
    const ya = h[1] * Math.PI / 180, aa = h[0] * Math.PI / 180;
    let vx = rx * Math.cos(ya), vy = ry, vz = -rx * Math.sin(ya);
    const x2 = vx * Math.cos(aa) - vy * Math.sin(aa), y2 = vx * Math.sin(aa) + vy * Math.cos(aa);
    const s = 700 / (700 - vz);
    return [EARS.box[0] + EARS.origin[0] + (x2 + h[2]) * s, EARS.box[1] + EARS.origin[1] + y2 * s];
  }

  // ---- GL --------------------------------------------------------------
  const VS = 'attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }';
  const FS = `
precision highp float;
#define MAX ${MAX}
uniform vec2 uRes;          // canvas pixels
uniform vec3 uPose;         // tx, ty, k  (stage px = t + k * local)
uniform vec4 uBlob[MAX];    // cx, cy, r, alpha   (local units)
uniform vec4 uShape[MAX];   // sx, sy, wobble amp, wobble angle
uniform int uCount;
uniform vec2 uTri[6];
uniform float uEar;         // ears opacity
uniform vec4 uEarG[2];      // gradient centre xy, radii xy
const float SIG = 18.0;
float cdf(float x){ return 1.0 / (1.0 + exp(-1.5976 * x * (1.0 + 0.04417 * x * x))); }
float pdf(float x){ return 0.3989423 * exp(-0.5 * x * x); }
vec3 grad(float t){
  vec3 a = vec3(0.969, 0.635, 0.494), b = vec3(0.922, 0.369, 0.157), c = vec3(0.725, 0.267, 0.102);
  return t < 0.45 ? mix(a, b, t / 0.45) : mix(b, c, clamp((t - 0.45) / 0.55, 0.0, 1.0));
}
void main(){
  vec2 sp = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uRes * vec2(1280.0, 800.0);
  vec2 p = (sp - uPose.xy) / uPose.z;
  float keep = 1.0;          // product of (1 - a_i): union of blurred shapes
  vec2 g = vec2(0.0);        // gradient of the union (A = 1 - keep)
  vec3 col = vec3(0.0); float wsum = 0.0;
  for (int i = 0; i < MAX; i++) {
    if (i >= uCount) break;
    vec4 b = uBlob[i]; vec4 s = uShape[i];
    vec2 q = (p - b.xy) / s.xy;
    float d = length(q);
    float ang = atan(q.y, q.x);
    float rr = b.z * (1.0 + s.z * cos(2.0 * (ang - s.w)));
    float sc = 0.5 * (s.x + s.y);
    float u = (rr - d) * sc / SIG;
    if (u < -4.0) continue;
    float a = cdf(u) * b.w;
    vec2 n = d > 0.001 ? (p - b.xy) / max(length(p - b.xy), 0.001) : vec2(0.0);
    vec2 ga = -pdf(u) * b.w / SIG * n;
    g = g * (1.0 - a) + ga * keep;
    keep *= (1.0 - a);
    // radial-gradient(circle at 35% 30%) over a box of side 2r, farthest-corner size
    vec2 gc = b.xy + vec2(-0.3, -0.4) * b.z;
    col += grad(length(p - gc) / (1.91 * b.z)) * a; wsum += a;
  }
  // ears: blurred triangle = product of three blurred half-planes
  if (uEar > 0.001) {
    for (int e = 0; e < 2; e++) {
      vec2 v0 = uTri[e * 3], v1 = uTri[e * 3 + 1], v2 = uTri[e * 3 + 2];
      float orient = sign((v1.x - v0.x) * (v2.y - v0.y) - (v1.y - v0.y) * (v2.x - v0.x));
      float a = uEar; vec2 sumg = vec2(0.0);
      for (int k = 0; k < 3; k++) {
        vec2 A = k == 0 ? v0 : (k == 1 ? v1 : v2), B = k == 0 ? v1 : (k == 1 ? v2 : v0);
        vec2 ed = B - A; vec2 nout = normalize(vec2(ed.y, -ed.x)) * orient;
        float h = dot(p - A, nout);               // > 0 outside this edge
        float u = -h / SIG, c = max(cdf(u), 1e-5);
        a *= c; sumg += -(pdf(u) / c) * nout / SIG;
      }
      if (a < 1e-4) continue;
      vec2 ga = a * sumg;
      g = g * (1.0 - a) + ga * keep;
      keep *= (1.0 - a);
      vec4 eg = uEarG[e];
      col += grad(length((p - eg.xy) / eg.zw)) * a; wsum += a;
    }
  }
  float A = 1.0 - keep;
  if (A < 0.3) { gl_FragColor = vec4(0.0); return; }
  float G = clamp(A * 26.0 - 10.0, 0.0, 1.0);     // feColorMatrix alpha threshold
  vec3 base = col / max(wsum, 1e-4);
  // second blur (5) of the thresholded shape, used as the height map
  float gl2 = max(length(g), 1e-4);
  float sd = (A - 0.404) / gl2;                     // ~ distance inside the edge
  float S = cdf(sd / 5.0);
  vec2 dS = pdf(sd / 5.0) / 5.0 * (g / gl2);
  vec3 N = normalize(vec3(-20.0 * dS, 1.0));   // Sobel normal: 2 x slope x surfaceScale
  vec3 L = normalize(vec3(760.0, -60.0, 260.0) - vec3(p, 7.0 * S));
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
  float E = clamp(1.05 * pow(max(dot(N, H), 0.0), 26.0), 0.0, 1.0);
  vec3 spec = E * vec3(1.0, 0.988, 0.949);
  float sa = max(spec.r, max(spec.g, spec.b));
  vec3 rgb = base * G + 0.75 * spec * sa * G;        // goo + 0.75 * (shine in goo), premultiplied
  float alpha = min(1.0, G + 0.75 * sa * G);
  gl_FragColor = vec4(min(rgb, vec3(alpha)), alpha);
}`;

  function makeGL() {
    canvas = document.createElement('canvas');
    canvas.id = 'goo';
    canvas.setAttribute('aria-hidden', 'true');
    Object.assign(canvas.style, { position: 'absolute', left: '0', top: '0', width: '1280px', height: '800px', pointerEvents: 'none' });
    const c = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false });
    if (!c) return false;
    const sh = (type, src) => { const s = c.createShader(type); c.shaderSource(s, src); c.compileShader(s); if (!c.getShaderParameter(s, c.COMPILE_STATUS)) throw new Error(c.getShaderInfoLog(s)); return s; };
    try {
      prog = c.createProgram();
      c.attachShader(prog, sh(c.VERTEX_SHADER, VS)); c.attachShader(prog, sh(c.FRAGMENT_SHADER, FS)); c.linkProgram(prog);
      if (!c.getProgramParameter(prog, c.LINK_STATUS)) throw new Error(c.getProgramInfoLog(prog));
    } catch (e) { console.warn('Bucky: WebGL shader failed, using the CSS version', e); return false; }
    c.useProgram(prog);
    const buf = c.createBuffer(); c.bindBuffer(c.ARRAY_BUFFER, buf);
    c.bufferData(c.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), c.STATIC_DRAW);
    const ap = c.getAttribLocation(prog, 'p'); c.enableVertexAttribArray(ap); c.vertexAttribPointer(ap, 2, c.FLOAT, false, 0, 0);
    loc = {};
    ['uRes', 'uPose', 'uBlob', 'uShape', 'uCount', 'uTri', 'uEar', 'uEarG'].forEach((n) => { loc[n] = c.getUniformLocation(prog, n); });
    c.clearColor(0, 0, 0, 0);
    c.enable(c.SCISSOR_TEST);
    gl = c;
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); gl = null; });
    return true;
  }

  function resize() {
    const r = stage.getBoundingClientRect();
    scaleK = r.width / 1280 || 1;
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    let w = Math.round(1280 * scaleK * dpr), h = Math.round(800 * scaleK * dpr);
    const cap = 2200 / w; if (cap < 1) { w = Math.round(w * cap); h = Math.round(h * cap); }
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }

  // ---- frame ------------------------------------------------------------
  const blobData = new Float32Array(MAX * 4), shapeData = new Float32Array(MAX * 4), triData = new Float32Array(12), earG = new Float32Array(8);
  let lastPoseKey = '', lastHeadKey = '';

  function frame(now) {
    const dt = Math.min(100, now - lastNow); lastNow = now;
    const t = still ? 0 : (now - t0) / 1000;
    const w = pose.at(now), fo = faceOn.at(now), h = head.at(now);

    // DOM: Bucky's face layer follows the same pose and head tween
    const pk = w.map((v) => v.toFixed(2)).join();
    if (pk !== lastPoseKey) { root.style.transform = 'translate(' + w[0] + 'px,' + w[1] + 'px) scale(' + w[2] + ')'; lastPoseKey = pk; }
    vis.forEach((v) => { v.style.opacity = fo.toFixed(3); });
    const hk = h.map((v) => v.toFixed(2)).join();
    if (hk !== lastHeadKey) {
      heads.forEach((el) => { el.style.transform = 'perspective(700px) translateX(' + h[2].toFixed(2) + 'px) rotate(' + h[0].toFixed(2) + 'deg) rotateY(' + h[1].toFixed(2) + 'deg)'; });
      lastHeadKey = hk;
    }
    const F = faceTargets(w);
    F.forEach((b) => { const s = ease(b.k, [b.x, b.y], dt); parts[b.k] && (parts[b.k].style.transform = 'translate(' + s[0].toFixed(1) + 'px,' + s[1].toFixed(1) + 'px)'); });
    const eL = ease('earL', offv(885, 173, 1.1, w), dt), eR = ease('earR', offv(1109, 173, 1.1, w), dt);
    parts.inL && (parts.inL.style.transform = 'translate(' + eL[0].toFixed(1) + 'px,' + eL[1].toFixed(1) + 'px)');
    parts.inR && (parts.inR.style.transform = 'translate(' + eR[0].toFixed(1) + 'px,' + eR[1].toFixed(1) + 'px)');

    if (gl) {
      let n = 0;
      const put = (cx, cy, r, a, sx, sy, wob, wang) => {
        if (a <= 0.002 || n >= MAX) return;
        blobData.set([cx, cy, r, a], n * 4); shapeData.set([sx, sy, wob, wang], n * 4); n++;
      };
      PIECES.forEach((pc, i) => { const s = ease('pc' + i, offv(pc[0], pc[1], 1, w), dt); put(pc[0] + s[0], pc[1] + s[1], pc[2], 1, 1, 1, 0, 0); });
      const wob = (T, seed) => [still ? 0 : 0.045 * Math.sin(2 * Math.PI * t / T + seed), seed + t * 0.35];
      BLOBS.forEach((b, i) => {
        const r = b[2] / 2, cx = b[0] + r, cy = b[1] + r;
        if (b[3] === 'gd' || b[3] === 'gd2') {
          const d = b[3] === 'gd' ? drip(t, 6.5, 0) : drip(t, 8, 2.2);
          put(cx + d[0], cy + d[1], r, 1, d[2], d[3], 0, 0);
        } else {
          const o = drift(b[3], t), wv = wob(DRIFT[b[3]][3], i * 1.7);
          put(cx + o[0], cy + o[1], r, 1, 1, 1, wv[0], wv[1]);
        }
      });
      const satA = 1 - fo;
      SATS.forEach((b, i) => {
        const r = b[2] / 2, o = drift(b[3], t), wv = wob(DRIFT[b[3]][3], 3 + i * 1.3);
        put(b[0] + r + o[0], b[1] + r + o[1], r, satA, 1, 1, wv[0], wv[1]);
      });
      // ears follow the head turn and the mouse
      [EARS.L, EARS.R].forEach((tri, e) => {
        const off = e ? eR : eL;
        tri.forEach((v, j) => { const q = headPoint(v[0] + off[0], v[1] + off[1], h); triData[(e * 3 + j) * 2] = q[0]; triData[(e * 3 + j) * 2 + 1] = q[1]; });
        const xs = tri.map((v) => v[0]), ys = tri.map((v) => v[1]);
        const bx = Math.min(...xs), by = Math.min(...ys), bw = Math.max(...xs) - bx, bh = Math.max(...ys) - by;
        const c = headPoint(bx + 0.35 * bw + off[0], by + 0.3 * bh + off[1], h);
        earG.set([c[0], c[1], 0.8 * bw, 0.8 * bh], e * 4);
      });

      resize();
      gl.viewport(0, 0, canvas.width, canvas.height);
      // only shade the area Bucky can cover
      const k = canvas.width / 1280, x0 = Math.max(0, (w[0] + 560 * w[2]) * k), y1 = Math.min(canvas.height, (w[1] + 900 * w[2]) * k);
      gl.scissor(Math.floor(x0), Math.floor(canvas.height - y1), canvas.width, canvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(loc.uRes, canvas.width, canvas.height);
      gl.uniform3f(loc.uPose, w[0], w[1], w[2]);
      st.w = w; st.n = n;
      gl.uniform4fv(loc.uBlob, blobData); gl.uniform4fv(loc.uShape, shapeData);
      gl.uniform1i(loc.uCount, n);
      gl.uniform2fv(loc.uTri, triData); gl.uniform1f(loc.uEar, fo); gl.uniform4fv(loc.uEarG, earG);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    requestAnimationFrame(frame);
  }

  function turn() {
    const r = (lo, hi) => lo + Math.random() * (hi - lo);
    head.go([r(-12, 12), r(-22, 22), r(-8, 8)], performance.now());
    setTimeout(turn, r(1600, 3400));
  }

  function burst() {
    st.down = true;
    clearTimeout(st.pop);
    st.pop = setTimeout(() => { st.down = false; }, 320);
  }

  function setPose(p) {
    if (!POSES[p] || (p === st.pose && pose.to[2] === POSES[p].k)) return;
    st.pose = p;
    const w = POSES[p], now = performance.now();
    pose.go([w.tx, w.ty, w.k], now);
    faceOn.go(p === 'signin' ? 0 : 1, now);
  }

  // ?fps shows a frame counter in the corner (add ?legacy to compare with the old SVG goo)
  function fpsMeter() {
    if (!/[?&]fps\b/.test(location.search)) return;
    const el = document.createElement('div');
    Object.assign(el.style, { position: 'fixed', right: '8px', top: '8px', zIndex: 99, font: '12px monospace', color: '#FFFCF2', background: 'rgba(0,0,0,.6)', padding: '4px 8px', borderRadius: '4px' });
    document.body.appendChild(el);
    let n = 0, t = performance.now();
    (function tick(now) { n++; if (now - t >= 1000) { el.textContent = (gl ? 'WebGL' : 'SVG') + ' \u00b7 ' + Math.round(n * 1000 / (now - t)) + ' fps'; n = 0; t = now; } requestAnimationFrame(tick); })(t);
  }

  function init() {
    stage = document.getElementById('stage');
    root = document.getElementById('bucky');
    if (/[?&]legacy\b/.test(location.search) || !makeGL()) { window.Bucky = window.BuckyLegacy; fpsMeter(); return window.BuckyLegacy.init(); }
    fpsMeter();
    stage.insertBefore(canvas, root);
    // the goo is the canvas now: hide the SVG-filtered layer and stop the CSS motion
    const liquid = root.querySelector('[style*="url(#liquid)"]');
    if (liquid) liquid.style.display = 'none';
    const css = document.createElement('style');
    css.textContent = '#bucky,.facevis,.sat,[data-part],[data-piece],[data-head]{transition:none!important}';
    document.head.appendChild(css);
    document.querySelectorAll('[data-part]').forEach((el) => { parts[el.dataset.part] = el; });
    heads = [...document.querySelectorAll('[data-head="face"]')];
    vis = [...document.querySelectorAll('.facevis')].filter((v) => v.dataset.head === 'face');
    heads.forEach((el) => { el.style.transformOrigin = '120px 70px'; });
    stage.addEventListener('mousemove', (e) => {
      const r = stage.getBoundingClientRect(), k = 1280 / r.width;
      st.hover = true; st.mx = (e.clientX - r.left) * k; st.my = (e.clientY - r.top) * k;
    });
    stage.addEventListener('mouseleave', () => { st.hover = false; });
    stage.addEventListener('mousedown', () => { const n = Date.now(); if (n - st.lastPop < 500) return; st.lastPop = n; burst(); });
    const w = POSES.signin;
    pose.from = pose.to = [w.tx, w.ty, w.k];
    window.addEventListener('resize', resize);
    resize();
    if (!still) turn();
    requestAnimationFrame(frame);
  }

  // is this screen point on Bucky's goo? (used for the poke sound)
  function hit(clientX, clientY) {
    if (!stage || !st.n) return false;
    const r = stage.getBoundingClientRect(), k = 1280 / r.width;
    const x = ((clientX - r.left) * k - st.w[0]) / st.w[2], y = ((clientY - r.top) * k - st.w[1]) / st.w[2];
    for (let i = 0; i < st.n; i++) {
      const cx = blobData[i * 4], cy = blobData[i * 4 + 1], rr = blobData[i * 4 + 2] * 1.1;
      if ((x - cx) * (x - cx) + (y - cy) * (y - cy) < rr * rr) return true;
    }
    return false;
  }

  window.Bucky = { init: () => init(), setPose: (p) => (window.Bucky === api ? setPose(p) : window.Bucky.setPose(p)), burst: () => burst(), hit: (x, y) => hit(x, y) };
  const api = window.Bucky;
})();
