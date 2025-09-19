// bake.js — full-featured baker with selectable wall mode and advanced tunables.
// Includes: sleep only deep in bottom (no neck sleep), strict outside culling, Linux-safe sparse finalize,
// wall-slip and bias assists, optional unclog wobble/pulses, and both rectangle & seam-free capsule walls.
import fs from "fs";
import path from "path";
import Matter from "matter-js";
const { Engine, World, Bodies, Body, Composite, Runner, Sleeping } = Matter;

/* -------------------- tiny args parser -------------------- */
const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) {
  const k = argv[i];
  if (k.startsWith("--")) {
    const key = k.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) args[key] = true;
    else { args[key] = next; i++; }
  }
}
const num  = (k, d) => (args[k] !== undefined ? Number(args[k]) : d);
const bool = (k)    => Boolean(args[k]);
const str  = (k, d) => (args[k] ?? d);

/* -------------------- inputs -------------------- */
const id           = str("id", `${Date.now()}`);
const duration     = num("duration", 10);
const fps          = num("fps", 60);
const grainsN      = num("grains", 800);
const full         = num("full", 1);
const neck         = num("neck", 18);
const H            = num("H", 500);
const bulb         = num("bulb", 220);
const r            = num("r", 2);
const k            = num("k", 0.1); // compatibility placeholder
const bounce       = num("bounce", 0.12);
const friction     = num("friction", 0.02);
const tiltDeg      = num("tiltDeg", 0);
const c1           = num("c1", 0.0);
const c2           = num("c2", 0.0);
const slat         = num("slat", 0);
const wallThicknessArg = num("wallThickness", 0); // 0 => auto
const wallMode     = str("wallMode", "capsule");  // "rect" | "capsule"
const sleepVel     = num("sleepVel", 2);
const sleepMs      = num("sleepMs", 500);
const sleepMode    = str("sleepMode", "static");  // "static" | "sleep" | "remove"
const flushMaxSec  = num("flushMaxSec", 15);
const noFlush      = bool("noFlush");
const outDir       = str("outDir", "bakes");
const outputMode   = str("outputMode", "sparse"); // dense|sparse
const Q            = num("Q", 32);
const sparseThresholdPx = num("sparseThresholdPx", 1 / Q);
const progress     = bool("progress");

/* ----- stability helpers ----- */
const SUBSTEPS     = Math.max(1, Math.round(60 / Math.max(1, fps)));
const MAX_SPEED    = num("maxSpeed", 24);

/* ----- outside culling controls ----- */
const outsideKillPad      = num("outsideKillPad", 0.5);
const outsideCullFrames   = Math.max(1, num("outsideCullFrames", 2));
const hardKillPad         = num("hardKillPad", 0.2);
const strictKillPad       = num("strictKillPad", 0.15);

/* -------------------- sleep bands -------------------- */
// Only allow sleep deep in the *bottom* bulb AND far enough from the neck
const sleepOnlyBelowFrac = num("sleepOnlyBelowFrac", 0.58);
const neckNoSleepBandPx  = num("neckNoSleepBandPx", Math.max(80, neck * 3));   // forbid sleep within +/- band around neck
const bottomSleepBandPx  = num("bottomSleepBandPx", Math.round(H * 0.35));     // require we are within this distance from bottom
const sleepOnlyBelowY    = Math.max(sleepOnlyBelowFrac * H, H - bottomSleepBandPx);

/* -------------------- unclog helpers (optional wobble/pulses) -------------------- */
const unclogAssist = bool("unclogAssist");
const vibeAmpBaseDeg   = num("vibeAmpDeg", 0.25);
const vibeHz           = num("vibeHz", 2.0);
const unclogDelaySec   = num("antiClogPeriod", 0.30);
const rescueTopCount   = num("rescueTopCount", 25);
const vibeAmpMaxDeg    = num("antiClogMaxAmpDeg", 4.5);
const pulseEverySec    = num("antiClogPulseEvery", 0.12);
const pulseZoneY       = num("antiClogZoneY", 30);
const pulseBottomToo   = bool("pulseBottomToo"); // if true, allow pulses below neck too
const pulseForce       = num("antiClogPulseForce", 1.0e-5);
const rescueDownBias   = num("antiClogDownBias", 4.0e-6);

/* --- wall-slip detacher --- */
const wallSlipPx         = num("wallSlipPx", Math.max(0.4, r*0.6));
const wallSlipVel        = num("wallSlipVel", 0.25);
const wallSlipKickF      = num("wallSlipKickF", 1.2e-4);
const wallSlipKickDownF  = num("wallSlipKickDownF", 4.0e-5);
const wallSlipCooldownMs = num("wallSlipCooldownMs", 250);

