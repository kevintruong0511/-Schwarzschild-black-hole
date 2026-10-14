#version 300 es
/*
 * ============================================================================
 *  GARGANTUA  —  Schwarzschild black hole with a thin accretion disk
 *  Scene fragment shader (GLSL ES 3.00).  Writes LINEAR HDR RGB, alpha = 1.
 * ============================================================================
 *
 *  Units: G = c = M = 1.  Horizon r_s = 2, photon sphere r = 3, ISCO r = 6.
 *  The hole sits at the origin; the disk lies in the plane y = 0.
 *
 *  Each pixel shoots ONE light ray backwards from the camera and integrates it
 *  through curved spacetime (backward ray tracing of null geodesics).
 *
 *  Equations used
 *  --------------
 *  (1) Null geodesics of Schwarzschild (orbital plane, u = 1/r, affine λ):
 *
 *          d²u/dφ² + u = 3 M u²                       (Binet form)
 *
 *      In pseudo-Cartesian coordinates with the affine parameter λ this is
 *      exactly equivalent to the central-force law
 *
 *          d²p/dλ² = -3 M h² p / r⁵ ,   h = |p × v| = L  (conserved)
 *
 *      (The centrifugal part h²/r³ of the radial equation is produced by the
 *      Cartesian kinematics; the -3Mh²/r⁴ term is the GR correction.  For
 *      M = 1 the circular photon orbit is at r = 3 and the critical impact
 *      parameter is b = 3√3 ≈ 5.196, both reproduced by this integrator.)
 *      Along the ray |v|² = E² + 2L²/r³, so the photon energy at infinity is
 *      E² = |v|² − 2h²/r³, evaluated once at the camera.
 *
 *  (2) Static observer at the camera (r_c): the local radial direction is
 *      contracted by √(1 − 2/r_c) when converted to coordinate velocity (the
 *      tetrad e_r = √(1−2/r) ∂_r).  Nearby observers therefore see a larger
 *      shadow.  A static observer also measures every frequency blueshifted by
 *      1/√(1 − 2/r_c) relative to infinity (toggle uCamRedshift).
 *
 *  (3) Disk gas on circular Keplerian orbits:
 *          Ω = r^(-3/2),       u^t = 1/√(1 − 3/r)
 *      Redshift factor of a photon with energy E and angular momentum L about
 *      the spin axis (positive when prograde):
 *          g = ν_obs / ν_em = √(1 − 3/r) / (1 − Ω L/E)
 *      √(1−3/r) = gravitational redshift × transverse Doppler; the denominator
 *      is the line-of-sight Doppler term (approaching gas → g > 1).
 *
 *  (4) Observed radiance: I_ν/ν³ is Lorentz invariant, so the bolometric
 *      intensity of a blackbody scales as g⁴ and its colour temperature as
 *      T_obs = g T_em.  Emitter temperature follows a Novikov–Thorne-like
 *      profile  T(r)⁴ ∝ r⁻³ (1 − √(r_in/r)),  peaking at r = (49/36) r_in.
 *
 *  (5) Blackbody colour: Planckian-locus chromaticity (Kim et al. cubic fit,
 *      1667–25000 K) → xyY → XYZ → linear sRGB, normalised to white at 6500 K.
 *
 *  Integration: RK4 with a step proportional to r (small near the hole, large
 *  far away).  Disk crossings are found by the sign change of p.y between
 *  steps and resolved by linear interpolation; the ray continues through the
 *  (partially transparent) disk so lensed secondary images remain visible.
 * ============================================================================
 */
precision highp float;
precision highp int;

out vec4 fragColor;

