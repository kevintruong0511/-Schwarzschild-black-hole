# GARGANTUA — real-time general-relativistic black hole renderer (WebGL2)

A single-page, dependency-free web app that renders a Schwarzschild black hole by
tracing light rays backwards from the camera through curved spacetime on the GPU.
Features: gravitational lensing, event horizon shadow, photon ring, thin accretion
disk with Keplerian rotation, relativistic Doppler beaming + gravitational redshift,
blackbody disk colour, procedural starfield, HDR bloom + ACES tone mapping,
orbit camera, control panel and physics explainer.

This file is the integration contract. Three parallel workstreams build against it:

| Workstream | Owns these files |
|---|---|
| A. Physics shader | `src/scene.frag.glsl` |
| B. Engine | `src/app.js` (WebGL2 host, post-processing, camera, UI binding) |
| C. UI & content | `index.html`, `src/style.css`, `README.md` |
| Integrator | `build.mjs` (inlines everything into `dist/index.html`), testing |

Do NOT edit files you don't own. If you need something from another workstream that
this contract doesn't cover, pick a sensible default on your side and note it in your
final report.

## Units & coordinates

* Geometric units G = c = M = 1. Schwarzschild radius r_s = 2. Photon sphere r = 3.
  ISCO r = 6. All distances in the shader and camera are in these units.
* World space is right-handed. The black hole sits at the origin.
* The accretion disk lies in the plane y = 0; its normal (spin axis) is +y.
* Disk gas orbits with angular velocity Ω(r) = r^(-3/2) in the direction
  e_φ = normalize(vec3(-p.z, 0, p.x)), i.e. φ = atan(z, x) increases with time.
* `uTime` is coordinate time t in units of M (the engine already applies the
  time-scale slider; the shader just uses uTime).

## Scene shader interface (workstream A provides, B consumes)

File: `src/scene.frag.glsl`, GLSL ES 3.00 (`#version 300 es` first line),
`precision highp float;`. Entry `void main()`; writes `out vec4 fragColor`
as **linear HDR RGB** (values may exceed 1; disk peak around 1–20), alpha = 1.
No tone mapping, no gamma in this shader. Pixel coordinate from `gl_FragCoord.xy`.

Uniforms (exact names; all are set every frame by the engine):

```glsl
uniform vec2  uResolution;     // render target size in pixels
uniform float uTime;           // coordinate time in M (see above)
uniform vec3  uCamPos;         // camera position (units of M)
uniform mat3  uCamBasis;       // columns: right, up, forward (unit, orthonormal); forward = view direction
uniform float uTanHalfFov;     // tan(vertical FOV / 2)
uniform float uDiskInner;      // inner radius, M (default 6.0 = ISCO; slider 2.5–12)
uniform float uDiskOuter;      // outer radius, M (default 18.0; slider 8–40)
uniform float uDiskBrightness; // emission multiplier (default 1.0; slider 0–5)
uniform float uDiskTemp;       // peak emitter temperature in Kelvin (default 7000; slider 2000–20000)
uniform float uDiskTurbulence; // 0..1 strength of procedural streaks/noise (default 0.6)
uniform float uDoppler;        // 0..1 strength of Doppler beaming + shift (default 1)
uniform float uRedshift;       // 0..1 strength of gravitational redshift/dimming (default 1)
uniform float uLensing;        // 0 = straight rays (Newtonian camera), 1 = full GR (default 1). Mix is allowed but only 0/1 matter.
uniform float uStarBrightness; // background star/galaxy multiplier (default 1.0; slider 0–3)
uniform float uSteps;          // max integration steps, use int(uSteps) (default 320; slider 64–800)
uniform float uCamRedshift;    // 1 = apply static-observer blueshift factor 1/sqrt(1-2/r_cam), 0 = observer at infinity (default 1)
```

The engine renders a fullscreen triangle; the vertex shader is the engine's.
No textures are provided; everything in the scene shader is procedural.

## Engine behaviour (workstream B)

* WebGL2 only. If unavailable, show `#error` with a message and hide `#loading`.
* Pipeline: scene → RGBA16F FBO at `renderScale × devicePixelRatio` → bloom
  (bright pass, 5-level downsample/upsample chain) → composite: scene + bloom·strength,
  exposure, ACES filmic tone map, sRGB gamma, slight vignette, dither.