/* --- gentle inward/down bias near upper walls --- */
const wallBiasBandPx   = num("wallBiasBandPx", Math.max(14, r*6));
const wallBiasInF      = num("wallBiasInF", 1.6e-4);
const wallBiasDownF    = num("wallBiasDownF", 6.0e-5);

/* -------------------- world/engine -------------------- */
const DT = 1 / fps;
const WORLD_W = bulb * 2 + 80;
const WORLD_H = H * 2 + 80;

const engine = Engine.create();
engine.enableSleeping = true;
engine.positionIterations = 14;
engine.velocityIterations = 10;
engine.constraintIterations = 4;

const baseTiltRad = tiltDeg * Math.PI / 180;
engine.gravity.x = Math.sin(baseTiltRad);
engine.gravity.y = Math.cos(baseTiltRad);

const sinT = Math.sin(baseTiltRad);
const cosT = Math.cos(baseTiltRad);
const localY = (p) => (-p.x * sinT) + (p.y * cosT);

/* -------------------- hourglass profile -------------------- */
function xHalf(y) {
  const ay = Math.abs(y);
  const t = Math.min(1, ay / H);
  const bump = t * (1 - t);
  let s = t + c1 * bump + c2 * (2 * bump * (t - 0.5));
  s = Math.max(0, Math.min(1, s));
  return (neck / 2) + (bulb - neck / 2) * s;
}

/* -------------------- walls -------------------- */
const wallThickness = wallThicknessArg > 0 ? wallThicknessArg : Math.max(12, Math.ceil(r * 4));

function buildWallsRect() {
  const segs = 240;
  const thickness = wallThickness;
  const halfT = thickness / 2;
  const overlap = thickness * 3.0;
  const yMin = -H, yMax = H;
  const dy = (yMax - yMin) / segs;
  const wallOpts = (angle) => ({ isStatic: true, angle, friction: 0, frictionStatic: 0, restitution: 0 });
  const bodies = [];
  for (let i = 0; i < segs; i++) {
    const y0 = yMin + i * dy;
    const y1 = yMin + (i + 1) * dy;
    const xm0 = xHalf(y0), xm1 = xHalf(y1);
    // left
    {
      const p0 = { x: -xm0, y: y0 }, p1 = { x: -xm1, y: y1 };
      const dx = p1.x - p0.x, dyS = p1.y - p0.y;
      const len = Math.hypot(dx, dyS) + overlap;
      const ang = Math.atan2(dyS, dx);
      let nx = -dyS, ny = dx; const nl = Math.hypot(nx, ny) || 1; nx/=nl; ny/=nl; if (nx>0){nx=-nx;ny=-ny;}
      const cx=(p0.x+p1.x)/2+nx*halfT, cy=(p0.y+p1.y)/2+ny*halfT;
      bodies.push(Bodies.rectangle(cx, cy, len, thickness, wallOpts(ang)));
    }
    // right
    {
      const p0 = { x: +xm0, y: y0 }, p1 = { x: +xm1, y: y1 };
      const dx = p1.x - p0.x, dyS = p1.y - p0.y;
      const len = Math.hypot(dx, dyS) + overlap;
      const ang = Math.atan2(dyS, dx);
      let nx = -dyS, ny = dx; const nl = Math.hypot(nx, ny) || 1; nx/=nl; ny/=nl; if (nx<0){nx=-nx;ny=-ny;}
      const cx=(p0.x+p1.x)/2+nx*halfT, cy=(p0.y+p1.y)/2+ny*halfT;
      bodies.push(Bodies.rectangle(cx, cy, len, thickness, wallOpts(ang)));
    }
  }
  if (slat > 0) bodies.push(Bodies.rectangle(0, 0, slat, thickness, { isStatic:true, friction:0, frictionStatic:0, restitution:0 }));
  // bottom floor only
  bodies.push(Bodies.rectangle(0,  H + halfT, WORLD_W, thickness, { isStatic:true }));
  bodies.forEach(b => World.add(engine.world, b));
}
function buildWallsCapsule() {
  const rad = wallThickness / 2;
  const segs = 420;
  const dy = (2*H) / segs;
  const eps = 1e-3;
  const circleOpts = { isStatic:true, friction:0, frictionStatic:0, restitution:0, label:"wall" };
  const normalAt = (y) => {
    const dxdy = (xHalf(Math.min(H, y+eps)) - xHalf(Math.max(-H, y-eps))) / (2*eps);
    const nx = 1, ny = -dxdy;
    const inv = 1/Math.hypot(nx,ny);
    return { nx:nx*inv, ny:ny*inv };
  };
  for (let i=0;i<=segs;i++){
    const y = -H + i*dy;
    // right
    {
      const x = xHalf(y);
      const {nx,ny} = normalAt(y);
      const cx = x + nx*rad, cy = y + ny*rad;
      World.add(engine.world, Bodies.circle(+cx, cy, rad, circleOpts));
    }
    // left
    {
      const x = xHalf(y);
      const {nx,ny} = normalAt(y);
      const cx = -(x + nx*rad), cy = y + ny*rad;
      World.add(engine.world, Bodies.circle(+cx, cy, rad, circleOpts));
    }
  }
  if (slat > 0) World.add(engine.world, Bodies.rectangle(0, 0, slat, wallThickness, { isStatic:true, friction:0, frictionStatic:0, restitution:0 }));
  World.add(engine.world, Bodies.rectangle(0,  H + rad, WORLD_W, wallThickness, { isStatic:true }));
}
// build chosen mode
if (wallMode === "capsule") buildWallsCapsule(); else buildWallsRect();

