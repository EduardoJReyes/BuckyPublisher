// Bucky sounds, made on the fly with Web Audio (no files to load).
// Sound.tink() glass tap, Sound.pour(ms) liquid filling, Sound.boing() Bucky poke, Sound.success() sent chime.
(function () {
  let ctx = null, master = null;
  const KEY = 'bucky.sound';
  let on = true;
  try { on = localStorage.getItem(KEY) !== 'off'; } catch (e) {}

  function ac() {
    if (!on) return null;
    if (!ctx) {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      ctx = new C();
      master = ctx.createGain(); master.gain.value = 0.55;
      const comp = ctx.createDynamicsCompressor();
      master.connect(comp); comp.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  // browsers only allow audio after the first click or key
  ['pointerdown', 'keydown'].forEach((ev) => window.addEventListener(ev, () => { if (on) ac(); }, { once: true, capture: true }));

  function env(g, t, a, peak, d) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }
  function tone(freq, t, peak, dur, type, dest) {
    const c = ctx, o = c.createOscillator(), g = c.createGain();
    o.type = type || 'sine'; o.frequency.setValueAtTime(freq, t);
    env(g, t, 0.004, peak, dur);
    o.connect(g); g.connect(dest || master);
    o.start(t); o.stop(t + dur + 0.05);
    return o;
  }

  // glass tap: a few inharmonic partials that ring and fade, slightly different each time
  function tink(soft) {
    const c = ac(); if (!c) return;
    const t = c.currentTime + 0.005, f = 1900 * (0.94 + Math.random() * 0.12), v = soft ? 0.05 : 0.09;
    [[1, 1, 0.35], [2.76, 0.45, 0.22], [5.4, 0.2, 0.12], [8.9, 0.08, 0.07]].forEach((p) => tone(f * p[0], t, v * p[1], p[2]));
  }

  // one bubble: a sine that sweeps up fast, like a drop popping in water
  function bubble(t, f0, vol) {
    const c = ctx, o = c.createOscillator(), g = c.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f0 * 2.6, t + 0.06);
    env(g, t, 0.006, vol, 0.07);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + 0.12);
  }
  // liquid filling up: soft filtered noise under bubbles that rise in pitch as it fills
  function pour(ms) {
    const c = ac(); if (!c) return;
    const dur = Math.max(0.4, (ms || 1600) / 1000), t0 = c.currentTime + 0.02;
    const len = Math.floor(c.sampleRate * dur), buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource(); src.buffer = buf;
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(380, t0); bp.frequency.exponentialRampToValueAtTime(1400, t0 + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.05, t0 + 0.12);
    g.gain.setValueAtTime(0.05, t0 + dur * 0.75); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(bp); bp.connect(g); g.connect(master);
    src.start(t0); src.stop(t0 + dur);
    let t = t0 + 0.05;
    while (t < t0 + dur - 0.05) {
      const k = (t - t0) / dur;
      bubble(t, 260 + 520 * k + Math.random() * 120, 0.05 + Math.random() * 0.04);
      t += 0.045 + Math.random() * 0.09 * (1 - k * 0.5);
    }
  }

  // Bucky poke: a wobbly rubbery boing plus a little blorp
  function boing() {
    const c = ac(); if (!c) return;
    const t = c.currentTime + 0.005;
    const o = c.createOscillator(), g = c.createGain(), lfo = c.createOscillator(), lg = c.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(420, t + 0.09);
    o.frequency.exponentialRampToValueAtTime(190, t + 0.5);
    lfo.frequency.setValueAtTime(18, t); lfo.frequency.linearRampToValueAtTime(7, t + 0.5);
    lg.gain.setValueAtTime(45, t); lg.gain.linearRampToValueAtTime(10, t + 0.5);
    lfo.connect(lg); lg.connect(o.frequency);
    env(g, t, 0.01, 0.22, 0.5);
    o.connect(g); g.connect(master);
    o.start(t); lfo.start(t); o.stop(t + 0.6); lfo.stop(t + 0.6);
    bubble(t + 0.06, 300, 0.12); bubble(t + 0.16, 420, 0.08);
  }

  // sent: a rising glassy arpeggio
  function success() {
    const c = ac(); if (!c) return;
    const t = c.currentTime + 0.01;
    [1046.5, 1318.5, 1568, 2093].forEach((f, i) => {
      const s = t + i * 0.085;
      tone(f, s, 0.1, 0.7 - i * 0.08);
      tone(f * 2.76, s, 0.025, 0.25);
    });
    tone(523.25, t, 0.05, 0.9, 'triangle');
  }

  function setOn(v) {
    on = !!v;
    try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch (e) {}
    if (on) tink();
  }

  window.Sound = { tink, pour, boing, success, setOn, isOn: () => on };
})();
