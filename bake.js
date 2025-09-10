// bake.js
import fs from "fs";
import path from "path";
import Matter from "matter-js";
const { Engine, World, Bodies, Body, Composite, Runner } = Matter;

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
const grainsN      = num("grains", 500);
const full         = num("full", 1);
const neck         = num("neck", 12);
const H            = num("H", 500);
const bulb         = num("bulb", 220);
const r            = num("r", 2);
const bounce       = num("bounce", 0.12);
const friction     = num("friction", 0.02);
const tiltDeg      = num("tiltDeg", 0);
const c1           = num("c1", 0.0);
const c2           = num("c2", 0.0);
const slat         = num("slat", 0);
const wallThicknessArg = num("wallThickness", 0); // 0 => auto
const sleepVel     = num("sleepVel", 2);
const sleepMs      = num("sleepMs", 500);
const flushMaxSec  = num("flushMaxSec", 15);
const noFlush      = bool("noFlush");
const outDir       = str("outDir", "bakes");
const outputMode   = str("outputMode", "dense"); // dense|sparse
const Q            = num("Q", 32);
const progress     = bool("progress");
const sparseThresholdPx = num("sparseThresholdPx", 1 / Q);

/* -------------------- sleep only deep in bottom bulb -------------------- */
const sleepOnlyBelowFrac = num("sleepOnlyBelowFrac", 0.58); // allow sleep below 58% of height
const sleepOnlyBelowY = H * sleepOnlyBelowFrac;

/* -------------------- anti-clog wobble/pulse -------------------- */
const vibeAmpBaseDeg   = num("vibeAmpDeg", 0.25);
const vibeHz           = num("vibeHz", 2.0);
const unclogDelaySec   = num("antiClogPeriod", 0.30);
const rescueTopCount   = num("rescueTopCount", 25);
const vibeAmpMaxDeg    = num("antiClogMaxAmpDeg", 4.5);
const pulseEverySec    = num("antiClogPulseEvery", 0.12);
const pulseZoneY       = num("antiClogZoneY", 30);
const pulseTopOnly     = !bool("pulseBottomToo");
const pulseForce       = num("antiClogPulseForce", 1.0e-5);
const rescueDownBias   = num("antiClogDownBias", 4.0e-6); // +Y is downward

/* -------------------- flushers: now ONLY below the neck -------------------- */
const useFlushers      = !bool("noFlushers");
const flusherCount     = num("flusherCount", 2);
const flusherR         = num("flusherR", Math.max(1, r * 1.5));
const flusherAmp       = num("flusherAmp", Math.max(4, neck * 0.35));
// IMPORTANT: start just *below* the neck (positive y). Never collide above y<0.
const flusherYTop      = num("flusherY", Math.max(6, r * 3)); // +y (below neck)
const flusherHz        = num("flusherHz", 1.7);
const flusherTopCount  = num("flusherTopCount", 40);
// Downward pass parameters
const sweepDepthY      = num("flusherDepthY", Math.max(14, r * 6)); // travel depth into bottom bulb (+y)
const sweepDownSec     = num("flusherSweepDownSec", 0.35);
const sweepHoldSec     = num("flusherSweepHoldSec", 0.10);
const sweepCooldownSec = num("flusherCooldownSec", 0.40);
// How close to the inner wall (px)
const flusherEdgeGap   = num("flusherEdgeGap", Math.max(0.5, r * 0.4));
// Safety: never collide above the neck
const flusherNeverAboveNeck = true;

/* -------------------- per-grain anti-stick (above neck) -------------------- */
const stuckKickAfterMs     = num("stuckKickAfterMs", 1000);
const stuckVelPx           = num("stuckVelPx", 0.18);
const stuckDistPx          = num("stuckDistPx", 0.25);
const stuckKickF           = num("stuckKickF", 1.8e-4);
const stuckKickInwardF     = num("stuckKickInwardF", 1.2e-4);
const stuckKickCooldownMs  = num("stuckKickCooldownMs", 300);
const stuckInjectAfterMs   = num("stuckInjectAfterMs", 1800);
const stuckInjectVy        = num("stuckInjectVy", 0.8);
const stuckInjectVx        = num("stuckInjectVx", 0.4);