/* -------------------- helper: inside test -------------------- */
function fullyInsideCircle(p) {
  const y = p.y;
  if (y < -H - 2 || y > H + 2) return false;
  const limit = xHalf(y) - (r + outsideKillPad);
  return Math.abs(p.x) <= limit;
}

/* -------------------- seed grains -------------------- */
const grains = [];
const topYmin = -H + 20, topYmax = -10;
const maxTries = grainsN * 60;
let placed = 0, tries = 0;

function tryPlace(y) {
  const xBound = Math.max(4, xHalf(y) - r - 2);
  const x = (Math.random()*2 - 1) * xBound;
  const circle = Bodies.circle(x, y, r, {
    restitution: Math.max(0, Math.min(1, bounce)),
    friction: Math.max(0, Math.min(1, friction)),
    frictionStatic: 0,
    frictionAir: 0.003,
    density: 0.001
  });
  for (const g of grains) {
    const dx=g.position.x-circle.position.x, dy=g.position.y-circle.position.y;
    if (dx*dx + dy*dy < (r*2 + 0.5)**2) return false;
  }
  circle._sleepAccum = 0;
  circle._prevLocalY = localY(circle.position);
  circle._stuckAccum = 0;
  circle._lastKickAt = -1e9;
  circle._lastPos = { x: circle.position.x, y: circle.position.y };
  circle._outsideCount = 0;
  grains.push(circle); World.add(engine.world, circle);
  return true;
}
while (placed < grainsN && tries < maxTries) { tries++; const y = topYmin + Math.random() * (topYmax - topYmin); if (tryPlace(y)) placed++; }
while (placed < grainsN) { const y = -H + 30 - placed * (2*r + 0.2); if (tryPlace(y)) placed++; }

/* -------------------- output -------------------- */
const nameBase = `hourglass_${duration}s_neck${neck}_g${grainsN}_${wallMode}_${outputMode}_Q${Q}_${id}`;
const jsonPath = path.join(outDir, `${nameBase}.json`);
fs.mkdirSync(outDir, { recursive: true });

const clamp = (v, lo, hi) => (v < lo ? lo : (v > hi ? hi : v));
const qx = (x) => clamp(Math.round((x + bulb + 5) * Q), 0, 65535);
const qy = (y) => clamp(Math.round((y + H + 5) * Q), 0, 65535);

let binStream = null, sbinStream = null;
let lastQ = new Array(grainsN).fill(null);
function writeU16(s,v){ const b=Buffer.allocUnsafe(2); b.writeUInt16LE(v,0); s.write(b); }
function writeU32(s,v){ const b=Buffer.allocUnsafe(4); b.writeUInt32LE(v,0); s.write(b); }
function writeVarint(s,v){ let n=v>>>0; while(n>=0x80){ s.write(Buffer.from([(n&0x7f)|0x80])); n>>>=7; } s.write(Buffer.from([n])); }

const binFsPath  = path.join(outDir, `${nameBase}.bin`);
const sbinFsPath = path.join(outDir, `${nameBase}.sbin`);

