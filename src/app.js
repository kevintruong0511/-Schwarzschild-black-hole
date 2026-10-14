/* GARGANTUA — engine (workstream B)
 *
 * WebGL2 host for the black hole renderer: shader loading, HDR scene FBO,
 * bloom chain, composite/tone-map pass, orbit camera, control binding, HUD.
 * Plain ES2020 classic script wrapped in an IIFE; works from a dev http server
 * (<script src="src/app.js">) and when inlined into dist/index.html (file://).
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants, defaults, presets
  // ---------------------------------------------------------------------------

  const DEG = Math.PI / 180;
  const MAX_DPR = 2;
  const MIN_DIST = 2.6;
  const MAX_DIST = 400;
  const MAX_PITCH = 89 * DEG;
  const BLOOM_LEVELS = 5;          // mip0 (half res) + 4 downsamples
  const BLOOM_THRESHOLD = 1.0;
  const BLOOM_KNEE = 0.5;
  const ORBIT_SPEED = 0.005;       // rad per CSS px dragged
  const ORBIT_DAMPING = 6.5;       // 1/s, exp(-6.5) ≈ 0.9^60 per second
  const MAX_ORBIT_VEL = 8;         // rad/s cap on flick inertia
  const KEY_ORBIT_RATE = 1.2;      // rad/s
  const KEY_DOLLY_RATE = 1.0;      // ln(distance)/s
  const PRESET_DURATION = 1.2;     // s
  const HUD_INTERVAL = 0.25;       // s

  /** Control id → param key, plus formatting metadata. */
  const CONTROLS = {
    'ctl-diskInner':      { key: 'diskInner',      def: 6,    fmt: v => v.toFixed(1) },
    'ctl-diskOuter':      { key: 'diskOuter',      def: 18,   fmt: v => v.toFixed(1) },
    'ctl-diskBrightness': { key: 'diskBrightness', def: 1,    fmt: v => v.toFixed(2) },
    'ctl-diskTemp':       { key: 'diskTemp',       def: 7000, fmt: v => Math.round(v) + ' K' },
    'ctl-turbulence':     { key: 'turbulence',     def: 0.6,  fmt: v => v.toFixed(2) },
    'ctl-starBrightness': { key: 'starBrightness', def: 1,    fmt: v => v.toFixed(2) },
    'ctl-exposure':       { key: 'exposure',       def: 1,    fmt: v => v.toFixed(2) },
    'ctl-bloom':          { key: 'bloom',          def: 0.4,  fmt: v => v.toFixed(2) },
    'ctl-fov':            { key: 'fov',            def: 60,   fmt: v => Math.round(v) + '°' },
    'ctl-steps':          { key: 'steps',          def: 320,  fmt: v => String(Math.round(v)) },
    'ctl-timeScale':      { key: 'timeScale',      def: 8,    fmt: v => v.toFixed(1) + ' M/s' },
    'ctl-quality':        { key: 'quality',        def: 0.75, fmt: v => v + '×' },
    'ctl-lensing':        { key: 'lensing',        def: 1,    bool: true },
    'ctl-doppler':        { key: 'doppler',        def: 1,    bool: true },
    'ctl-redshift':       { key: 'redshift',       def: 1,    bool: true },
    'ctl-camRedshift':    { key: 'camRedshift',    def: 1,    bool: true },
    'ctl-pause':          { key: 'pause',          def: 0,    bool: true },
  };

  const CAMERA_DEFAULTS = { distance: 32, yaw: Math.PI / 2, pitch: 10 * DEG, fov: 60 };

  /** Presets in keyboard order 1–5. Fields the contract leaves open use defaults. */
  const PRESET_ORDER = ['interstellar', 'edge', 'top', 'far', 'close'];
  const PRESETS = {
    interstellar: { distance: 32,  pitch: 10 * DEG, fov: 60 },
    edge:         { distance: 30,  pitch: 1 * DEG,  fov: 60 },
    top:          { distance: 40,  pitch: 80 * DEG, fov: 60 },
    far:          { distance: 120, pitch: 10 * DEG, fov: 40 },
    close:        { distance: 9,   pitch: 20 * DEG, fov: 90 },
  };

  // ---------------------------------------------------------------------------
  // Built-in shaders (GLSL ES 3.00)
  // ---------------------------------------------------------------------------

  /** Fullscreen triangle driven by gl_VertexID; no vertex buffer needed. */
  const VERT_SRC = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID & 1) << 2) - 1.0, float((gl_VertexID & 2) << 1) - 1.0);
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

  /** 13-tap downsample (Jimenez, "Next Generation Post Processing in Call of Duty"). */
  const DOWNSAMPLE_FN = `
vec3 tap(sampler2D t, vec2 uv) {
  vec3 c = texture(t, uv).rgb;
  if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);
  return max(c, vec3(0.0));
}
vec3 downsample13(sampler2D t, vec2 uv, vec2 texel) {
  vec3 a = tap(t, uv + texel * vec2(-2.0, -2.0));
  vec3 b = tap(t, uv + texel * vec2( 0.0, -2.0));
  vec3 c = tap(t, uv + texel * vec2( 2.0, -2.0));
  vec3 d = tap(t, uv + texel * vec2(-2.0,  0.0));
  vec3 e = tap(t, uv);
  vec3 f = tap(t, uv + texel * vec2( 2.0,  0.0));
  vec3 g = tap(t, uv + texel * vec2(-2.0,  2.0));
  vec3 h = tap(t, uv + texel * vec2( 0.0,  2.0));
  vec3 i = tap(t, uv + texel * vec2( 2.0,  2.0));
  vec3 j = tap(t, uv + texel * vec2(-1.0, -1.0));
  vec3 k = tap(t, uv + texel * vec2( 1.0, -1.0));
  vec3 l = tap(t, uv + texel * vec2(-1.0,  1.0));
  vec3 m = tap(t, uv + texel * vec2( 1.0,  1.0));
  return e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
}`;

  /** Bright pass: 13-tap filtered fetch from the scene, soft-knee threshold. */
  const BRIGHT_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uThreshold;