/* -------------------- world/engine -------------------- */
const DT = 1 / fps;
const WORLD_W = bulb * 2 + 80;
const WORLD_H = H * 2 + 80;

const engine = Engine.create();
engine.positionIterations = 12;
engine.velocityIterations = 8;
engine.constraintIterations = 4;

const baseTiltRad = tiltDeg * Math.PI / 180;
// Tilt gravity only (container stays unrotated)
engine.gravity.x = Math.sin(baseTiltRad);
engine.gravity.y = Math.cos(baseTiltRad);

// Local coordinates (unrotated frame)
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

/* -------------------- walls: outward thickness only -------------------- */
const wallThickness = wallThicknessArg > 0 ? wallThicknessArg : Math.max(12, Math.ceil(r * 4));
function buildWalls() {
  const segs = 200;
  const thickness = wallThickness;
  const halfT = thickness / 2;
  const overlap = thickness * 1.6;
  const yMin = -H, yMax = H;
  const dy = (yMax - yMin) / segs;
  const wallOpts = (angle) => ({ isStatic: true, angle, friction: 0, frictionStatic: 0, restitution: 0 });

  const bodies = [];
  for (let i = 0; i < segs; i++) {
    const y0 = yMin + i * dy;
    const y1 = yMin + (i + 1) * dy;
    const xm0 = xHalf(y0), xm1 = xHalf(y1);

    // left
    { const p0 = { x: -xm0, y: y0 }, p1 = { x: -xm1, y: y1 };
      const dx=p1.x-p0.x, dyS=p1.y-p0.y, segLen=Math.hypot(dx,dyS), len=segLen+overlap, ang=Math.atan2(dyS,dx);
      let nx=-dyS, ny=dx; const nl=Math.hypot(nx,ny)||1; nx/=nl; ny/=nl; if (nx>0){nx=-nx;ny=-ny;}
      const cx=(p0.x+p1.x)/2+nx*halfT, cy=(p0.y+p1.y)/2+ny*halfT;
      bodies.push(Bodies.rectangle(cx, cy, len, thickness, wallOpts(ang)));
    }
    // right
    { const p0 = { x: +xm0, y: y0 }, p1 = { x: +xm1, y: y1 };
      const dx=p1.x-p0.x, dyS=p1.y-p0.y, segLen=Math.hypot(dx,dyS), len=segLen+overlap, ang=Math.atan2(dyS,dx);
      let nx=-dyS, ny=dx; const nl=Math.hypot(nx,ny)||1; nx/=nl; ny/=nl; if (nx<0){nx=-nx;ny=-ny;}
      const cx=(p0.x+p1.x)/2+nx*halfT, cy=(p0.y+p1.y)/2+ny*halfT;
      bodies.push(Bodies.rectangle(cx, cy, len, thickness, wallOpts(ang)));
    }
  }
  if (slat > 0) bodies.push(Bodies.rectangle(0, 0, slat, thickness, { isStatic:true, friction:0, frictionStatic:0, restitution:0 }));
  bodies.push(Bodies.rectangle(0, -H - halfT, WORLD_W, thickness, { isStatic:true }));
  bodies.push(Bodies.rectangle(0,  H + halfT, WORLD_W, thickness, { isStatic:true }));
  bodies.forEach(b => World.add(engine.world, b));
}
buildWalls();

/* -------------------- helper: inside test -------------------- */
const insideMargin = Math.max(1, Math.ceil(r * 0.75));
function isInside(p) {
  const y = p.y;
  if (y < -H - 2 || y > H + 2) return false;
  const limit = xHalf(y) - insideMargin;
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
    frictionAir: 0.002,
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
  grains.push(circle); World.add(engine.world, circle);
  return true;
}
while (placed < grainsN && tries < maxTries) { tries++; const y = topYmin + Math.random() * (topYmax - topYmin); if (tryPlace(y)) placed++; }
while (placed < grainsN) { const y = -H + 30 - placed * (2*r + 0.2); if (tryPlace(y)) placed++; }