* Shader source loading: `document.getElementById('shader-scene').textContent`
  if non-empty (built single-file), otherwise `fetch(el.dataset.src)` (dev server).
* Camera: orbit around origin. Left-drag = orbit (yaw around +y, pitch clamped ±89°),
  wheel/pinch = dolly (distance clamped 2.6 … 400 M), touch one-finger orbit.
  Keys: arrows orbit, +/- dolly, Space pause, H hide/show panels, S screenshot,
  R reset, 1–5 presets. Inertia (damped) on orbit is a nice touch.
* `uCamBasis` columns = (right, up, forward), forward = normalize(target − pos),
  target = origin. up derived from world +y (handle pitch near poles).
* Time: `uTime += dt_seconds × timeScale` unless paused.
* Binds every control listed below by id, updates the value readouts, HUD, and
  `window.BH = { params, camera, setPreset(name), screenshot() }`.
* Hides `#loading` after the first successful frame.

## DOM contract (workstream C provides, B binds)

Element ids (all must exist):

| id | kind | range / notes | default |
|---|---|---|---|
| `canvas` | `<canvas>` | fills viewport, behind UI | |
| `loading` | overlay div | hidden by engine after first frame | |
| `error` | div, hidden by default | engine sets textContent & shows | |
| `panel` | aside, the controls panel | | |
| `info` | aside, the physics explainer | | |
| `ctl-diskInner` | range | 2.5–12 step 0.1 | 6 |
| `ctl-diskOuter` | range | 8–40 step 0.5 | 18 |
| `ctl-diskBrightness` | range | 0–5 step 0.05 | 1 |
| `ctl-diskTemp` | range | 2000–20000 step 100 | 7000 |
| `ctl-turbulence` | range | 0–1 step 0.01 | 0.6 |
| `ctl-starBrightness` | range | 0–3 step 0.05 | 1 |
| `ctl-exposure` | range | 0.1–4 step 0.05 | 1 |
| `ctl-bloom` | range | 0–2 step 0.05 | 0.4 |
| `ctl-fov` | range | 20–110 step 1 (degrees, vertical) | 60 |
| `ctl-steps` | range | 64–800 step 16 | 320 |
| `ctl-timeScale` | range | 0–40 step 0.5 (M per second) | 8 |
| `ctl-quality` | `<select>` | option values 0.5, 0.75, 1, 1.5 (render scale) | 0.75 |
| `ctl-lensing` | checkbox | | checked |
| `ctl-doppler` | checkbox | | checked |
| `ctl-redshift` | checkbox | | checked |
| `ctl-camRedshift` | checkbox | | checked |
| `ctl-pause` | checkbox | | unchecked |
| `btn-screenshot` | button | | |
| `btn-reset` | button | | |
| `btn-toggle-panel` | button | shows/hides `#panel` | |
| `btn-toggle-info` | button | shows/hides `#info` | |
| `hud-fps` | span | engine writes e.g. "60" | |
| `hud-distance` | span | camera distance in M, e.g. "32.0 M (16.0 r_s)" | |
| `hud-inclination` | span | degrees above disk plane, e.g. "12°" | |
| `hud-res` | span | e.g. "1440×900" | |

* Preset buttons: `<button data-preset="interstellar">` etc. Names:
  `interstellar` (dist 32, pitch 10°, fov 60), `edge` (dist 30, pitch 1°), `top` (dist 40, pitch 80°),
  `far` (dist 120, fov 40), `close` (dist 9, pitch 20°, fov 90).
* Every range input has a readout: `<output data-for="ctl-xxx">` placed next to it;
  the engine writes the formatted value into it.
* Hidden state for panels: engine toggles class `hidden` on `#panel`/`#info`;
  CSS must define `.hidden { display: none }` (or a transform-based equivalent).

## Build (integrator)

`node build.mjs` produces `dist/index.html`: inlines `<link rel=stylesheet href=...>`,
`<script src=...>` and fills `<script type="x-shader/..." data-src=...>` tags with the
file contents. Dev mode: `python3 -m http.server` in `black-hole/` and open `index.html`.