uniform float uKnee;
out vec4 fragColor;
${DOWNSAMPLE_FN}
void main() {
  vec3 c = downsample13(uSrc, vUv, uTexel);
  float br = max(c.r, max(c.g, c.b));
  float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-5);
  float w = max(soft, br - uThreshold) / max(br, 1e-5);
  fragColor = vec4(c * w, 1.0);
}`;

  const DOWN_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uTexel;
out vec4 fragColor;
${DOWNSAMPLE_FN}
void main() { fragColor = vec4(downsample13(uSrc, vUv, uTexel), 1.0); }`;

  /** Upsample: base (same res) + 3x3 tent of the lower-res level, summed in-shader. */
  const UP_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSrc;   // lower-resolution level
uniform sampler2D uBase;  // same-resolution level to add onto
uniform vec2 uTexel;      // 1 / size of uSrc
out vec4 fragColor;
void main() {
  vec3 s = vec3(0.0);
  s += texture(uSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  s += texture(uSrc, vUv + uTexel * vec2( 0.0, -1.0)).rgb * 2.0;
  s += texture(uSrc, vUv + uTexel * vec2( 1.0, -1.0)).rgb;
  s += texture(uSrc, vUv + uTexel * vec2(-1.0,  0.0)).rgb * 2.0;
  s += texture(uSrc, vUv).rgb * 4.0;
  s += texture(uSrc, vUv + uTexel * vec2( 1.0,  0.0)).rgb * 2.0;
  s += texture(uSrc, vUv + uTexel * vec2(-1.0,  1.0)).rgb;
  s += texture(uSrc, vUv + uTexel * vec2( 0.0,  1.0)).rgb * 2.0;
  s += texture(uSrc, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
  fragColor = vec4(texture(uBase, vUv).rgb + s * (1.0 / 16.0), 1.0);
}`;

  /** Composite: scene + bloom, exposure, ACES (Narkowicz), vignette, gamma, dither. */
  const COMPOSITE_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uBloomStrength;
uniform float uExposure;
out vec4 fragColor;
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void main() {
  vec3 c = texture(uScene, vUv).rgb;
  if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);
  c = max(c, vec3(0.0)) + texture(uBloom, vUv).rgb * uBloomStrength;
  c *= uExposure;
  c = aces(c);
  vec2 q = vUv - 0.5;
  c *= 1.0 - 0.25 * smoothstep(0.1, 1.0, dot(q, q) * 2.0);
  c = pow(c, vec3(1.0 / 2.2));
  c += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  fragColor = vec4(c, 1.0);
}`;

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------

  const warned = new Set();
  function $(id) {
    const el = document.getElementById(id);
    if (!el && !warned.has(id)) {
      warned.add(id);
      console.warn('[BH] missing element #' + id);
    }
    return el;
  }

  function showError(message) {
    console.error('[BH] ' + message);
    const el = $('error');
    if (el) {
      el.textContent = message;
      el.hidden = false;
      el.removeAttribute('hidden');
      el.classList.remove('hidden');
      if (getComputedStyle(el).display === 'none') el.style.display = 'block';
    }
    hideLoading();
  }

  function hideLoading() {
    const el = $('loading');
    if (el) {
      el.classList.add('hidden');
      el.style.display = 'none';
    }
  }

  /** Scene shader source: inline <script> text (built) or fetched (dev server). */
  async function loadShaderSource(id) {
    const el = document.getElementById(id);
    if (!el) throw new Error('Shader element #' + id + ' not found.');
    const inline = el.textContent.trim();
    if (inline) return inline;
    const src = el.dataset.src;
    if (!src) throw new Error('Shader element #' + id + ' has no content and no data-src.');
    const res = await fetch(src);
    if (!res.ok) throw new Error('Failed to fetch ' + src + ': HTTP ' + res.status);
    return res.text();
  }

  // ---------------------------------------------------------------------------
  // GL helpers
  // ---------------------------------------------------------------------------

  /** Pretty-print a compile log with a numbered excerpt around each error line. */
  function formatShaderLog(log, source, label) {
    const lines = source.split('\n');
    const out = [label + ' shader failed to compile:', log.trim()];
    const seen = new Set();
    const re = /ERROR:\s*\d+:(\d+)/g;
    let m;
    while ((m = re.exec(log)) !== null) {
      const ln = parseInt(m[1], 10);
      if (seen.has(ln)) continue;
      seen.add(ln);
      out.push('');
      for (let i = Math.max(1, ln - 3); i <= Math.min(lines.length, ln + 3); i++) {
        out.push((i === ln ? '>> ' : '   ') + String(i).padStart(4) + ' | ' + lines[i - 1]);
      }
    }
    return out.join('\n');
  }

  function compileShader(gl, type, source, label) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      const msg = formatShaderLog(gl.getShaderInfoLog(sh) || '(no log)', source, label);
      gl.deleteShader(sh);
      throw new Error(msg);
    }
    return sh;
  }

  /** Link a program and cache every active uniform location in `.u`. */
  function createProgram(gl, vsSrc, fsSrc, label) {
    const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc, label + ' (vertex)');
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc, label + ' (fragment)');
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS) && !gl.isContextLost()) {
      const log = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error(label + ' program failed to link:\n' + log);
    }
    const u = {};
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(prog, i);
      if (info) u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(prog, info.name);
    }
    return { prog, u };
  }

  // ---------------------------------------------------------------------------
  // Engine
  // ---------------------------------------------------------------------------

  function main() {
    const canvas = $('canvas');
    if (!canvas) { showError('No <canvas id="canvas"> element found.'); return; }

    const gl = canvas.getContext('webgl2', {
      antialias: false, alpha: false, powerPreference: 'high-performance',
      preserveDrawingBuffer: false, depth: false, stencil: false,
    });
    if (!gl) {
      showError('WebGL2 is not available in this browser. Gargantua needs WebGL2 ' +
        '(Chrome 56+, Firefox 51+, Safari 15+). Check that hardware acceleration is enabled.');
      return;
    }

    // --- state -------------------------------------------------------------
    const params = {};
    for (const id in CONTROLS) params[CONTROLS[id].key] = CONTROLS[id].def;

    const camera = {
      distance: CAMERA_DEFAULTS.distance, yaw: CAMERA_DEFAULTS.yaw, pitch: CAMERA_DEFAULTS.pitch,
      velYaw: 0, velPitch: 0,
      pos: new Float32Array(3), basis: new Float32Array(9),
      anim: null,
    };

    const clock = { time: 0, last: 0, frames: 0, hudFrames: 0, hudTime: 0, fps: 0, checkFrames: 3, loadingHidden: false };
    const size = { cssW: 0, cssH: 0, dbW: 0, dbH: 0, sceneW: 0, sceneH: 0, dirty: true };
    const keys = new Set();
    let sceneSource = null;
    let res = null;            // GL resources (programs, textures, FBOs, VAO)
    let rafId = 0;
    let running = false;
    let screenshotPending = false;
    let hdr = false;

    // --- GL resources --------------------------------------------------------
    function createTexture(w, h) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (hdr) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      return tex;
    }

    function createTarget(w, h) {
      const tex = createTexture(w, h);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        gl.deleteTexture(tex); gl.deleteFramebuffer(fbo);
        throw new Error('Framebuffer incomplete: 0x' + status.toString(16));
      }
      return { tex, fbo, w, h };
    }

    function deleteTarget(t) { if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); } }

    function destroyTargets() {
      if (!res) return;
      deleteTarget(res.scene);
      res.mips.forEach(deleteTarget);
      res.ups.forEach(deleteTarget);
      res.scene = null; res.mips = []; res.ups = [];
    }

    /** (Re)create scene + bloom render targets for the current size. */
    function createTargets() {
      destroyTargets();
      const build = () => {
        res.scene = createTarget(size.sceneW, size.sceneH);
        let w = size.sceneW, h = size.sceneH;
        for (let i = 0; i < BLOOM_LEVELS; i++) {
          w = Math.max(1, w >> 1); h = Math.max(1, h >> 1);
          res.mips.push(createTarget(w, h));
          if (i < BLOOM_LEVELS - 1) res.ups.push(createTarget(w, h));
        }
      };
      try {
        build();
      } catch (e) {
        if (!hdr) throw e;
        console.warn('[BH] RGBA16F targets unavailable (' + e.message + '); falling back to RGBA8.');
        hdr = false;
        destroyTargets();
        build();
      }
    }

    function initGL() {
      hdr = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
      if (!hdr) console.warn('[BH] EXT_color_buffer_float missing: rendering without HDR targets.');
      res = {
        scene: null, mips: [], ups: [],
        vao: gl.createVertexArray(),
        sceneProg: createProgram(gl, VERT_SRC, sceneSource, 'Scene'),
        brightProg: createProgram(gl, VERT_SRC, BRIGHT_SRC, 'Bloom bright-pass'),
        downProg: createProgram(gl, VERT_SRC, DOWN_SRC, 'Bloom downsample'),
        upProg: createProgram(gl, VERT_SRC, UP_SRC, 'Bloom upsample'),
        compProg: createProgram(gl, VERT_SRC, COMPOSITE_SRC, 'Composite'),
      };
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.disable(gl.CULL_FACE);
      gl.clearColor(0, 0, 0, 1);
      size.dirty = true;
    }

    // --- sizing --------------------------------------------------------------
    function updateSize() {
      const cssW = Math.max(1, window.innerWidth);
      const cssH = Math.max(1, window.innerHeight);
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      const dbW = Math.max(1, Math.floor(cssW * dpr));
      const dbH = Math.max(1, Math.floor(cssH * dpr));
      const scale = params.quality || 1;
      const sceneW = Math.max(1, Math.floor(dbW * scale));
      const sceneH = Math.max(1, Math.floor(dbH * scale));
      if (cssW !== size.cssW || cssH !== size.cssH) {
        canvas.style.width = cssW + 'px';
        canvas.style.height = cssH + 'px';
      }
      if (dbW !== size.dbW || dbH !== size.dbH) { canvas.width = dbW; canvas.height = dbH; }
      const targetsChanged = sceneW !== size.sceneW || sceneH !== size.sceneH || !res.scene;
      Object.assign(size, { cssW, cssH, dbW, dbH, sceneW, sceneH, dirty: false });
      if (targetsChanged) createTargets();
    }

    let resizeTimer = 0;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { size.dirty = true; }, 120);
    });

    // --- camera --------------------------------------------------------------
    function clampCamera() {
      camera.distance = Math.min(MAX_DIST, Math.max(MIN_DIST, camera.distance));
      camera.pitch = Math.min(MAX_PITCH, Math.max(-MAX_PITCH, camera.pitch));
    }

    /** Compute pos and the (right, up, forward) column-major basis. */
    function updateCameraVectors() {
      const cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch);
      const cy = Math.cos(camera.yaw), sy = Math.sin(camera.yaw);
      const p = camera.pos, b = camera.basis;
      p[0] = camera.distance * cp * cy; p[1] = camera.distance * sp; p[2] = camera.distance * cp * sy;
      // forward = normalize(-pos)
      let fx = -p[0], fy = -p[1], fz = -p[2];
      const fl = Math.hypot(fx, fy, fz) || 1;
      fx /= fl; fy /= fl; fz /= fl;
      // right = normalize(cross(forward, worldUp)); pitch is clamped so this never degenerates
      let rx = -fz, ry = 0, rz = fx;
      const rl = Math.hypot(rx, ry, rz) || 1;
      rx /= rl; rz /= rl;
      // up = cross(right, forward)
      const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;
      b[0] = rx; b[1] = ry; b[2] = rz;
      b[3] = ux; b[4] = uy; b[5] = uz;
      b[6] = fx; b[7] = fy; b[8] = fz;
    }

    function cancelAnim() { camera.anim = null; }

    function animateTo(target) {
      camera.velYaw = camera.velPitch = 0;
      camera.anim = {
        t0: performance.now() / 1000, dur: PRESET_DURATION,
        from: { distance: camera.distance, pitch: camera.pitch, yaw: camera.yaw, fov: params.fov },
        to: {
          distance: target.distance !== undefined ? target.distance : camera.distance,
          pitch: target.pitch !== undefined ? target.pitch : camera.pitch,
          yaw: target.yaw !== undefined ? target.yaw : camera.yaw,
          fov: target.fov !== undefined ? target.fov : params.fov,
        },
      };
    }

    function setPreset(name) {
      const p = PRESETS[name];
      if (!p) { console.warn('[BH] unknown preset: ' + name); return; }
      animateTo(p);
    }

    function stepCamera(dt, now) {
      const a = camera.anim;
      if (a) {
        const t = Math.min(1, (now - a.t0) / a.dur);
        const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;  // ease in-out cubic
        camera.distance = a.from.distance + (a.to.distance - a.from.distance) * e;
        camera.pitch = a.from.pitch + (a.to.pitch - a.from.pitch) * e;
        camera.yaw = a.from.yaw + (a.to.yaw - a.from.yaw) * e;
        setControl('ctl-fov', a.from.fov + (a.to.fov - a.from.fov) * e);
        if (t >= 1) camera.anim = null;
      } else {
        // keyboard orbit / dolly
        if (keys.has('ArrowLeft')) camera.yaw += KEY_ORBIT_RATE * dt;
        if (keys.has('ArrowRight')) camera.yaw -= KEY_ORBIT_RATE * dt;
        if (keys.has('ArrowUp')) camera.pitch += KEY_ORBIT_RATE * dt;
        if (keys.has('ArrowDown')) camera.pitch -= KEY_ORBIT_RATE * dt;
        if (keys.has('+') || keys.has('=')) camera.distance *= Math.exp(-KEY_DOLLY_RATE * dt);
        if (keys.has('-') || keys.has('_')) camera.distance *= Math.exp(KEY_DOLLY_RATE * dt);
        // inertia when not dragging
        if (!drag.active) {
          camera.yaw += camera.velYaw * dt;
          camera.pitch += camera.velPitch * dt;
          const damp = Math.exp(-ORBIT_DAMPING * dt);
          camera.velYaw *= damp; camera.velPitch *= damp;
          if (Math.abs(camera.velYaw) < 1e-4) camera.velYaw = 0;
          if (Math.abs(camera.velPitch) < 1e-4) camera.velPitch = 0;
        }
      }
      clampCamera();
      updateCameraVectors();
    }

    // --- input ---------------------------------------------------------------
    const pointers = new Map();   // pointerId → {x, y}
    const drag = { active: false, lastX: 0, lastY: 0, lastT: 0, pinchDist: 0 };

    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      cancelAnim();
      camera.velYaw = camera.velPitch = 0;
      if (pointers.size === 1) {
        drag.active = true;
        drag.lastX = e.clientX; drag.lastY = e.clientY; drag.lastT = performance.now();
      } else if (pointers.size === 2) {
        drag.active = false;
        drag.pinchDist = pinchDistance();
      }
      e.preventDefault();
    });

    function clampAbs(v, m) { return v > m ? m : v < -m ? -m : v; }

    function pinchDistance() {
      const it = pointers.values();
      const a = it.next().value, b = it.next().value;
      return Math.hypot(a.x - b.x, a.y - b.y);
    }

    canvas.addEventListener('pointermove', (e) => {
      const p = pointers.get(e.pointerId);
      if (!p) return;
      p.x = e.clientX; p.y = e.clientY;
      if (pointers.size === 1 && drag.active) {
        const now = performance.now();
        const dt = Math.max(1, now - drag.lastT) / 1000;
        const dx = e.clientX - drag.lastX, dy = e.clientY - drag.lastY;
        camera.yaw += dx * ORBIT_SPEED;
        camera.pitch += dy * ORBIT_SPEED;
        // velocity estimate (rad/s), lightly smoothed
        camera.velYaw = clampAbs(camera.velYaw * 0.3 + (dx * ORBIT_SPEED / dt) * 0.7, MAX_ORBIT_VEL);
        camera.velPitch = clampAbs(camera.velPitch * 0.3 + (dy * ORBIT_SPEED / dt) * 0.7, MAX_ORBIT_VEL);
        drag.lastX = e.clientX; drag.lastY = e.clientY; drag.lastT = now;
        clampCamera();
      } else if (pointers.size === 2) {
        const d = pinchDistance();
        if (drag.pinchDist > 0 && d > 0) camera.distance *= drag.pinchDist / d;
        drag.pinchDist = d;
        clampCamera();
      }
    });

    function endPointer(e) {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      if (pointers.size === 0) {
        // keep inertia only if the pointer was still moving when released
        if (performance.now() - drag.lastT > 80) camera.velYaw = camera.velPitch = 0;
        drag.active = false;
      } else if (pointers.size === 1) {
        const p = pointers.values().next().value;
        drag.active = true; drag.lastX = p.x; drag.lastY = p.y; drag.lastT = performance.now();
        camera.velYaw = camera.velPitch = 0;
      }
    }
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      cancelAnim();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
      camera.distance *= Math.exp(e.deltaY * unit * 0.0012);
      clampCamera();
    }, { passive: false });

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    /** Text-entry controls (and selects, which use letters for type-ahead): never steal keys. */
    function isTypingTarget(t) {
      if (!t || !t.tagName) return false;
      const tag = t.tagName.toLowerCase();
      if (tag === 'select' || tag === 'textarea' || t.isContentEditable) return true;
      if (tag !== 'input') return false;
      const type = (t.type || 'text').toLowerCase();
      return type !== 'range' && type !== 'checkbox' && type !== 'radio' && type !== 'button' && type !== 'submit';
    }

    /** Keys a focused slider / checkbox / button consumes natively (a slider stays focused after a mouse drag). */
    function usesKeyNatively(t, k) {
      if (!t || !t.tagName) return false;
      const tag = t.tagName.toLowerCase();
      if (tag === 'button') return k === ' ' || k === 'Enter';
      if (tag !== 'input') return false;
      const type = (t.type || '').toLowerCase();
      if (type === 'checkbox' || type === 'radio') return k === ' ';
      if (type === 'range') return k.startsWith('Arrow') || k === 'Home' || k === 'End' || k === 'PageUp' || k === 'PageDown';
      return false;
    }

    window.addEventListener('keydown', (e) => {
      if (isTypingTarget(e.target) || usesKeyNatively(e.target, e.key) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key;
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', '_'].includes(k)) {
        cancelAnim(); keys.add(k); e.preventDefault(); return;
      }
      if (k === ' ') { toggleCheckbox('ctl-pause'); e.preventDefault(); return; }
      switch (k.toLowerCase()) {
        case 'h': {
          // hide both if either is visible, otherwise show both (never leave them out of phase)
          const panel = $('panel'), info = $('info');
          const anyVisible = (panel && !panel.classList.contains('hidden')) || (info && !info.classList.contains('hidden'));
          if (panel) panel.classList.toggle('hidden', anyVisible);
          if (info) info.classList.toggle('hidden', anyVisible);
          break;
        }
        case 's': screenshot(); break;
        case 'r': reset(); break;
        default: {
          const idx = parseInt(k, 10) - 1;
          if (idx >= 0 && idx < PRESET_ORDER.length) setPreset(PRESET_ORDER[idx]);
        }
      }
    });
    window.addEventListener('keyup', (e) => {
      keys.delete(e.key);
      // Shift released before the key would otherwise leave the shifted variant stuck
      if (e.key === '=' || e.key === '+') { keys.delete('='); keys.delete('+'); }
      if (e.key === '-' || e.key === '_') { keys.delete('-'); keys.delete('_'); }
    });
    window.addEventListener('blur', () => { keys.clear(); });

    // --- controls ------------------------------------------------------------
    /** Read a control's DOM value into params and refresh its readout. */
    function readControl(id) {
      const el = $(id), c = CONTROLS[id];
      if (!el) return;
      const prev = params[c.key];
      if (c.bool) params[c.key] = el.checked ? 1 : 0;
      else {
        const v = parseFloat(el.value);
        if (Number.isFinite(v)) params[c.key] = v;
      }
      if (c.fmt) {
        const out = document.querySelector('output[data-for="' + id + '"]');
        if (out) out.textContent = c.fmt(params[c.key]);
      }
      if (c.key === 'quality' && prev !== params.quality) size.dirty = true;
    }

    /** Set a control's DOM value (number or 0/1) and propagate into params. */
    function setControl(id, value) {
      const el = $(id), c = CONTROLS[id];
      if (!c) return;
      if (el) {
        if (c.bool) el.checked = !!value;
        else el.value = String(value);
        readControl(id);
      } else {
        params[c.key] = c.bool ? (value ? 1 : 0) : value;
      }
    }

    function toggleCheckbox(id) {
      const c = CONTROLS[id];
      setControl(id, params[c.key] ? 0 : 1);
    }

    function togglePanel(id) {
      const el = $(id);
      if (el) el.classList.toggle('hidden');
    }

    function reset() {
      cancelAnim();
      for (const id in CONTROLS) setControl(id, CONTROLS[id].def);
      camera.distance = CAMERA_DEFAULTS.distance;
      camera.yaw = CAMERA_DEFAULTS.yaw;
      camera.pitch = CAMERA_DEFAULTS.pitch;
      camera.velYaw = camera.velPitch = 0;
      clampCamera();
    }

    function screenshot() { screenshotPending = true; }

    function saveScreenshot() {
      const name = 'gargantua-' + new Date().toISOString().replace(/[:.]/g, '-') + '.png';
      const download = (href, revoke) => {
        const a = document.createElement('a');
        a.href = href; a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        if (revoke) setTimeout(() => URL.revokeObjectURL(href), 10000);
      };
      try {
        canvas.toBlob((blob) => {
          if (blob) download(URL.createObjectURL(blob), true);
          else download(canvas.toDataURL('image/png'), false);
        }, 'image/png');
      } catch (e) {
        console.error('[BH] screenshot failed', e);
      }
    }

    function bindControls() {
      for (const id in CONTROLS) {
        const el = $(id);
        if (!el) continue;
        const c = CONTROLS[id];
        // establish DOM defaults, then read whatever the DOM holds
        if (c.bool) el.checked = !!c.def; else el.value = String(c.def);
        readControl(id);
        el.addEventListener('input', () => readControl(id));
        el.addEventListener('change', () => readControl(id));
      }
      const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
      on('btn-reset', reset);
      on('btn-screenshot', screenshot);
      on('btn-toggle-panel', () => togglePanel('panel'));
      on('btn-toggle-info', () => togglePanel('info'));
      document.querySelectorAll('[data-preset]').forEach((b) => {
        b.addEventListener('click', () => setPreset(b.dataset.preset));
      });
    }

    // --- HUD -----------------------------------------------------------------
    const hud = { fps: $('hud-fps'), distance: $('hud-distance'), inclination: $('hud-inclination'), res: $('hud-res') };
    function updateHUD() {
      if (hud.fps) hud.fps.textContent = String(Math.round(clock.fps));
      if (hud.distance) hud.distance.textContent = camera.distance.toFixed(1) + ' M (' + (camera.distance / 2).toFixed(1) + ' r_s)';
      if (hud.inclination) hud.inclination.textContent = Math.round(camera.pitch / DEG) + '°';
      if (hud.res) hud.res.textContent = size.sceneW + '×' + size.sceneH;
    }

    // --- rendering -----------------------------------------------------------
    function drawTriangle() { gl.drawArrays(gl.TRIANGLES, 0, 3); }

    function bindTarget(t) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fbo : null);
      gl.viewport(0, 0, t ? t.w : size.dbW, t ? t.h : size.dbH);
    }

    function render() {
      const r = res;
      gl.bindVertexArray(r.vao);

      // Pass 1: scene → HDR FBO
      let p = r.sceneProg;
      gl.useProgram(p.prog);
      bindTarget(r.scene);
      gl.uniform2f(p.u.uResolution, size.sceneW, size.sceneH);
      gl.uniform1f(p.u.uTime, clock.time);
      gl.uniform3fv(p.u.uCamPos, camera.pos);
      gl.uniformMatrix3fv(p.u.uCamBasis, false, camera.basis);
      gl.uniform1f(p.u.uTanHalfFov, Math.tan(params.fov * 0.5 * DEG));
      gl.uniform1f(p.u.uDiskInner, params.diskInner);
      gl.uniform1f(p.u.uDiskOuter, params.diskOuter);
      gl.uniform1f(p.u.uDiskBrightness, params.diskBrightness);
      gl.uniform1f(p.u.uDiskTemp, params.diskTemp);
      gl.uniform1f(p.u.uDiskTurbulence, params.turbulence);
      gl.uniform1f(p.u.uDoppler, params.doppler);
      gl.uniform1f(p.u.uRedshift, params.redshift);
      gl.uniform1f(p.u.uLensing, params.lensing);
      gl.uniform1f(p.u.uStarBrightness, params.starBrightness);
      gl.uniform1f(p.u.uSteps, params.steps);
      gl.uniform1f(p.u.uCamRedshift, params.camRedshift);
      drawTriangle();

      // Pass 2a: bright pass (scene → mip0, half res)
      p = r.brightProg;
      gl.useProgram(p.prog);
      bindTarget(r.mips[0]);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, r.scene.tex);
      gl.uniform1i(p.u.uSrc, 0);
      gl.uniform2f(p.u.uTexel, 1 / r.scene.w, 1 / r.scene.h);
      gl.uniform1f(p.u.uThreshold, BLOOM_THRESHOLD);
      gl.uniform1f(p.u.uKnee, BLOOM_KNEE);
      drawTriangle();

      // Pass 2b: downsample chain mip0 → mip1 … mip4
      p = r.downProg;
      gl.useProgram(p.prog);
      gl.uniform1i(p.u.uSrc, 0);
      for (let i = 1; i < BLOOM_LEVELS; i++) {
        const src = r.mips[i - 1];
        bindTarget(r.mips[i]);
        gl.bindTexture(gl.TEXTURE_2D, src.tex);
        gl.uniform2f(p.u.uTexel, 1 / src.w, 1 / src.h);
        drawTriangle();
      }

      // Pass 2c: upsample chain, ups[i] = mips[i] + tent(ups[i+1] or mips[4])
      p = r.upProg;
      gl.useProgram(p.prog);
      gl.uniform1i(p.u.uSrc, 0);
      gl.uniform1i(p.u.uBase, 1);
      for (let i = BLOOM_LEVELS - 2; i >= 0; i--) {
        const src = i === BLOOM_LEVELS - 2 ? r.mips[i + 1] : r.ups[i + 1];
        bindTarget(r.ups[i]);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src.tex);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, r.mips[i].tex);
        gl.uniform2f(p.u.uTexel, 1 / src.w, 1 / src.h);
        drawTriangle();
      }

      // Pass 3: composite → default framebuffer
      p = r.compProg;
      gl.useProgram(p.prog);
      bindTarget(null);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, r.scene.tex);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, r.ups[0].tex);
      gl.uniform1i(p.u.uScene, 0);
      gl.uniform1i(p.u.uBloom, 1);
      gl.uniform1f(p.u.uBloomStrength, params.bloom);
      gl.uniform1f(p.u.uExposure, params.exposure);
      drawTriangle();

      // unbind so the next frame's FBO writes never alias a bound sampler
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, null);
    }

    function frame(nowMs) {
      if (!running) return;
      rafId = requestAnimationFrame(frame);
      const now = nowMs / 1000;
      const dt = clock.last ? Math.min(0.1, now - clock.last) : 0;
      clock.last = now;

      if (size.dirty) updateSize();
      if (!params.pause) clock.time += dt * params.timeScale;
      stepCamera(dt, now);
      render();

      if (screenshotPending) { screenshotPending = false; saveScreenshot(); }

      // first few frames: verify the pipeline is clean before hiding the loader
      if (clock.checkFrames > 0) {
        clock.checkFrames--;
        const err = gl.getError();
        if (err !== gl.NO_ERROR) {
          console.error('[BH] GL error 0x' + err.toString(16) + ' on frame ' + clock.frames);
        }
        // hide on the first clean frame, or after the last check frame regardless (never leave the loader stuck)
        if (!clock.loadingHidden && (err === gl.NO_ERROR || clock.checkFrames === 0)) {
          clock.loadingHidden = true;
          hideLoading();
        }
      }

      clock.frames++;
      clock.hudFrames++;
      clock.hudTime += dt;
      if (clock.hudTime >= HUD_INTERVAL) {
        clock.fps = clock.hudFrames / clock.hudTime;
        clock.hudFrames = 0; clock.hudTime = 0;
        updateHUD();
      }
    }

    function start() {
      if (running) return;
      running = true;
      clock.last = 0;
      clock.checkFrames = 3;
      rafId = requestAnimationFrame(frame);
    }

    function stop() {
      running = false;
      cancelAnimationFrame(rafId);
    }

    // --- context loss --------------------------------------------------------
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      console.warn('[BH] WebGL context lost');
      stop();
      res = null;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      console.warn('[BH] WebGL context restored, re-initialising');
      try {
        initGL();
        size.sceneW = size.sceneH = size.dbW = size.dbH = 0;
        start();
      } catch (e) {
        showError(e.message);
      }
    });

    // --- debug / test hook -----------------------------------------------------
    window.BH = { params, camera, setPreset, screenshot, reset, gl, canvas };

    // --- boot ------------------------------------------------------------------
    bindControls();
    updateCameraVectors();
    updateHUD();

    loadShaderSource('shader-scene').then((src) => {
      sceneSource = src;
      initGL();
      start();
    }).catch((e) => {
      showError(e && e.message ? e.message : String(e));
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main);
  else main();
})();