/* -------------------- build flushers (parked offscreen) -------------------- */
const flushers = [];
function buildFlushers() {
  if (!useFlushers || flusherCount <= 0) return;
  for (let i=0;i<flusherCount;i++){
    const b = Bodies.circle(0, -H - 1000, flusherR, {
      isStatic: true,
      isSensor: true, // parked as sensors
      friction: 0, frictionStatic: 0, restitution: 0,
      collisionFilter: { group: 0, category: 0x0002, mask: 0xFFFF },
      label: "flusher"
    });
    flushers.push(b);
    World.add(engine.world, b);
  }
}
buildFlushers();

/* -------------------- output -------------------- */
const nameBase = `hourglass_${duration}s_neck${neck}_g${grainsN}_${outputMode}_Q${Q}_${id}`;
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

if (outputMode === "dense") {
  binStream = fs.createWriteStream(path.join(outDir, `${nameBase}.bin`));
} else {
  sbinStream = fs.createWriteStream(path.join(outDir, `${nameBase}.sbin`));
  sbinStream.write(Buffer.from("HGSB")); writeU16(sbinStream, Q); writeU32(sbinStream, grainsN); writeU32(sbinStream, 0);
}

/* -------------------- sim state -------------------- */
const targetFrames = Math.round(duration * fps);
let frames = 0;
let lastCrossFrame = null;
let lastFlowFrame = 0;
let stallFrames = 0;
let pulseAccum = 0;

// flusher FSM: "idle" | "down" | "hold" | "cooldown"
let flState = "idle";
let flStateT = 0;

/* -------------------- helpers -------------------- */
function topBulbEmptyNow() {
  for (const g of grains) {
    if (g._removed) continue;
    if (!isInside(g.position)) continue;
    if (localY(g.position) < -r * 0.5) return false;
  }
  return true;
}
function countTopInside() {
  let n = 0;
  for (const g of grains) {
    if (g._removed) continue;
    if (!isInside(g.position)) continue;
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
    event:"meta", grains:grainsN, fps, duration, neck, bulb, H, r, bounce, friction, Q, mode:outputMode,
    wallThickness, sleepOnlyBelowFrac,
    antiClog:{ vibeAmpBaseDeg, vibeAmpMaxDeg, vibeHz, unclogDelaySec, rescueTopCount, pulseEverySec, pulseZoneY, pulseTopOnly, pulseForce, rescueDownBias },
    flushers: { useFlushers, flusherCount, flusherR, flusherAmp, flusherYTop, flusherHz, flusherTopCount,
                sweepDepthY, sweepDownSec, sweepHoldSec, sweepCooldownSec, flusherEdgeGap, flusherNeverAboveNeck },
    antiStick:{ stuckKickAfterMs, stuckVelPx, stuckDistPx, stuckKickF, stuckKickInwardF, stuckKickCooldownMs, stuckInjectAfterMs, stuckInjectVy, stuckInjectVx }
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
  // widen band when few grains remain
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
    if (pulseTopOnly && yLoc >= 0) continue;

    // use local width so pulses can hit wall-huggers
    const xLimit = xHalf(yLoc) - insideMargin;
    if (Math.abs(p.x) > xLimit + r*0.5) continue;

    const fx = (Math.random() - 0.5) * pulseForce * 2;
    const fy = (Math.random() - 0.5) * pulseForce * 0.6 + (yLoc < 0 ? +rescueDownBias : 0);
    Body.applyForce(g, p, { x: fx, y: fy });
  }
}

/* -------------------- flusher helpers (dynamic X by Y) -------------------- */
function setFlusherXForBody(f, tSec, speedMul = 1) {
  const y = f.position.y;
  const limit = Math.max(0, xHalf(y) - (flusherR + flusherEdgeGap));
  const A = Math.min(limit, flusherAmp);
  const phase = (flushers.indexOf(f) / Math.max(1, flushers.length)) * Math.PI * 2;
  const x = A * Math.sin(2 * Math.PI * flusherHz * speedMul * tSec + phase);
  Body.setPosition(f, { x, y });
}
function setFlushersY(y){ for (const f of flushers) Body.setPosition(f, { x: f.position.x, y }); }
function setFlushersX(tSec, speedMul = 1){ for (const f of flushers) setFlusherXForBody(f, tSec, speedMul); }
function parkFlushersOffscreen() {
  for (const f of flushers) { f.isSensor = true; Body.setPosition(f, { x: 0, y: -H - 1000 }); }
  flState = "idle"; flStateT = 0;
}