if (outputMode === "dense") {
  binStream = fs.createWriteStream(binFsPath);
} else {
  sbinStream = fs.createWriteStream(sbinFsPath);
  sbinStream.write(Buffer.from("HGSB")); writeU16(sbinStream, Q); writeU32(sbinStream, grainsN); writeU32(sbinStream, 0);
}

/* -------------------- sim state -------------------- */
const targetFrames = Math.round(duration * fps);
let frames = 0;
let lastCrossFrame = null;
let stallFrames = 0;
let pulseAccum = 0;

/* -------------------- helpers -------------------- */
function topBulbEmptyNow() {
  for (const g of grains) {
    if (g._removed) continue;
    if (!fullyInsideCircle(g.position)) continue;
    if (localY(g.position) < -r * 0.5) return false;
  }
  return true;
}
function countTopInside() {
  let n = 0;
  for (const g of grains) {
    if (g._removed) continue;
    if (!fullyInsideCircle(g.position)) continue;
    if (localY(g.position) < 0) n++;
  }
  return n;
}
function recordFrame() {
  if (outputMode === "dense") {
    for (let i=0;i<grains.length;i++){ const g=grains[i]; writeU16(binStream, qx(g.position.x)); writeU16(binStream, qy(g.position.y)); }
  } else {
    const thQ = Math.max(1, Math.round(sparseThresholdPx * Q));
    const changed = [];
    for (let i=0;i<grains.length;i++){
      const g=grains[i]; const px=qx(g.position.x), py=qy(g.position.y); const prev=lastQ[i];
      if (frames===0 || !prev || Math.abs(prev[0]-px)>=thQ || Math.abs(prev[1]-py)>=thQ){ changed.push([i,px,py]); lastQ[i]=[px,py]; }
    }
    writeU16(sbinStream, changed.length);
    for (const [idx, px, py] of changed){ writeVarint(sbinStream, idx); writeU16(sbinStream, px); writeU16(sbinStream, py); }
  }
}
function emitProgress(){ if (progress) console.log("BAKE " + JSON.stringify({event:"progress", frame:frames, target:targetFrames})); }
function emitMeta(){
  console.log("BAKE " + JSON.stringify({
    event:"meta", grains:grainsN, fps, duration, neck, bulb, H, r, bounce, friction, Q, mode:outputMode, wallMode,
    wallThickness, sleepOnlyBelowFrac, neckNoSleepBandPx, bottomSleepBandPx, sleepOnlyBelowY,
    outsideKillPad, outsideCullFrames, hardKillPad, strictKillPad, unclogAssist,
    wallSlipPx, wallSlipVel, wallSlipKickF, wallSlipKickDownF, wallSlipCooldownMs,
    wallBiasBandPx, wallBiasInF, wallBiasDownF
  }));
}
emitMeta();

/* -------------------- anti-clog helpers -------------------- */
function currentVibeAmpDeg(topCount) {
  const stallSec = stallFrames / fps;
  let amp = vibeAmpBaseDeg;
  if (stallSec > unclogDelaySec) {
    const t = Math.min(1, (stallSec - unclogDelaySec) / 1.2);
    amp = vibeAmpBaseDeg + (vibeAmpMaxDeg - vibeAmpBaseDeg) * (0.5 - 0.5*Math.cos(Math.PI*t));
  }
  if (topCount <= rescueTopCount) amp = Math.max(amp, vibeAmpMaxDeg);
  return amp;
}
function pulseNeck(topCount) {
  const baseBand = pulseZoneY;
  const wideBand = Math.min(H, Math.max(80, 0.18 * H));
  const yBand = (topCount <= rescueTopCount) ? Math.max(baseBand, wideBand) : baseBand;
  const every = (topCount <= rescueTopCount) ? Math.min(pulseEverySec, 0.08) : pulseEverySec;
  if (pulseAccum < every) return;
  pulseAccum = 0;
  for (const g of grains) {
    if (g._removed) continue;
    const p = g.position;
    const yLoc = localY(p);
    if (Math.abs(yLoc) > yBand) continue;
    if (!pulseBottomToo && yLoc >= 0) continue;
    const xLimit = xHalf(yLoc) - (r + outsideKillPad);
    if (Math.abs(p.x) > xLimit + r*0.5) continue;
    const fx = (Math.random() - 0.5) * pulseForce * 2;
    const fy = (Math.random() - 0.5) * pulseForce * 0.6 + (yLoc < 0 ? +rescueDownBias : 0);
    Body.applyForce(g, p, { x: fx, y: fy });
  }
}