// ---------------------------------------------------------------------------
//  Uniforms (names fixed by CONTRACT.md)
// ---------------------------------------------------------------------------
uniform vec2  uResolution;     // render target size in pixels
uniform float uTime;           // coordinate time in M
uniform vec3  uCamPos;         // camera position (units of M)
uniform mat3  uCamBasis;       // columns: right, up, forward
uniform float uTanHalfFov;     // tan(vertical FOV / 2)
uniform float uDiskInner;      // inner disk radius (M)
uniform float uDiskOuter;      // outer disk radius (M)
uniform float uDiskBrightness; // emission multiplier
uniform float uDiskTemp;       // peak emitter temperature (K)
uniform float uDiskTurbulence; // 0..1 streak / noise strength
uniform float uDoppler;        // 0..1 Doppler beaming + shift
uniform float uRedshift;       // 0..1 gravitational redshift / dimming
uniform float uLensing;        // 0 = straight rays, 1 = full GR
uniform float uStarBrightness; // background multiplier
uniform float uSteps;          // max integration steps
uniform float uCamRedshift;    // 1 = static-observer blueshift at the camera

// ---------------------------------------------------------------------------
//  Constants
// ---------------------------------------------------------------------------
const float PI        = 3.14159265358979;
const float TAU       = 6.28318530717959;
const float HORIZON   = 2.0;     // r_s for M = 1
const float STEP_K    = 0.05;    // step = STEP_K * r (spatial)
const float STEP_MIN  = 0.03;
const float STEP_MAX  = 64.0;
const float DISK_SCALE = 0.45;    // global radiance scale of the disk (HDR)
const float TURB_PERIOD = 70.0;  // M; life time of one shear pattern

// Linear-sRGB value of the 6500 K Planckian colour before normalisation
const vec3 BB_WHITE_6500 = vec3(1.042633, 0.983863, 1.034905);

// ---------------------------------------------------------------------------
//  Hashing / noise  (no sine, stable in highp on every GPU)
// ---------------------------------------------------------------------------
float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

vec4 hash43(vec3 p) {
    vec4 p4 = fract(vec4(p.xyzx) * vec4(0.1031, 0.1030, 0.0973, 0.1099));
    p4 += dot(p4, p4.wzxy + 33.33);
    return fract((p4.xxyz + p4.yzzw) * p4.zywx);
}

// 2-D value noise, periodic in x with the given period (integer-valued),
// quintic interpolation. 'seed' selects an independent pattern.
float vnoise(vec2 p, float period, float seed) {
    vec2 i = floor(p);
    vec2 f = p - i;
    vec2 w = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    float x0 = mod(i.x, period);
    float x1 = mod(i.x + 1.0, period);
    vec2 s = vec2(seed * 13.0 + 0.5, seed * 7.0 + 0.5);
    float a = hash12(vec2(x0, i.y) + s);
    float b = hash12(vec2(x1, i.y) + s);
    float c = hash12(vec2(x0, i.y + 1.0) + s);
    float d = hash12(vec2(x1, i.y + 1.0) + s);
    return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}

// 3-octave fbm, periodic in x. Returns ~[0,1].
float fbm3(vec2 p, float period, float seed) {
    float n = 0.5   * vnoise(p,                      period,       seed)
            + 0.25  * vnoise(p * 2.0 + vec2(3.1, 1.7), period * 2.0, seed + 1.0)
            + 0.125 * vnoise(p * 4.0 + vec2(7.3, 5.9), period * 4.0, seed + 2.0);
    return n / 0.875;
}