/* -------------------- loop -------------------- */
const runner = Runner.create({ isFixed:true, delta:DT });

function stepOnce() {
  // cull escapes
  for (const g of grains) {
    if (g._removed) continue;
    if (!isInside(g.position) && (g.position.y < -H-10 || g.position.y > H+10 || Math.abs(g.position.x) > bulb + 30)) {
      Composite.remove(engine.world, g); g._removed = true;
    }
  }

  // Sleep only deep in bottom bulb
  for (const g of grains) {
    if (g._removed) continue;
    const yLoc = localY(g.position);
    const speed = Math.hypot(g.velocity.x, g.velocity.y);
    if (yLoc >= sleepOnlyBelowY) {
      if (speed < sleepVel) g._sleepAccum += DT*1000; else g._sleepAccum = 0;
      if (g._sleepAccum >= sleepMs) { Composite.remove(engine.world, g); g._removed = true; continue; }
    } else {
      g._sleepAccum = 0;
    }
    g._prevLocalY = yLoc;
  }

  // Anti-stick above the neck
  const nowMs = frames / fps * 1000;
  for (const g of grains) {
    if (g._removed) continue;
    const p = g.position;
    const yLoc = localY(p);
    if (yLoc >= 0) continue; // only above neck

    const dx = p.x - g._lastPos.x;
    const dy = p.y - g._lastPos.y;
    const moved = Math.hypot(dx, dy);
    const spd = Math.hypot(g.velocity.x, g.velocity.y);

    if (spd < stuckVelPx && moved < stuckDistPx) g._stuckAccum += DT*1000; else g._stuckAccum = 0;

    if (g._stuckAccum >= stuckKickAfterMs && (nowMs - g._lastKickAt) >= stuckKickCooldownMs) {
      const inward = (p.x >= 0) ? -1 : +1;
      Body.applyForce(g, p, { x: inward * stuckKickInwardF, y: +stuckKickF });
      g._lastKickAt = nowMs;
    }
    if (g._stuckAccum >= stuckInjectAfterMs) {
      const inward = (p.x >= 0) ? -1 : +1;
      Body.setVelocity(g, { x: g.velocity.x + inward * stuckInjectVx, y: g.velocity.y + stuckInjectVy });
      g._stuckAccum = stuckKickAfterMs * 0.5;
      g._lastKickAt = nowMs;
    }

    g._lastPos.x = p.x; g._lastPos.y = p.y;
  }

  const topCount = countTopInside();
  const stalled = (stallFrames / fps) > unclogDelaySec;

  // Safer activation: only when top is *not* crowded
  const wantFlusher =
    useFlushers &&
    (topCount <= flusherTopCount || (stalled && topCount <= Math.max(flusherTopCount, rescueTopCount * 2)));

  // Adaptive gravity wobble
  const tSec = frames / fps;
  const amp = currentVibeAmpDeg(topCount);
  const ang = (tiltDeg + amp * Math.sin(2 * Math.PI * vibeHz * tSec)) * Math.PI/180;
  engine.gravity.x = Math.sin(ang);
  engine.gravity.y = Math.cos(ang);

  // Flusher FSM (down -> hold -> teleport up -> cooldown), BELOW NECK ONLY
  if (useFlushers && flushers.length) {
    flStateT += DT;
    if (!wantFlusher) {
      if (flState !== "idle") parkFlushersOffscreen();
    } else {
      if (flState === "idle") {
        // start just below the neck; collisions enabled (we also guard below)
        for (const f of flushers) f.isSensor = false;
        setFlushersY(flusherYTop);
        flState = "down"; flStateT = 0;
      } else if (flState === "down") {
        const yStart = flusherYTop;
        const yEnd   = flusherYTop + sweepDepthY;
        const u = Math.max(0, Math.min(1, flStateT / sweepDownSec));
        const ease = 0.5 - 0.5*Math.cos(Math.PI*u);
        const y = yStart + (yEnd - yStart) * ease;
        // guard: never collide above neck
        for (const f of flushers) f.isSensor = flusherNeverAboveNeck && (y < 0);
        setFlushersY(y);
        setFlushersX(tSec, 1);
        if (flStateT >= sweepDownSec) { flState = "hold"; flStateT = 0; }
      } else if (flState === "hold") {
        setFlushersX(tSec, 2.2);
        if (flStateT >= sweepHoldSec) {
          for (const f of flushers) f.isSensor = true;
          setFlushersY(-H - 1000);
          flState = "cooldown"; flStateT = 0;
        }
      } else if (flState === "cooldown") {
        if (flStateT >= sweepCooldownSec) { flState = "idle"; flStateT = 0; }
      }
    }
  }

  Engine.update(engine, DT*1000);

  // Flow detection
  let flowed = false;
  for (const g of grains) {
    if (g._removed) continue;
    const yLoc = localY(g.position);
    if (g._prevLocalY < 0 && yLoc >= 0) { flowed = true; break; }
  }
  if (flowed) { lastFlowFrame = frames; stallFrames = 0; pulseAccum = 0; }
  else { stallFrames++; pulseAccum += DT; }

  if (lastCrossFrame == null && topBulbEmptyNow()) lastCrossFrame = frames;

  pulseNeck(topCount);

  recordFrame();
  frames++;
  if (progress && (frames % Math.max(1, Math.floor(fps/2)) === 0)) emitProgress();
}

