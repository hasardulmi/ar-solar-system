/*
 * common.js — shared utilities for AR Solar System Explorer (marker.html + markerless.html)
 *
 * Kept as plain, dependency-free browser JS (no bundler) so the project stays a simple
 * static site that can be dropped straight onto GitHub Pages / Netlify.
 *
 *  - fetchWithProgress()   real byte-level download progress for large .glb files
 *  - SpaceAudio            procedural WebAudio engine (ambient pad + SFX) — no audio files
 *  - GestureController     pinch-to-scale / drag-to-rotate / tap / double-tap on a DOM element
 *  - vibrate()             safe haptics wrapper
 */

/* ---------------------------------------------------------------- */
/* Haptics                                                            */
/* ---------------------------------------------------------------- */
export function vibrate(pattern) {
  if (navigator.vibrate) {
    try { navigator.vibrate(pattern); } catch (e) { /* no-op */ }
  }
}

/* ---------------------------------------------------------------- */
/* Streaming download with real progress (falls back gracefully)     */
/* ---------------------------------------------------------------- */
export async function fetchWithProgress(url, onChunk) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  const total = Number(res.headers.get('Content-Length')) || 0;

  if (!res.body || !res.body.getReader) {
    // Older browsers without streaming support — just wait for the whole thing.
    const blob = await res.blob();
    onChunk(blob.size || total, blob.size || total);
    return blob;
  }

  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onChunk(loaded, total);
  }
  return new Blob(chunks);
}

/** Downloads several .glb files in parallel, reporting combined 0..1 progress. */
export async function preloadModels(files, onProgress) {
  const loaded = new Array(files.length).fill(0);
  const totals = new Array(files.length).fill(0);
  const report = () => {
    const sumLoaded = loaded.reduce((a, b) => a + b, 0);
    const sumTotal = totals.reduce((a, b) => a + b, 0);
    onProgress(sumTotal > 0 ? sumLoaded / sumTotal : 0);
  };
  const results = await Promise.all(files.map((f, i) =>
    fetchWithProgress(f.url, (l, t) => {
      loaded[i] = l;
      totals[i] = t || Math.max(totals[i], l);
      report();
    }).then((blob) => ({ id: f.id, url: URL.createObjectURL(blob) }))
  ));
  onProgress(1);
  return results;
}

/* ---------------------------------------------------------------- */
/* Procedural audio engine — ambient pad + sound effects              */
/* No external audio files: everything is synthesised with            */
/* oscillators/noise so the project has zero binary audio assets      */
/* and zero licensing concerns.                                       */
/* ---------------------------------------------------------------- */
export class SpaceAudio {
  /**
   * @param {AudioContext} [sharedCtx] Pass an existing AudioContext (e.g. the
   *   one backing a THREE.AudioListener) so nodes built here can be handed
   *   to THREE.PositionalAudio via setNodeSource() — WebAudio nodes cannot
   *   be connected across two different AudioContext instances.
   */
  constructor(sharedCtx = null) {
    this.ctx = sharedCtx;
    this.ready = false;
    this.master = null;
    this.padGain = null;
  }

  /** Must be called from a user gesture (tap/click) due to autoplay policy. */
  enable() {
    if (this.ready) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
    this.ctx = ctx;
    if (ctx.state === 'suspended') ctx.resume();

    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(ctx.destination);

    this._buildAmbientPad();
    this._buildProximityDrone();

    this.ready = true;
  }

  _buildAmbientPad() {
    const ctx = this.ctx;
    const pad = ctx.createGain();
    pad.gain.value = 0.05;
    pad.connect(this.master);
    this.padGain = pad;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 500;
    filter.connect(pad);

    // Three detuned low oscillators = a soft, evolving drone.
    const freqs = [55, 55 * 1.5, 55 * 2.01];
    this.padOscillators = freqs.map((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = i === 0 ? 'sine' : 'triangle';
      osc.frequency.value = f;
      osc.connect(filter);
      osc.start();
      return osc;
    });

    // Slow LFO sweeping the filter cutoff for a subtle "alive" feel.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.05;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 250;
    lfo.connect(lfoGain);
    lfoGain.connect(filter.frequency);
    lfo.start();
  }

  _buildProximityDrone() {
    const ctx = this.ctx;
    const osc1 = ctx.createOscillator();
    osc1.type = 'sine';
    osc1.frequency.value = 130;
    const osc2 = ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.value = 130 * 1.5;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 800;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc1.connect(filter);
    osc2.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    osc1.start();
    osc2.start();
    this.drone = { osc1, osc2, filter, gain };
  }