// ---------------------------------------------------------------------------
//  Blackbody colour (section 5 of the header)
// ---------------------------------------------------------------------------
vec3 blackbodyRGB(float T) {
    T = clamp(T, 1667.0, 25000.0);
    float u = 1000.0 / T;                     // keep the cubic well conditioned
    float x;
    if (T < 4000.0) {
        x = -0.2661239 * u * u * u - 0.2343589 * u * u + 0.8776956 * u + 0.179910;
    } else {
        x = -3.0258469 * u * u * u + 2.1070379 * u * u + 0.2226347 * u + 0.240390;
    }
    float x2 = x * x;
    float x3 = x2 * x;
    float y;
    if (T < 2222.0) {
        y = -1.1063814 * x3 - 1.34811020 * x2 + 2.18555832 * x - 0.20219683;
    } else if (T < 4000.0) {
        y = -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867;
    } else {
        y =  3.0817580 * x3 - 5.87338670 * x2 + 3.75112997 * x - 0.37001483;
    }
    y = max(y, 1e-4);
    // xyY (Y = 1) -> XYZ
    float X = x / y;
    float Z = (1.0 - x - y) / y;
    // XYZ -> linear sRGB (D65)
    vec3 rgb;
    rgb.r =  3.2406 * X - 1.5372 - 0.4986 * Z;
    rgb.g = -0.9689 * X + 1.8758 + 0.0415 * Z;
    rgb.b =  0.0557 * X - 0.2040 + 1.0570 * Z;
    rgb = max(rgb, vec3(0.0));
    return rgb / BB_WHITE_6500;             // (1,1,1) at 6500 K
}

// ---------------------------------------------------------------------------
//  Accretion disk
// ---------------------------------------------------------------------------

// Turbulent streak pattern advected by differential Keplerian rotation.
// phi is the azimuth atan(z, x); the gas moves toward +phi at rate Ω(r).
// Two copies of the pattern with staggered lifetimes are cross-faded so the
// shear never accumulates without bound (a "flow-noise" trick); the bulk
// rotation at a reference rate is continuous, only the differential part
// is periodically reset while its weight is zero.
float diskNoise(float r, float phi) {
    float omega    = pow(r, -1.5);
    float omegaRef = pow(0.5 * (uDiskInner + uDiskOuter), -1.5);
    float dOmega   = omega - omegaRef;

    float fA = fract(uTime / TURB_PERIOD);
    float fB = fract(uTime / TURB_PERIOD + 0.5);
    float tA = fA * TURB_PERIOD;
    float tB = fB * TURB_PERIOD;
    float wA = 1.0 - abs(2.0 * fA - 1.0);      // triangle weight, 0 at reset
    float wB = 1.0 - wA;

    float base = phi - omegaRef * uTime;        // continuous bulk rotation
    float radial = log(r) * 9.0;                // anisotropic: 9 cells per e-fold
    const float AZ_CELLS = 8.0;                 // 8 cells around (period of noise)

    float nA = fbm3(vec2((base - dOmega * tA) * (AZ_CELLS / TAU), radial), AZ_CELLS, 0.0);
    float nB = fbm3(vec2((base - dOmega * tB) * (AZ_CELLS / TAU), radial), AZ_CELLS, 5.0);

    // Blend, then restore the contrast lost by averaging two patterns.
    float n = wA * nA + wB * nB;
    float k = inversesqrt(max(wA * wA + wB * wB, 1e-3));
    return clamp(0.5 + (n - 0.5) * k, 0.0, 1.0);
}

