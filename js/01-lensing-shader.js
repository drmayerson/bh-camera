'use strict';

/* =====================================================================================
   Black hole camera — 01: the lensing shader (GLSL)
   -------------------------------------------------------------------------------------
   The whole picture is drawn by this one fragment shader. 02-setup.js compiles it into
   several programs by putting a #define in front of it:
     (none)        direct: computes the bending for every pixel, every frame (fallback);
     MAP_PASS      computes the bending once per setting into a float texture (lens map);
     DISPLAY_PASS  per frame: looks up the lens map and fetches camera / sky / picture;
     RAW_PASS      the plain camera picture without black hole (colour picking, mask view);
     PROBE_PASS    the bending along four lines from the black hole, read back by
                   11-physics-points.js to place the clickable explanation points.
   Physics: Schwarzschild (spin 0) follows the original exhibit's code; the spinning (Kerr)
   case uses the analytic solution of Gralla & Lupsasca — see the comments further down.
   The text below is GLSL, kept in a JavaScript string that is handed to WebGL as it is.

   Outline of the shader, top to bottom
     uniforms                  the inputs, set by setUniforms() in 04-drawing.js
                               (textureft = camera picture, texturebg = star sky: names from
                               the exhibit's code)
     c_... , DRF, F, psimax    complex numbers, elliptic integrals, Schwarzschild bending
     kRF ... kerrCore          Kerr (spinning) lensing: elliptic integrals, ray tracing
     kerrLens                  bending of one camera ray, for any spin
     camTC ... camComposite    camera picture, background removal, background picture, sky
     OUT_BLACK / CAM / SKY     what each pass writes: the lens map stores coordinates
                               (layout: see 02-setup.js), the other passes write colours
     main()                    one per pass: DISPLAY_PASS, RAW_PASS, else MAP_PASS / direct /
                               PROBE_PASS (the same code, only the input point and output differ)
   ===================================================================================== */