/* -------------------- outside culling -------------------- */
function shouldCullOutside(g) {
  const p = g.position;
  if (Math.abs(p.x) > bulb + 48 || p.y < -H - 48 || p.y > H + 48) return true;
  const limit = xHalf(p.y);
  const dx = Math.abs(p.x) - limit;
  if (dx > strictKillPad) return true;
  if (dx > (r + hardKillPad)) return true;
  if (dx > (r + outsideKillPad)) {
    g._outsideCount = (g._outsideCount || 0) + 1;
    if (g._outsideCount >= outsideCullFrames) return true;
  } else {
    g._outsideCount = 0;
  }
  return false;
}

/* -------------------- loop -------------------- */
const runner = Runner.create({ isFixed:true, delta:DT });
function stepOnce() {
  for (const g of grains) {
    if (g._removed) continue;
    if (shouldCullOutside(g)) { Composite.remove(engine.world, g); g._removed = true; continue; }
  }

  // Sleep only deep in bottom bulb AND far from neck
  for (const g of grains) {
    if (g._removed) continue;
    const yLoc = localY(g.position);
    const speed = Math.hypot(g.velocity.x, g.velocity.y);
    const farFromNeck = (yLoc >= neckNoSleepBandPx);
    const deepBottom  = (yLoc >= sleepOnlyBelowY);
    if (farFromNeck && deepBottom) {
      if (!g.isStatic) {
        if (speed < sleepVel) g._sleepAccum = (g._sleepAccum || 0) + DT*1000; else g._sleepAccum = 0;
        if (g._sleepAccum >= sleepMs) {
          if (sleepMode === "remove") {
            Composite.remove(engine.world, g); g._removed = true; continue;
          } else if (sleepMode === "sleep") {
            Sleeping.set(g, true); g._softSleeping = true; g._sleepAccum = 0;
          } else {
            Body.setVelocity(g, {x:0,y:0});
            Body.setAngularVelocity(g, 0);
            Body.setStatic(g, true);
            g.isSensor = false;
            g._sleepAccum = 0;
          }
        }
      }
    } else {
      g._sleepAccum = 0;
    }
    g._prevLocalY = yLoc;
  }

  // Anti-stick above the neck + wall slip + gentle bias
  const nowMs = frames / fps * 1000;
  for (const g of grains) {
    if (g._removed) continue;
    const p = g.position;
    const yLoc = localY(p);
    if (yLoc >= 0) continue;

    const dx = p.x - (g._lastPos?.x ?? p.x);
    const dy = p.y - (g._lastPos?.y ?? p.y);
    const moved = Math.hypot(dx, dy);
    const spd = Math.hypot(g.velocity.x, g.velocity.y);

    // stick kick
    const stuckVelPx = 0.18, stuckDistPx = 0.25, stuckKickAfterMs = 1000, stuckKickCooldownMs = 300;
    const stuckKickF = 1.8e-4, stuckKickInwardF = 1.2e-4;

    if (spd < stuckVelPx && moved < stuckDistPx) g._stuckAccum = (g._stuckAccum || 0) + DT*1000; else g._stuckAccum = 0;
    if (g._stuckAccum >= stuckKickAfterMs && (nowMs - (g._lastKickAt||-1e9)) >= stuckKickCooldownMs) {
      const inward = (p.x >= 0) ? -1 : +1;
      Body.applyForce(g, p, { x: inward * stuckKickInwardF, y: +stuckKickF });
      g._lastKickAt = nowMs;
    }

    // wall slip
    const limit = xHalf(yLoc) - (r + 0.05);
    const nearWall = Math.abs(Math.abs(p.x) - limit) <= wallSlipPx;
    if (nearWall && spd < wallSlipVel) {
      const last = g._lastWallKickAt || -1e9;
      if (nowMs - last >= wallSlipCooldownMs) {
        const inward = (p.x >= 0) ? -1 : +1;
        Body.applyForce(g, p, { x: inward * wallSlipKickF, y: wallSlipKickDownF });
        g._lastWallKickAt = nowMs;
      }
    }

    // gentle bias band
    const limit2 = xHalf(yLoc) - (r + 0.05);
    const dist = Math.abs(limit2 - Math.abs(p.x));
    if (dist <= wallBiasBandPx) {
      const inward = (p.x >= 0) ? -1 : +1;
      Body.applyForce(g, p, { x: inward * wallBiasInF, y: wallBiasDownF });
    }

    g._lastPos = { x: p.x, y: p.y };
  }

  // Optional unclog wobble & pulses
  if (unclogAssist) {
    const topCount = countTopInside();
    const tSec = frames / fps;
    const amp = currentVibeAmpDeg(topCount);
    const ang = (tiltDeg + amp * Math.sin(2 * Math.PI * vibeHz * tSec)) * Math.PI/180;
    engine.gravity.x = Math.sin(ang);
    engine.gravity.y = Math.cos(ang);

    const flowed = grains.some(g => !g._removed && g._prevLocalY < 0 && localY(g.position) >= 0);
    if (flowed) { stallFrames = 0; pulseAccum = 0; } else { stallFrames++; pulseAccum += DT; }
    const stalled = (stallFrames / fps) > unclogDelaySec;
    if (stalled) pulseNeck(topCount);
  } else {
    const ang = tiltDeg * Math.PI/180;
    engine.gravity.x = Math.sin(ang);
    engine.gravity.y = Math.cos(ang);
  }

  // Substeps + clamp
  const dtMs = (DT * 1000) / SUBSTEPS;
  for (let s=0; s<SUBSTEPS; s++) Engine.update(engine, dtMs);
  for (const g of grains) {
    if (g._removed) continue;
    const vx = g.velocity.x, vy = g.velocity.y, sp = Math.hypot(vx,vy);
    if (sp > MAX_SPEED) { const m = MAX_SPEED/sp; Body.setVelocity(g, {x:vx*m,y:vy*m}); }
  }

  if (lastCrossFrame == null && topBulbEmptyNow()) lastCrossFrame = frames;

  recordFrame();
  frames++;
  if (progress && (frames % Math.max(1, Math.floor(fps/2)) === 0)) emitProgress();
}