// Emission at a disk crossing.  pc: crossing point (y = 0),
// bAxis: photon angular momentum per unit energy about the gas rotation axis
// (positive = prograde), gCam: static-observer factor at the camera.
// Returns (linear HDR radiance, alpha).
vec4 diskSample(vec3 pc, float bAxis, float gCam) {
    float r   = length(pc.xz);
    float phi = atan(pc.z, pc.x);
    float n   = diskNoise(r, phi);
    float tn  = uDiskTurbulence * (n - 0.5);    // signed turbulence, |tn| <= 0.5

    // ---- density: smooth inner edge, ragged outer edge ----
    float inner  = smoothstep(0.0, 0.6, r - uDiskInner);
    float ragged = (tn + 0.5 * uDiskTurbulence) * 6.0;   // >= 0: rim only recedes inward, so the hard clip at uDiskOuter is never reached with density > 0
    float outer  = 1.0 - smoothstep(-4.0, 0.0, r - uDiskOuter + ragged);
    float dens   = inner * outer * (0.9 + 0.1 * n);
    float alpha  = dens * clamp(0.95 + 0.5 * tn, 0.0, 1.0);   // translucent in dark patches

    // ---- kinematics / redshift (eq. 3) ----
    float rk    = max(r, 3.05);                  // circular orbits exist only for r > 3
    float omega = pow(rk, -1.5);
    float gGrav = sqrt(1.0 - 3.0 / rk);          // gravitational + transverse Doppler
    float gDop  = 1.0 / max(1.0 - omega * bAxis, 0.15);
    float g     = mix(1.0, gGrav, uRedshift) * mix(1.0, gDop, uDoppler) * gCam;

    // ---- emitter temperature: Novikov-Thorne-like profile (eq. 4) ----
    float rin  = uDiskInner;
    float rpk  = rin * (49.0 / 36.0);                      // radius of peak
    float fmax = pow(rpk, -3.0) * (1.0 / 7.0);             // = rpk^-3 (1 - 6/7)
    float f    = pow(r, -3.0) * (1.0 - sqrt(rin / max(r, rin)));
    float prof = pow(max(f / fmax, 0.0), 0.25);
    float Tem  = uDiskTemp * prof * (1.0 + 0.3 * tn);
    float Tobs = g * Tem;

    // ---- observed radiance: g^4 beaming on the shifted blackbody ----
    float t65   = Tobs / 6500.0;
    float bright = t65 * t65 * t65 * t65;
    bright *= uDiskBrightness * dens * (1.0 + 1.5 * tn) * DISK_SCALE;
    vec3 rad = blackbodyRGB(Tobs) * bright;
    rad = min(rad, vec3(1000.0));                 // keep half-float bloom sane
    return vec4(rad, alpha);
}

// ---------------------------------------------------------------------------
//  Background: procedural starfield (cube-map hashed) + galactic band
// ---------------------------------------------------------------------------
vec3 faceDir(int face, vec2 uv) {
    vec3 d;
    if      (face == 0) d = vec3( 1.0, uv.y, uv.x);
    else if (face == 1) d = vec3(-1.0, uv.y, uv.x);
    else if (face == 2) d = vec3(uv.x,  1.0, uv.y);
    else if (face == 3) d = vec3(uv.x, -1.0, uv.y);
    else if (face == 4) d = vec3(uv.x, uv.y,  1.0);
    else                d = vec3(uv.x, uv.y, -1.0);
    return normalize(d);
}

// pix: angular size of one pixel (radians); gCam: camera blueshift factor.
vec3 starField(vec3 d, float pix, float gCam) {
    const float N = 64.0;                        // cells per cube-face edge
    vec3 ad = abs(d);
    int face;
    vec2 uv;
    if (ad.x >= ad.y && ad.x >= ad.z) {
        face = (d.x > 0.0) ? 0 : 1;
        uv = vec2(d.z, d.y) / ad.x;
    } else if (ad.y >= ad.z) {
        face = (d.y > 0.0) ? 2 : 3;
        uv = vec2(d.x, d.z) / ad.y;
    } else {
        face = (d.z > 0.0) ? 4 : 5;
        uv = vec2(d.x, d.y) / ad.z;
    }
    vec2 g    = (uv + 1.0) * 0.5 * N;
    vec2 cell = floor(g);

    float sigma  = 0.9 * pix;                    // ~0.9 px gaussian radius
    float invS2  = 1.0 / (2.0 * sigma * sigma);
    float gCam4  = gCam * gCam * gCam * gCam;
    float fseed  = float(face) * 7.0 + 1.0;

    vec3 col = vec3(0.0);
    for (int j = -1; j <= 1; j++) {
        for (int i = -1; i <= 1; i++) {
            vec2 c = cell + vec2(float(i), float(j));
            if (c.x < 0.0 || c.y < 0.0 || c.x >= N || c.y >= N) continue;
            vec4 h = hash43(vec3(c, fseed));
            if (h.w < 0.22) continue;            // empty cell -> irregular field
            vec2 spos = (c + 0.1 + 0.8 * h.xy) / N * 2.0 - 1.0;
            vec3 sdir = faceDir(face, spos);
            vec3 dd   = d - sdir;
            float q   = dot(dd, dd) * invS2;     // (chord/sigma)^2 / 2
            if (q > 12.0) continue;
            // heavy-tailed brightness: mostly faint, a few bright
            // ~2% of stars exceed the bloom threshold (1.0) so only a handful glow.
            float b = 0.025 + 0.35 * pow(h.z, 6.0) + 2.5 * pow(h.z, 64.0);
            float T = 3000.0 + 12000.0 * h.w * h.w;
            col += blackbodyRGB(T * gCam) * (b * gCam4 * exp(-q));
        }
    }
    return col;
}