  /** closeness: 0 (far) .. 1 (very close) */
  setProximity(closeness) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const volume = 0.12 + closeness * 0.32;
    const filterFreq = 400 + closeness * 1200;
    const pitch = 120 + closeness * 40;
    this.drone.gain.gain.setTargetAtTime(volume, t, 0.25);
    this.drone.filter.frequency.setTargetAtTime(filterFreq, t, 0.25);
    this.drone.osc1.frequency.setTargetAtTime(pitch, t, 0.25);
    this.drone.osc2.frequency.setTargetAtTime(pitch * 1.5, t, 0.25);
  }

  muteProximity() {
    if (!this.ready) return;
    this.drone.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.3);
  }

  /** Short pitch-swept blip — used for UI taps / jump takeoff+landing. */
  blip(freqStart, freqEnd, duration, gain = 0.3) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freqStart, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(freqEnd, 1), t0 + duration);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(g);
    g.connect(this.master);
    osc.start(t0);
    osc.stop(t0 + duration + 0.05);
  }

  /** Filtered noise burst + pitch sweep — a satisfying "whoosh" for jumps/dashes. */
  whoosh(duration = 0.35, up = true) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const bufferSize = Math.floor(ctx.sampleRate * duration);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 0.8;
    filter.frequency.setValueAtTime(up ? 300 : 2200, t0);
    filter.frequency.exponentialRampToValueAtTime(up ? 2200 : 300, t0 + duration);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.35, t0 + duration * 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

    noise.connect(filter);
    filter.connect(g);
    g.connect(this.master);
    noise.start(t0);
    noise.stop(t0 + duration + 0.05);
  }

  /** Pleasant multi-partial "chime" — target found, selection, trick success. */
  chime(baseFreq = 660) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    [1, 1.5, 2].forEach((mult, i) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = baseFreq * mult;
      const start = t0 + i * 0.05;
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.18 / (i + 1), start + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 0.9);
      osc.connect(g);
      g.connect(this.master);
      osc.start(start);
      osc.stop(start + 1);
    });
  }
}

/* ---------------------------------------------------------------- */
/* Gesture controller — pinch to scale, drag to rotate, tap/dbl-tap   */
/* ---------------------------------------------------------------- */
export class GestureController {
  /**
   * @param {HTMLElement} el          element to listen on (e.g. renderer.domElement or document.body)
   * @param {Object} opts
   * @param {()=>number} opts.getScale / (s)=>void opts.setScale
   * @param {()=>number} opts.getRotationY / (r)=>void opts.setRotationY
   * @param {[number,number]} opts.scaleRange
   * @param {(x:number,y:number)=>void} [opts.onTap]
   * @param {(x:number,y:number)=>void} [opts.onDoubleTap]
   * @param {()=>void} [opts.onGestureStart] called the first time any touch begins (good place to enable audio)
   */
  constructor(el, opts) {
    this.el = el;
    this.opts = opts;
    this.pointers = new Map();
    this.mode = 'idle'; // idle | maybe-drag | drag | pinch
    this.startDist = 0;
    this.startScale = 1;
    this.startRotation = 0;
    this.startX = 0;
    this.lastTapTime = 0;
    this.lastTapPos = { x: 0, y: 0 };
    this.moved = 0;

    el.addEventListener('pointerdown', this._onDown.bind(this), { passive: true });
    el.addEventListener('pointermove', this._onMove.bind(this), { passive: false });
    window.addEventListener('pointerup', this._onUp.bind(this), { passive: true });
    window.addEventListener('pointercancel', this._onUp.bind(this), { passive: true });
  }

  _dist() {
    const pts = [...this.pointers.values()];
    const dx = pts[0].x - pts[1].x;
    const dy = pts[0].y - pts[1].y;
    return Math.hypot(dx, dy);
  }

  _onDown(e) {
    if (this.pointers.size === 0 && this.opts.onGestureStart) this.opts.onGestureStart();
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.moved = 0;
    if (this.pointers.size === 1) {
      this.mode = 'maybe-drag';
      this.startX = e.clientX;
      this.startRotation = this.opts.getRotationY();
    } else if (this.pointers.size === 2) {
      this.mode = 'pinch';
      this.startDist = this._dist();
      this.startScale = this.opts.getScale();
    }
  }

  _onMove(e) {
    if (!this.pointers.has(e.pointerId)) return;
    const prev = this.pointers.get(e.pointerId);
    this.moved += Math.hypot(e.clientX - prev.x, e.clientY - prev.y);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.mode === 'pinch' && this.pointers.size === 2) {
      e.preventDefault();
      const dist = this._dist();
      const ratio = dist / Math.max(this.startDist, 1);
      const [min, max] = this.opts.scaleRange;
      const next = Math.min(max, Math.max(min, this.startScale * ratio));
      this.opts.setScale(next);
    } else if (this.pointers.size === 1) {
      if (this.moved > 8) {
        if (this.mode === 'maybe-drag') this.mode = 'drag';
        if (this.mode === 'drag') {
          e.preventDefault();
          const dx = e.clientX - this.startX;
          this.opts.setRotationY(this.startRotation + dx * 0.01);
        }
      }
    }
  }

  _onUp(e) {
    const wasSingleTap = this.pointers.size <= 1 && this.moved < 8 && this.mode !== 'pinch';
    this.pointers.delete(e.pointerId);

    if (this.pointers.size === 0) {
      if (wasSingleTap) {
        const now = performance.now();
        const dt = now - this.lastTapTime;
        const dd = Math.hypot(e.clientX - this.lastTapPos.x, e.clientY - this.lastTapPos.y);
        if (dt < 320 && dd < 40 && this.opts.onDoubleTap) {
          this.opts.onDoubleTap(e.clientX, e.clientY);
          this.lastTapTime = 0;
        } else {
          if (this.opts.onTap) this.opts.onTap(e.clientX, e.clientY);
          this.lastTapTime = now;
          this.lastTapPos = { x: e.clientX, y: e.clientY };
        }
      }
      this.mode = 'idle';
    } else if (this.pointers.size === 1) {
      // Dropped from pinch back to a single finger — restart drag baseline.
      const [remaining] = this.pointers.values();
      this.mode = 'maybe-drag';
      this.startX = remaining.x;
      this.startRotation = this.opts.getRotationY();
    }
  }
}