let done = false;
const tMax = Date.now() + flushMaxSec * 1000;

function loop() {
  if (done) return;

  if (frames < targetFrames) { stepOnce(); return setImmediate(loop); }

  if (noFlush) {
    done = true;
  } else {
    if (topBulbEmptyNow() || Date.now() >= tMax) done = true;
    else { stepOnce(); return setImmediate(loop); }
  }

  // Finish
  if (outputMode === "dense") {
    binStream.end();
  } else {
    const sbinPath = path.join(outDir, `${nameBase}.sbin`);
    const fd = fs.openSync(sbinPath, "r+");
    const buf = Buffer.allocUnsafe(4); buf.writeUInt32LE(frames, 0);
    fs.writeSync(fd, buf, 0, 4, 4+2+4); fs.closeSync(fd);
    sbinStream.end();
  }

  const json = {
    meta: { duration, fps, grains:grainsN, full, neck, H, bulb, r, bounce, friction, tiltDeg, slat, c1, c2, Q, mode:outputMode,
            wallThickness, sleepOnlyBelowFrac,
            antiClog:{ vibeAmpBaseDeg, vibeAmpMaxDeg, vibeHz, unclogDelaySec, rescueTopCount, pulseEverySec, pulseZoneY, pulseTopOnly, pulseForce, rescueDownBias },
            flushers:{ useFlushers, flusherCount, flusherR, flusherAmp, flusherYTop, flusherHz, flusherTopCount,
                       sweepDepthY, sweepDownSec, sweepHoldSec, sweepCooldownSec, flusherEdgeGap, flusherNeverAboveNeck },
            antiStick:{ stuckKickAfterMs, stuckVelPx, stuckDistPx, stuckKickF, stuckKickInwardF, stuckKickCooldownMs, stuckInjectAfterMs, stuckInjectVy, stuckInjectVx } },
    frames, fps,
    lastCrossFrame: lastCrossFrame ?? null,
    ...(outputMode === "dense" ? { bin:`bakes/${nameBase}.bin` } : { sbin:`bakes/${nameBase}.sbin` })
  };
  fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2), "utf-8");

  // index.json
  const indexPath = path.join(outDir, "index.json");
  let idx = []; try { idx = JSON.parse(fs.readFileSync(indexPath, "utf-8")); } catch {}
  const entry = { file:`bakes/${path.basename(jsonPath)}`, label:nameBase, duration, fps, grains:grainsN, neck, c1, c2, lastCrossFrame: lastCrossFrame ?? null, date:new Date().toISOString() };
  const i = idx.findIndex(e => e.file === entry.file);
  if (i >= 0) idx[i] = entry; else idx.push(entry);
  idx.sort((a,b)=> new Date(b.date) - new Date(a.date));
  fs.writeFileSync(indexPath, JSON.stringify(idx, null, 2), "utf-8");

  console.log("BAKE " + JSON.stringify({ event:"done", file:`bakes/${path.basename(jsonPath)}`, frames, fps, lastCrossFrame: lastCrossFrame ?? null }));
}

setImmediate(loop);