vec3 galaxyBand(vec3 d, float gCam) {
    vec3 nB = normalize(vec3(0.3, 1.0, 0.2));                  // band normal (tilted)
    vec3 e1 = normalize(cross(nB, vec3(0.0, 0.0, 1.0)));
    vec3 e2 = cross(nB, e1);
    float lat = dot(d, nB);                                     // sin(latitude)
    float lon = atan(dot(d, e2), dot(d, e1));                   // -pi..pi
    float w = exp(-30.0 * lat * lat);
    if (w < 1e-3) return vec3(0.0);
    const float LON_CELLS = 24.0;
    vec2 q = vec2((lon + PI) * (LON_CELLS / TAU), lat * 14.0);
    float n1 = fbm3(q, LON_CELLS, 11.0);
    float n2 = fbm3(q * 2.0 + vec2(0.0, 2.2), LON_CELLS * 2.0, 23.0);
    float dust = 1.0 - 0.75 * smoothstep(0.5, 0.72, n2);        // dark lanes
    float glow = (0.2 + 0.8 * n1) * dust * w;
    vec3 tint = mix(vec3(0.95, 0.80, 0.62), vec3(0.70, 0.78, 1.00), n1);
    float gCam4 = gCam * gCam * gCam * gCam;
    return tint * glow * 0.06 * gCam4;
}

vec3 background(vec3 d, float pix, float gCam) {
    return (starField(d, pix, gCam) + galaxyBand(d, gCam)) * uStarBrightness;
}

// ---------------------------------------------------------------------------
//  Geodesic force (eq. 1).  h2 = |p x v|^2 is conserved along the ray.
// ---------------------------------------------------------------------------
vec3 accel(vec3 p, float h2) {
    float r = max(length(p), 0.5);
    return p * (-3.0 * h2 * pow(r, -5.0));
}