const FRAG_SRC = `
precision highp float;
#define M_PI 3.14159265358979
#define D1MACH1 1.175494351e-38
#define D1MACH2 3.402823466e+38
#define D1MACH3 1e-7
uniform vec2  uResolution;
uniform vec2  uScreen;       // full screen width/height in lensing units
uniform vec2  uCamScale;     // full camera-image width/height in lensing units (cover fit)
uniform float M;             // black-hole mass (sets the size)
uniform float PsiScale;      // 1 = physical bending
uniform float uSpin;         // a/M
uniform float uInclination;  // radians
uniform float uRing;         // radius of the "starry" zone as a fraction of the shorter screen side
uniform float uTol;          // below this deflection the camera image fills the whole screen
uniform sampler2D textureft; // camera / demo image
uniform sampler2D texturebg; // star sky, equirectangular
uniform sampler2D uLensMap;  // precomputed map (display pass)
uniform float uBgMode;       // background removal: 0 off, 1 colour key, 2 person mask
uniform vec3  uKey;          // colour key: picked background colour (rgb)
uniform float uKeyTol;       // colour key: distance that still counts as background
uniform sampler2D uMask;     // person mask (1 = person), rows stored top-down
uniform float uShowMask;     // raw pass: tint the removed background
uniform float uCamRot;       // camera mounted on its side: 0 no, 1 turn picture clockwise, 3 anticlockwise
uniform sampler2D uBackdrop; // chosen background photo
uniform float uUseBackdrop;  // 1: removed background shows the photo instead of the sky
uniform vec4  uProbeAng;     // PROBE_PASS: direction (radians) of each of the 4 probe lines
uniform vec4  uProbeFrom;    // PROBE_PASS: where each probe line starts and ends
uniform vec4  uProbeTo;      //   (distance from the centre, lensing units)
uniform float uProbeN;       // PROBE_PASS: samples per line
uniform vec2  uBdScale;      // cover fit of the photo onto the camera image

vec2 c_p(vec2 x, vec2 y){
    return vec2(x[0]+y[0], x[1]+y[1]);
}

vec2 c_m(vec2 x, vec2 y){
    return vec2(x[0]*y[0] - x[1]*y[1] , x[0]*y[1] + x[1]*y[0]);
}

vec2 c_d(vec2 x, vec2 y){
    return c_m(x, vec2(y[0], -y[1]))/(y[0]*y[0] + y[1]*y[1]);   // was pow(y,2.): undefined for y<0 in GLSL
}

vec2 c_pow(vec2 x, float y){
    float mag = pow(sqrt(x[0]*x[0] + x[1]*x[1]), y);
    float angle = y*(atan(x[1],x[0]));
    return vec2(mag*cos(angle), mag*sin(angle));
}

float DRF(float X, float Y, float Z){

    float ERRTOL = pow(4.0*D1MACH3, 1.0/6.0);
    float LOLIM  = 5.0 * D1MACH1;
    float UPLIM  = D1MACH2/5.0;
    float C1 = 1.0/24.0;
    float C2 = 3.0/44.0;
    float C3 = 1.0/14.0;

    float ans = 0.0;
    if(min(min(X,Y),Z) < 0.0) {
        return ans;
    }

    if(max(max(X,Y),Z) > UPLIM){
        return ans;
    }

    if(min(min(X+Y,X+Z),Y+Z) < LOLIM){
        return ans;
    }

    float XN = X;
    float YN = Y;
    float ZN = Z;
    float MU = 0.;
    float XNDEV = 0.;
    float YNDEV = 0.;
    float ZNDEV = 0.;

    for(int it_=0; it_<60; it_++){
        MU = (XN+YN+ZN)/3.0;
        XNDEV = 2.0 - (MU+XN)/MU;
        YNDEV = 2.0 - (MU+YN)/MU;
        ZNDEV = 2.0 - (MU+ZN)/MU;
        float EPSLON = max(max(abs(XNDEV),abs(YNDEV)),abs(ZNDEV));
        if(EPSLON < ERRTOL){break;}
        float XNROOT = sqrt(XN);
        float YNROOT = sqrt(YN);
        float ZNROOT = sqrt(ZN);
        float LAMDA = XNROOT*(YNROOT+ZNROOT) + YNROOT*ZNROOT;
        XN = (XN+LAMDA)*0.250;
        YN = (YN+LAMDA)*0.250;
        ZN = (ZN+LAMDA)*0.250;
    }

    float E2 = XNDEV*YNDEV - ZNDEV*ZNDEV;
    float E3 = XNDEV*YNDEV*ZNDEV;
    float S  = 1.0 + (C1*E2-0.10-C2*E3)*E2 + C3*E3;
    ans = S/sqrt(MU);

    return ans;
}

float rawF(float sinphi, float m){
    float sinphi2 = sinphi*sinphi;                 // was pow(sinphi,2.0): undefined for sinphi<0
    float drf = DRF(1. - sinphi2, 1. - m*sinphi2, 1.);
    return sinphi*drf;
}

float K(float m){ return DRF(0., 1. - m, 1.);}

float F(float phi, float m){
    if(abs(phi) > M_PI/2.0){
        // Abramowitz & Stegun (17.4.3)
        float phi2 = phi + M_PI/2.0;
        float angle = (phi2/M_PI);
        return 2.0*floor(phi2 / M_PI)*K(m) - rawF(cos((angle - floor(angle))*M_PI), m);
    }
    return rawF(sin(phi), m);
}

float psimax(float mag){
    // Roots of the Schwarzschild radial cubic  r^3 - b^2 r + 2 b^2 = 0  (b = mag > sqrt(27)):
    // three real roots v1 < 0 < v3 < v4.  Computed with the trigonometric formula.
    // (The previous version used complex cube roots whose branch depended on the
    // sign of a rounding-noise imaginary part, i.e. on the GPU/driver: on some
    // renderers it mislabelled the roots and every pixel turned to stars.)
    float pp = -mag*mag, qq = 2.0*mag*mag;
    float rr = 2.0*sqrt(-pp/3.0);
    float th = acos(clamp(1.5*qq/pp*sqrt(-3.0/pp), -1.0, 1.0))/3.0;
    float v4 = rr*cos(th);                      // largest root
    float v3 = rr*cos(th - 2.0*M_PI/3.0);       // middle root (> 0)
    float v1 = rr*cos(th - 4.0*M_PI/3.0);       // negative root

    float v32 = v3;
    float v41 = v4 - v1;
    float v31 = v3 - v1;
    float v42 = v4;

    float ellk = v32*v41 / (v31*v42);
    return 4.*mag*F(asin(sqrt(v31/v41)), ellk)/sqrt(v31*v42);
}

// ============================================================================
//  KERR LENSING  (Gralla & Lupsasca, "Lensing by Kerr black holes" and
//  "Null geodesics of the Kerr exterior").  Fully analytic: elliptic integrals
//  in Carlson form + Jacobi amplitude.  Validated against a numerical geodesic
//  integrator to ~1e-8 rad (double) and to <~0.03 webcam texel (float32).
//  All quantities in units of M (M = 1) inside these functions.
// ============================================================================
#define K_PI 3.14159265358979

// Carlson R_F(x,y,z), fixed iteration count (WebGL1-safe loop).
float kRF(float x, float y, float z){
    for (int i = 0; i < 6; i++) {
        float sx = sqrt(x), sy = sqrt(y), sz = sqrt(z);
        float l = sx*(sy + sz) + sy*sz;
        x = (x + l)*0.25; y = (y + l)*0.25; z = (z + l)*0.25;
    }
    float mu = (x + y + z)/3.0;
    float X = 1.0 - x/mu, Y = 1.0 - y/mu, Z = -(X + Y);
    float E2 = X*Y - Z*Z, E3 = X*Y*Z;
    return (1.0 - E2/10.0 + E3/14.0 + E2*E2/24.0 - 3.0*E2*E3/44.0)/sqrt(mu);
}

// Carlson R_C(x,y) = R_F(x,y,y), closed form (series near x = y).
float kRC(float x, float y){
    float q = x/y, t = 1.0 - q, g;
    if (abs(t) < 0.1) {
        g = 1.0 + t*(1.0/6.0 + t*(3.0/40.0 + t*(5.0/112.0 + t*(35.0/1152.0 + t*(63.0/2816.0)))));
    } else if (t > 0.0) {
        g = acos(sqrt(q))/sqrt(t);
    } else {
        float v = sqrt(-t);
        g = log(v + sqrt(q))/v;                 // asinh(v)/v
    }
    return g/sqrt(y);
}

// Carlson R_J(x,y,z,p), p > 0.
float kRJ(float x, float y, float z, float p){
    float s = 0.0, fac = 1.0;
    for (int i = 0; i < 6; i++) {
        float sx = sqrt(x), sy = sqrt(y), sz = sqrt(z);
        float l = sx*(sy + sz) + sy*sz;
        float al = p*(sx + sy + sz) + sx*sy*sz;
        s += fac*kRC(al*al, p*(p + l)*(p + l));
        fac *= 0.25;
        x = (x + l)*0.25; y = (y + l)*0.25; z = (z + l)*0.25; p = (p + l)*0.25;
    }
    float mu = (x + y + z + 2.0*p)/5.0;
    float X = (mu - x)/mu, Y = (mu - y)/mu, Z = (mu - z)/mu, P = (mu - p)/mu;
    float ea = X*(Y + Z) + Y*Z, eb = X*Y*Z, ec = P*P;
    float e2 = ea - 3.0*ec, e3 = eb + 2.0*P*(ea - ec);
    float e4 = (2.0*eb + P*(ea - 3.0*ec))*P, e5 = eb*ec;
    float S = 1.0 - 3.0*e2/14.0 + e3/6.0 + 9.0*e2*e2/88.0 - 3.0*e4/22.0
            - 9.0*e2*e3/52.0 + 3.0*e5/26.0;
    return 3.0*s + fac*S/(mu*sqrt(mu));
}

// Legendre F(phi|m), |phi| <= pi/2.
float kF(float phi, float m){
    float s = sin(phi), c = cos(phi);
    return s*kRF(c*c, 1.0 - m*s*s, 1.0);
}

// Legendre Pi(n;phi|m), |phi| <= pi/2, with eps = 1-n passed separately so that
// 1 - n sin^2 = cos^2 + eps sin^2 has no cancellation (pole-grazing rays).
float kPi(float n, float eps, float phi, float m){
    float s = sin(phi), c = cos(phi), s2 = s*s, c2 = c*c, d = 1.0 - m*s2;
    return s*kRF(c2, d, 1.0) + (n/3.0)*s*s2*kRJ(c2, d, 1.0, c2 + eps*s2);
}

// Complete Pi(n|m).
float kPiC(float n, float eps, float m){
    float d = 1.0 - m;
    return kRF(0.0, d, 1.0) + (n/3.0)*kRJ(0.0, d, 1.0, eps);
}

// Jacobi amplitude am(u|m) for m <= 0 (unwrapped, any real u).
// Uses sn(u|m) = sd(v|mu)/sqrt(1-m), cn(u|m) = cd(v|mu), v = u sqrt(1-m),
// mu = -m/(1-m) in [0,1) (A&S 16.10), and the descending AGM for am(v|mu).
float kAmNeg(float u, float m){
    float q  = sqrt(1.0 - m);
    float mu = -m/(1.0 - m);
    float a0 = 1.0, b0 = sqrt(1.0 - mu);
    float a1 = 0.5*(a0 + b0), c1 = 0.5*(a0 - b0), b1 = sqrt(a0*b0);
    float a2 = 0.5*(a1 + b1), c2 = 0.5*(a1 - b1), b2 = sqrt(a1*b1);
    float a3 = 0.5*(a2 + b2), c3 = 0.5*(a2 - b2);
    float ph = 8.0*a3*u*q;
    ph = 0.5*(ph + asin(clamp(c3/a3*sin(ph), -1.0, 1.0)));
    ph = 0.5*(ph + asin(clamp(c2/a2*sin(ph), -1.0, 1.0)));
    ph = 0.5*(ph + asin(clamp(c1/a1*sin(ph), -1.0, 1.0)));
    float j = floor(ph/K_PI + 0.5);
    float r = ph - j*K_PI;
    return j*K_PI + atan(sin(r), q*cos(r));
}

float kCbrt(float v){ return sign(v)*pow(abs(v), 1.0/3.0); }

// One Gauss-Legendre node (t, weight w on [0,1]) of the direct I_phi integral
// (without the overall factor 2a):  u = (1-t^2)/r4,
// integrand = (2 - a lam u) u (2/r4) / ((1 - 2u + a^2 u^2) sqrt((1-r1 u)(1-r2 u)(1-r3 u)))
// with 1 - r3 u written as (r43 + r3 t^2)/r4 (no cancellation).
float kIphiTerm(float t, float w, float lam, float a,
                float r1, float r2, float r3, float r4, float r43){
    float u = (1.0 - t*t)/r4;
    float num = (2.0 - a*lam*u)*u*2.0/r4;
    float den = (1.0 - 2.0*u + a*a*u*u)*sqrt((1.0 - r1*u)*(1.0 - r2*u)*(r43 + r3*t*t)/r4);
    return w*num/den;
}

// Kerr map for a distant observer with inclination (cth = cos, sth = sin) and
// Bardeen screen coordinates (al, be), spin a, M = 1.  Traces the ray back to the
// celestial sphere.  Returns false if it comes from the horizon (shadow).
// Outputs cos/sin of the source polar angle, the source azimuth relative to the
// observer's azimuth, and the polar "sweep" angle (= psimax when a = 0).
bool kerrCore(float al, float be, float a, float cth, float sth,
              out float cths, out float sths, out float phs, out float sweep){
    cths = 0.0; sths = 1.0; phs = 0.0; sweep = 0.0;
    // measure-zero screen lines: lambda = 0 (pole crossing), eta = 0 (equator)
    if (abs(be) < 1.0e-4) be = 1.0e-4;
    float lam = -al*sth;
    if (abs(lam) < 1.0e-4) lam = (lam < 0.0) ? -1.0e-4 : 1.0e-4;
    float eta = (al*al - a*a)*cth*cth + be*be;
    if (eta <= 0.0) return false;               // vortical: always inside the shadow

    // ---- radial roots (Ferrari / Cardano, KerrGeo Eq. RadialRoots) ----
    float A = a*a - eta - lam*lam;
    float B = 2.0*(eta + (lam - a)*(lam - a));
    float C = -a*a*eta;
    float P = -A*A/12.0 - C;
    float Q = -A/3.0*((A/6.0)*(A/6.0) - C) - B*B/8.0;
    float disc = (P/3.0)*(P/3.0)*(P/3.0) + (Q/2.0)*(Q/2.0);
    float s3;
    if (disc >= 0.0) {
        float sd = sqrt(disc);
        s3 = kCbrt(-Q/2.0 + sd) + kCbrt(-Q/2.0 - sd);
    } else {
        s3 = 2.0*sqrt(-P/3.0)*cos(atan(sqrt(-disc), -Q/2.0)/3.0);
    }
    float z2 = s3/2.0 - A/6.0;
    float z  = sqrt(max(z2, 1.0e-12));
    float ip = -A/2.0 - z2 + B/(4.0*z);
    float im = -A/2.0 - z2 - B/(4.0*z);
    float rp = 1.0 + sqrt(max(1.0 - a*a, 0.0));   // outer horizon
    float rm = a*a/rp;                             // inner horizon
    if (im < 0.0) return false;                    // r3, r4 complex: from horizon
    float sip = sqrt(max(ip, 0.0)), sim = sqrt(im);
    float r1 = -z - sip, r2 = -z + sip, r3 = z - sim, r4 = z + sim;
    if (r4 <= rp) return false;                    // turning point inside horizon

    // ---- radial integrals, ray from infinity to r4 and back (case 2) ----
    float r31 = r3 - r1, r41 = r4 - r1, r32 = r3 - r2, r42 = r4 - r2, r43 = 2.0*sim;
    float sq   = sqrt(r31*r42);
    float sphi = sqrt(r31/r41);                    // sin(phi_inf)
    float c2r  = r43/r41;                          // cos^2(phi_inf)
    float dr   = r43/r42;                          // 1 - k sin^2(phi_inf)
    float Fi   = sphi*kRF(c2r, dr, 1.0);           // F(phi_inf | k)
    float Ir   = 4.0*Fi/sq;                        // total Mino time I_r
    // Frame-dragging integral I_phi.
    float Iphi;
    if (r3 < 0.9*r4) {
        // Weak/moderate field: the paper's horizon partial fractions subtract two
        // nearly equal terms here (float32 loses most digits), so integrate
        // a(2r - a lam)/(Delta sqrt(R)) directly in u = 1/r = (1-t^2)/r4 with an
        // 8-point Gauss-Legendre rule on t in [0,1]; the integrand is smooth.
        Iphi = 0.0;
        Iphi += kIphiTerm(0.0198550717512319, 0.0506142681451881, lam, a, r1, r2, r3, r4, r43);
        Iphi += kIphiTerm(0.1016667612931866, 0.1111905172266872, lam, a, r1, r2, r3, r4, r43);
        Iphi += kIphiTerm(0.2372337950418355, 0.1568533229389436, lam, a, r1, r2, r3, r4, r43);
        Iphi += kIphiTerm(0.4082826787521751, 0.1813418916891810, lam, a, r1, r2, r3, r4, r43);
        Iphi += kIphiTerm(0.5917173212478249, 0.1813418916891810, lam, a, r1, r2, r3, r4, r43);
        Iphi += kIphiTerm(0.7627662049581645, 0.1568533229389436, lam, a, r1, r2, r3, r4, r43);
        Iphi += kIphiTerm(0.8983332387068134, 0.1111905172266872, lam, a, r1, r2, r3, r4, r43);
        Iphi += kIphiTerm(0.9801449282487681, 0.0506142681451881, lam, a, r1, r2, r3, r4, r43);
        Iphi *= 2.0*a;
    } else {
        // Near the critical curve: elliptic form (KerrGeo case 2, I_+- terms).
        float s3p = sphi*sphi*sphi;
        float rp3 = rp - r3, rp4 = rp - r4;
        float np_ = rp3*r41/(rp4*r31);
        float Pip = Fi + (np_/3.0)*s3p*kRJ(c2r, dr, 1.0, r43/(r4 - rp));
        float Ip  = 2.0*(-(2.0/sq)*(r43/(rp3*rp4))*Pip - (2.0/sq)*Fi/rp3);
        float rm3 = rm - r3, rm4 = rm - r4;
        float nm_ = rm3*r41/(rm4*r31);
        float Pim = Fi + (nm_/3.0)*s3p*kRJ(c2r, dr, 1.0, r43/(r4 - rm));
        float Im  = 2.0*(-(2.0/sq)*(r43/(rm3*rm4))*Pim - (2.0/sq)*Fi/rm3);
        Iphi = (2.0*a/(rp - rm))*((rp - a*lam/2.0)*Ip - (rm - a*lam/2.0)*Im);
    }

    // ---- angular integrals (written without 1/a so a -> 0 is regular) ----
    float w   = (a*a - eta - lam*lam)/2.0;         // a^2 Delta_theta
    float wm  = w - sqrt(w*w + a*a*eta);           // a^2 u_-  (< 0)
    float up  = -eta/wm;                           // u_+
    float eps = lam*lam/(a*a - wm);                // 1 - u_+  (exact identity)
    float km  = a*a*up/wm;                         // u_+/u_-  (<= 0)
    float s   = sqrt(-wm);                         // a sqrt(-u_-)
    float sgb = (be >= 0.0) ? 1.0 : -1.0;
    // observer-side amplitude: sin = cth/sqrt(u+); cos^2 from the exact identity
    // u+ - cos^2(th) = sin^2(th) beta^2/(a^2 cos^2(th) - a^2 u_-), which avoids the
    // float32 cancellation for rays arriving almost along the spin axis.
    float sno = cth/sqrt(up);
    float co2 = (sth*sth*be*be)/((a*a*cth*cth - wm)*up);
    float dno = 1.0 - km*sno*sno;
    float Fo  = sno*kRF(co2, dno, 1.0);
    float PiO = Fo + (up/3.0)*sno*sno*sno*kRJ(co2, dno, 1.0, co2 + eps*sno*sno);
    float PiC = kPiC(up, eps, km);
    float Psi = kAmNeg(Fo + sgb*s*Ir, km);         // source latitude amplitude
    float j   = floor(Psi/K_PI + 0.5);
    float PiPsi = 2.0*j*PiC + kPi(up, eps, Psi - j*K_PI, km);
    float Gphi  = sgb*(PiPsi - PiO)/s;
    cths = sqrt(up)*sin(Psi);
    sths = sqrt(max(1.0 - cths*cths, 0.0));
    phs  = -(Iphi + lam*Gphi);                     // phi_s - phi_o = -(I_phi + lambda G_phi)
    sweep = (0.5*K_PI/kRF(0.0, 1.0 - km, 1.0))*s*Ir;
    return true;
}

// Full camera geometry.  The camera sits at distance D along n_o (inclination
// uInclination, spin axis projected to screen-up).  Each pixel's ray, arriving at
// angle phi0 = asin(b/D), is treated as the ray of an observer at infinity along
// its own direction, so the a = 0 limit is EXACTLY the classic Schwarzschild
// mapping  S = sin(phi0 - deltapsi) (cos w, sin w).
// Returns false for shadow pixels; otherwise S = screen-plane components of the
// (PsiScale-scaled) source direction and defl = its unwrapped deflection angle.
bool kerrLens(float mag, float omega, float phi0, out vec3 S, out float defl){
    S = vec3(0.0, 0.0, 1.0); defl = 0.0;
    float a  = clamp(uSpin, 0.0, 0.999);
    float so = sin(uInclination), co = cos(uInclination);
    vec3 n_o = vec3(so, 0.0, co);
    vec3 e_a = vec3(0.0, 1.0, 0.0);                // screen x (Bardeen alpha)
    vec3 e_b = vec3(-co, 0.0, so);                 // screen y (projected spin axis)
    float cw = cos(omega), sw = sin(omega);
    float cp = cos(phi0),  sp = sin(phi0);
    vec3 u_w  = cw*e_a + sw*e_b;
    vec3 nf   = cp*n_o - sp*u_w;                   // photon direction at the camera
    vec3 bvec = (mag/M)*(sp*n_o + cp*u_w);         // impact vector, |bvec| = b/M
    float cthf = nf.z;
    float sthf = max(length(nf.xy), 1.0e-6);
    vec3 ex  = vec3(nf.xy/sthf, 0.0);
    vec3 eaf = vec3(-ex.y, ex.x, 0.0);
    vec3 ebf = vec3(-cthf*ex.x, -cthf*ex.y, sthf);
    float cths, sths, phs, sweep;
    if (!kerrCore(dot(bvec, eaf), dot(bvec, ebf), a, cthf, sthf, cths, sths, phs, sweep))
        return false;
    vec3 ns = sths*(cos(phs)*ex + sin(phs)*eaf) + vec3(0.0, 0.0, cths);
    vec3 nc = vec3(dot(ns, e_a), dot(ns, e_b), -dot(ns, n_o));   // camera frame
    vec3 dc = vec3(sp*cw, sp*sw, cp);                             // look direction
    // signed, unwrapped deflection about the Schwarzschild-like axis
    vec3 kref = vec3(sw, -cw, 0.0);
    vec3 c  = cross(dc, nc);
    float cl = length(c);
    float psi = atan(cl, dot(dc, nc));
    vec3 k = kref;
    if (cl > 1.0e-6) {
        k = c/cl;
        if (dot(k, kref) < 0.0) { k = -k; psi = -psi; }
    }
    float psiu = psi + 2.0*K_PI*floor((sweep - K_PI - psi)/(2.0*K_PI) + 0.5);
    if (abs(PsiScale - 1.0) > 1.0e-4) {          // artistic bending exaggeration
        float ang = PsiScale*psiu;
        nc = dc*cos(ang) + cross(k, dc)*sin(ang) + k*dot(k, dc)*(1.0 - cos(ang));
    }
    S = nc;
    defl = PsiScale*psiu;
    return true;
}


#define CAM_D 200.0

vec2 skyUV(vec3 n){
    // equirectangular: pole along screen-up, seam straight behind the viewer
    return vec2(0.5 + atan(n.x, n.z)/(2.0*M_PI), 1.0 - acos(clamp(n.y, -1.0, 1.0))/M_PI);
}

#ifndef MAP_PASS
// YCbCr chroma of an rgb colour
vec2 chromaOf(vec3 c){
    return vec2(-0.168736*c.r - 0.331264*c.g + 0.5*c.b, 0.5*c.r - 0.418688*c.g - 0.081312*c.b);
}
float lumaOf(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }

// tc is a position in the upright (and mirrored) camera picture; the camera texture itself
// may be lying on its side, so turn the coordinate back to the texture's own frame
vec2 camTC(vec2 tc){
    if (uCamRot < 0.5) return tc;
    if (uCamRot < 1.5) return vec2(1.0 - tc.y, tc.x);
    return vec2(tc.y, 1.0 - tc.x);
}

// How much of camera pixel tc is foreground (1) rather than background (0).
// The colour key also cleans the key colour out of edge pixels (col).
float fgAlpha(vec2 tc, inout vec3 col){
    if (uBgMode < 0.5) return 1.0;
    float a;
    if (uBgMode < 1.5) {
        // colour key: mostly chroma (shadows on the screen keep their colour), a little luma
        vec2 kc = chromaOf(uKey), cc = chromaOf(col);
        float yk = lumaOf(uKey), yc = lumaOf(col);
        float d = length(vec3(cc - kc, 0.3*(yc - yk)));
        a = smoothstep(uKeyTol, 1.6*uKeyTol + 0.02, d);
        // spill: take the key's colour cast out of the semi-transparent edge pixels
        float kl = length(kc);
        if (kl > 0.02 && a < 1.0) {
            vec2 kd = kc/kl;
            cc -= kd*max(dot(cc, kd), 0.0)*(1.0 - a);
            col = clamp(vec3(yc + 1.402*cc.y, yc - 0.344136*cc.x - 0.714136*cc.y, yc + 1.772*cc.x), 0.0, 1.0);
        }
    } else {
        a = smoothstep(0.3, 0.7, texture2D(uMask, vec2(tc.x, 1.0 - tc.y)).r);
    }
    return a;
}

// Background picture at camera coordinate tc: it hangs where your room was, so it is
// lensed like you (and shown the right way round, not mirrored). Beyond its edges it
// continues mirrored, so there is never a seam.
vec3 backdropAt(vec2 tc){
    vec2 uv = vec2(0.5 - (tc.x - 0.5)*uBdScale.x, 0.5 + (tc.y - 0.5)*uBdScale.y);
    uv = 1.0 - abs(mod(uv, 2.0) - 1.0);
    return texture2D(uBackdrop, uv).rgb;
}
// What a ray arriving from direction n shows when it does not hit the camera image: the
// star sky, or (with a background picture) the picture all around, using the same
// projection as the camera image, also for light from behind the camera. So the photon
// ring (light that went once around the black hole) shows the same picture.
vec3 skyColor(vec3 n){
    if (uUseBackdrop > 0.5) return backdropAt(vec2(0.5 - CAM_D*n.x/uCamScale.x, 0.5 + CAM_D*n.y/uCamScale.y));
    return texture2D(texturebg, skyUV(n)).rgb;
}

// Camera pixel tc, whose ray arrives from direction n.  With background removal on,
// the background part of the camera image is replaced by the star sky in that same
// direction (or by the background picture), so the person floats in front of it.
vec4 camComposite(vec2 tc, vec3 n){
    vec3 col = texture2D(textureft, camTC(tc)).rgb;
    float a = fgAlpha(tc, col);
    if (a > 0.996) return vec4(col, 1.0);
    vec3 bg = uUseBackdrop > 0.5 ? backdropAt(tc) : texture2D(texturebg, skyUV(n)).rgb;
    return vec4(mix(bg, col, a), 1.0);
}
#endif

#if defined(PROBE_PASS)
// probe: (deflection, what is shown: 0 shadow / 1 camera picture / 2 sky, n.z, 1)
#define OUT_BLACK()    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0)
#define OUT_CAM(tc, n) gl_FragColor = vec4(defl, 1.0, n.z, 1.0)
#define OUT_SKY(n)     gl_FragColor = vec4(defl, 2.0, n.z, 1.0)
#elif defined(MAP_PASS)
#define OUT_BLACK()    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0)
#define OUT_CAM(tc, n) gl_FragColor = vec4(tc, 1.0, n.z)
#define OUT_SKY(n)     gl_FragColor = vec4(n.x, n.y, 2.0, n.z)
#else
#define OUT_BLACK()    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0)
#define OUT_CAM(tc, n) gl_FragColor = camComposite(tc, n)
#define OUT_SKY(n)     gl_FragColor = vec4(skyColor(n), 1.0)
#endif

#if defined(DISPLAY_PASS)
void main(){
    vec4 m = texture2D(uLensMap, gl_FragCoord.xy / uResolution);
    if (m.z < 0.5)      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    else if (m.z < 1.5) {
        // rebuild the ray direction from the camera coordinate (inverse of the map
        // pass); the map keeps n.z in its fourth channel
        vec2 p = (0.5 - m.xy)*uCamScale;
        gl_FragColor = camComposite(m.xy, vec3(p.x/CAM_D, -p.y/CAM_D, m.w));
    }
    else                gl_FragColor = vec4(skyColor(vec3(m.x, m.y, m.w)), 1.0);   // map keeps n
}
#elif defined(RAW_PASS)
// plain (mirrored) camera image without the black hole: to pick the key colour, and
// (uShowMask) to show what is taken as background, tinted purple
void main(){
    vec2 xy = uScreen*(gl_FragCoord.xy/uResolution - 0.5);
    vec2 tc = vec2(0.5 - xy.x/uCamScale.x, 0.5 + xy.y/uCamScale.y);
    vec3 col = texture2D(textureft, camTC(tc)).rgb;
    if (uShowMask > 0.5) col = mix(vec3(0.38, 0.0, 0.34), col, fgAlpha(tc, col));
    gl_FragColor = vec4(col, 1.0);
}
#else
void main(){
#ifdef PROBE_PASS
    // one probe line per row (4 rows), one sample per column, from the centre outwards
    float row = floor(gl_FragCoord.y);
    vec4 pick = row < 0.5 ? vec4(1.0, 0.0, 0.0, 0.0) : row < 1.5 ? vec4(0.0, 1.0, 0.0, 0.0)
              : row < 2.5 ? vec4(0.0, 0.0, 1.0, 0.0) : vec4(0.0, 0.0, 0.0, 1.0);
    float ang = dot(pick, uProbeAng);
    float rr  = mix(dot(pick, uProbeFrom), dot(pick, uProbeTo), (floor(gl_FragCoord.x) + 0.5)/uProbeN);
    float x = rr*cos(ang);
    float y = rr*sin(ang);
#else
    float x = uScreen.x*(gl_FragCoord.x/uResolution.x - 0.5);
    float y = uScreen.y*(gl_FragCoord.y/uResolution.y - 0.5);
#endif
    float mag = length(vec2(x, y));
    bool useKerr = uSpin >= 1.0e-4;
    if (!useKerr && mag*mag <= 27.0*M*M) { OUT_BLACK(); return; }
    float omega = atan(y, x);
    float phi0  = asin(clamp(mag/CAM_D, 0.0, 1.0));
    vec3 n; float defl;
    if (useKerr) {
        if (!kerrLens(mag, omega, phi0, n, defl)) { OUT_BLACK(); return; }
    } else {
        float dps = psimax(mag/M) - M_PI;
        float vb  = phi0 - dps*PsiScale;
        n = vec3(sin(vb)*cos(omega), sin(vb)*sin(omega), cos(vb));
        defl = dps*PsiScale;
    }
    float newx =  CAM_D*n.x;
    float newy = -CAM_D*n.y;
    vec2 tc = vec2(1.0 - (newx/uCamScale.x + 0.5), 1.0 - (newy/uCamScale.y + 0.5));   // mirrored, like a mirror
    float Rfov = min(uScreen.x, uScreen.y)*uRing;
    bool inCircle = length(vec2(newx, newy)) < Rfov;
    bool barely   = abs(defl) < uTol;
    bool inRect   = tc.x >= 0.0 && tc.x <= 1.0 && tc.y >= 0.0 && tc.y <= 1.0;
    if (inCircle || (barely && inRect)) { OUT_CAM(tc, n); }
    else                                { OUT_SKY(n); }
}
#endif
`;