let done = false;
const tMax = Date.now() + flushMaxSec * 1000;

function finalizeAndWrite() {
  const json = {
    meta: { duration, fps, grains:grainsN, full, neck, H, bulb, r, k, bounce, friction, tiltDeg, slat, c1, c2, Q, mode:outputMode, wallMode,
            wallThickness, sleepOnlyBelowFrac, neckNoSleepBandPx, bottomSleepBandPx, sleepOnlyBelowY,
            outsideKillPad, outsideCullFrames, hardKillPad, strictKillPad, unclogAssist,
            wallSlipPx, wallSlipVel, wallSlipKickF, wallSlipKickDownF, wallSlipCooldownMs,
            wallBiasBandPx, wallBiasInF, wallBiasDownF },
    frames, fps,
    lastCrossFrame: lastCrossFrame ?? null,
    ...(outputMode === "dense" ? { bin:  "/" + path.posix.join("bakes", `${nameBase}.bin`) } : { sbin: "/" + path.posix.join("bakes", `${nameBase}.sbin`) })
  };
  fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2), "utf-8");

  const indexPath = path.join(outDir, "index.json");
  let idx = []; try { idx = JSON.parse(fs.readFileSync(indexPath, "utf-8")); } catch {}
  const entry = { file:path.posix.join("bakes", path.basename(jsonPath)), label:nameBase, duration, fps, grains:grainsN, neck, c1, c2, lastCrossFrame: lastCrossFrame ?? null, date:new Date().toISOString() };
  const i = idx.findIndex(e => e.file === entry.file);
  if (i >= 0) idx[i] = entry; else idx.push(entry);
  idx.sort((a,b)=> new Date(b.date) - new Date(a.date));
  fs.writeFileSync(indexPath, JSON.stringify(idx, null, 2), "utf-8");

  console.log("BAKE " + JSON.stringify({ event:"done", file:path.posix.join("bakes", path.basename(jsonPath)), frames, fps, lastCrossFrame: lastCrossFrame ?? null }));
}

function loop() {
  if (done) return;
  if (frames < targetFrames) { stepOnce(); return setImmediate(loop); }

  if (noFlush) {
    done = true;
  } else {
    if (topBulbEmptyNow() || Date.now() >= tMax) done = true;
    else { stepOnce(); return setImmediate(loop); }
  }

  if (outputMode === "dense") {
    binStream.end(() => finalizeAndWrite());
  } else {
    // Linux-safe: patch frames after stream finished
    sbinStream.end(() => {
      const fd = fs.openSync(sbinFsPath, "r+");
      const buf = Buffer.allocUnsafe(4); buf.writeUInt32LE(frames, 0);
      fs.writeSync(fd, buf, 0, 4, 10); // offset 10 in header
      fs.closeSync(fd);
      finalizeAndWrite();
    });
  }
}

setImmediate(loop);