// ---------------------------------------------------------------------------
//  Main: one backward-traced ray per pixel
// ---------------------------------------------------------------------------
void main() {
    // ---- ray setup ----
    vec2 ndc = (gl_FragCoord.xy / uResolution) * 2.0 - 1.0;
    float aspect = uResolution.x / uResolution.y;
    vec3 dirCam = normalize(vec3(ndc.x * aspect * uTanHalfFov, ndc.y * uTanHalfFov, 1.0));
    vec3 n = normalize(uCamBasis * dirCam);     // local direction seen by the observer
    float pix = 2.0 * uTanHalfFov / uResolution.y;

    bool lensing = uLensing > 0.5;
    float rCam = max(length(uCamPos), 2.05);
    vec3 rhat = uCamPos / rCam;

    // Static-observer tetrad (eq. 2): contract the radial component of the
    // local direction to obtain the coordinate velocity.
    float radialFac = lensing ? sqrt(1.0 - 2.0 / rCam) : 1.0;
    vec3 v = n + (radialFac - 1.0) * dot(n, rhat) * rhat;
    vec3 p = uCamPos;

    // Conserved quantities of this ray.
    vec3 Lvec = cross(p, v);                     // angular momentum vector
    float h2  = dot(Lvec, Lvec);
    float E   = sqrt(max(dot(v, v) - 2.0 * h2 / (rCam * rCam * rCam), 1e-3));
    // Angular momentum per unit energy about the gas rotation axis.  The gas
    // moves along e_phi = (-z, 0, x), whose rotation axis is -y; the traced
    // direction v is opposite to the photon momentum, so (p x v).y is the
    // photon's prograde angular momentum.  (Checked: p=(r,0,0), photon toward
    // +z  ->  v=(0,0,-1)  ->  (p x v).y = +r.)
    float bAxis = Lvec.y / E;

    // Static-observer blueshift at the camera (toggle).
    float gCam = mix(1.0, inversesqrt(1.0 - 2.0 / max(rCam, 2.2)), uCamRedshift);

    float escR = max(60.0, rCam * 1.5);
    int nSteps = int(uSteps);

    vec3 col = vec3(0.0);
    float trans = 1.0;
    int outcome = 2;                             // 0 captured/absorbed, 1 escaped, 2 budget exhausted

    // ---- integrate ----
    for (int i = 0; i < 2048; i++) {
        if (i >= nSteps) break;

        float r = length(p);
        if (r < HORIZON) { outcome = 0; break; }
        if (r > escR && dot(p, v) > 0.0) { outcome = 1; break; }

        // Adaptive step: proportional to r, measured in coordinate length.
        float speed = max(length(v), 1e-3);
        // step ~ r near the hole, super-linear far out so the approach from a
        // distant camera costs few steps (|a| ~ 1e-8 at r > 250, RK4 is unaffected).
        float dt = clamp(STEP_K * r * (1.0 + r / 100.0), STEP_MIN, STEP_MAX) / speed;

        vec3 p0 = p;
        vec3 v0 = v;

        if (lensing) {
            // Classical RK4 on the first-order system (p' = v, v' = a(p)).
            vec3 k1p = v0;
            vec3 k1v = accel(p0, h2);
            vec3 k2p = v0 + 0.5 * dt * k1v;
            vec3 k2v = accel(p0 + 0.5 * dt * k1p, h2);
            vec3 k3p = v0 + 0.5 * dt * k2v;
            vec3 k3v = accel(p0 + 0.5 * dt * k2p, h2);
            vec3 k4p = v0 + dt * k3v;
            vec3 k4v = accel(p0 + dt * k3p, h2);
            p = p0 + (dt / 6.0) * (k1p + 2.0 * k2p + 2.0 * k3p + k4p);
            v = v0 + (dt / 6.0) * (k1v + 2.0 * k2v + 2.0 * k3v + k4v);
        } else {
            p = p0 + dt * v0;                    // straight ray (Newtonian camera)
        }

        // ---- disk crossing: sign change of y between the two endpoints ----
        if (p0.y * p.y < 0.0) {                  // strict: a ray lying exactly in the plane never crosses
            float t  = p0.y / (p0.y - p.y);
            vec3 pc  = mix(p0, p, t);
            float rc = length(pc.xz);
            if (rc >= uDiskInner && rc <= uDiskOuter) {
                vec4 em = diskSample(pc, bAxis, gCam);
                col   += trans * em.rgb;
                trans *= (1.0 - em.a);
                if (trans < 0.01) { outcome = 0; break; }
            }
        }
    }

    // ---- termination ----
    if (outcome == 1) {
        col += trans * background(normalize(v), pix, gCam);
    } else if (outcome == 2) {
        // Budget exhausted: still deep in the potential -> treat as captured,
        // otherwise the direction is already nearly asymptotic.
        if (length(p) >= 6.0) col += trans * background(normalize(v), pix, gCam);
    }
    // outcome 0: captured by the horizon or fully absorbed -> nothing more.

    fragColor = vec4(max(col, vec3(0.0)), 1.0);
}
