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
const k            = num("k", 0.1); // reserved
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

/* -------------------- adaptive anti-clog controls -------------------- */
const vibeAmpBaseDeg   = num("vibeAmpDeg", 0.25);     // baseline wobble
const vibeHz           = num("vibeHz", 2.0);
const unclogDelaySec   = num("antiClogPeriod", 0.30); // stall before we intervene

// strong "rescue" when only a few remain above neck
const rescueTopCount   = num("rescueTopCount", 25);
const vibeAmpMaxDeg    = num("antiClogMaxAmpDeg", 4.5);
const pulseEverySec    = num("antiClogPulseEvery", 0.12);
const pulseZoneY       = num("antiClogZoneY", 30);
const pulseTopOnly     = !bool("pulseBottomToo");
const pulseForce       = num("antiClogPulseForce", 1.0e-5);
const rescueDownBias   = num("antiClogDownBias", 4.0e-6); // tiny downward nudge above neck

/* -------------------- world/engine -------------------- */
const DT = 1 / fps;
const WORLD_W = bulb * 2 + 80;
const WORLD_H = H * 2 + 80;

const engine = Engine.create();
engine.positionIterations = 12;
engine.velocityIterations = 8;
engine.constraintIterations = 4;

const baseTiltRad = tiltDeg * Math.PI / 180;
// Tilt gravity (do not rotate geometry)
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

/* -------------------- walls (overlapping, no chamfer) -------------------- */
const wallThickness = wallThicknessArg > 0 ? wallThicknessArg : Math.max(12, Math.ceil(r * 4));
function buildWalls() {
  const segs = 200;
  const thickness = wallThickness;
  const overlap = thickness * 1.6;
  const yMin = -H, yMax = H;
  const dy = (yMax - yMin) / segs;
  const wallOpts = (angle) => ({ isStatic:true, angle, friction:0, frictionStatic:0, restitution:0 });

  const bodies = [];
  for (let i = 0; i < segs; i++) {
    const y0 = yMin + i * dy;
    const y1 = yMin + (i + 1) * dy;
    const xm0 = xHalf(y0), xm1 = xHalf(y1);

    // left
    {
      const lx0=-xm0, lx1=-xm1;
      const cx=(lx0+lx1)/2, cy=(y0+y1)/2;
      const segLen=Math.hypot(lx1-lx0, y1-y0);
      const len=segLen + overlap;
      const ang=Math.atan2(y1 - y0, lx1 - lx0);
      bodies.push(Bodies.rectangle(cx, cy, len, thickness, wallOpts(ang)));
    }
    // right
    {
      const rx0=xm0, rx1=xm1;
      const cx=(rx0+rx1)/2, cy=(y0+y1)/2;
      const segLen=Math.hypot(rx1-rx0, y1-y0);
      const len=segLen + overlap;
      const ang=Math.atan2(y1 - y0, rx1 - rx0);
      bodies.push(Bodies.rectangle(cx, cy, len, thickness, wallOpts(ang)));
    }
  }
  if (slat > 0) bodies.push(Bodies.rectangle(0, 0, slat, thickness, { isStatic:true, friction:0, frictionStatic:0 }));

  bodies.push(Bodies.rectangle(0, -H - thickness, WORLD_W, thickness, { isStatic:true }));
  bodies.push(Bodies.rectangle(0,  H + thickness, WORLD_W, thickness, { isStatic:true }));

  bodies.forEach(b => World.add(engine.world, b));
}
buildWalls();

/* -------------------- interior test -------------------- */
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
    restitution: 0.12,
    friction: 0.015,
    frictionStatic: 0.0,
    density: 0.001
  });
  for (const g of grains) {
    const dx=g.position.x-circle.position.x, dy=g.position.y-circle.position.y;
    if (dx*dx + dy*dy < (r*2 + 0.5)**2) return false;
  }
  circle._sleepAccum = 0;
  circle._prevLocalY = localY(circle.position);
  grains.push(circle); World.add(engine.world, circle);
  return true;
}
while (placed < grainsN && tries < maxTries) { tries++; const y = topYmin + Math.random() * (topYmax - topYmin); if (tryPlace(y)) placed++; }
while (placed < grainsN) { const y = -H + 30 - placed * (2*r + 0.2); if (tryPlace(y)) placed++; }

/* -------------------- IO buffers -------------------- */
const nameBase = `hourglass_${duration}s_neck${neck}_g${grainsN}_${outputMode}_Q${Q}_${id}`;
const jsonPath = path.join(outDir, `${nameBase}.json`);
fs.mkdirSync(outDir, { recursive: true });

const clamp = (v, lo, hi) => v < lo ? lo : (v > hi ? hi : v);
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
let lastCrossFrame = null; // when top bulb becomes empty (inside-only)
let lastFlowFrame = 0;
let stallFrames = 0;
let pulseAccum = 0;

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
    event:"meta", grains:grainsN, fps, duration, neck, bulb, H, r, Q, mode:outputMode,
    wallThickness,
    antiClog:{ vibeAmpBaseDeg, vibeAmpMaxDeg, vibeHz, unclogDelaySec, rescueTopCount, pulseEverySec, pulseZoneY, pulseTopOnly, pulseForce, rescueDownBias }
  }));
}
emitMeta();

/* -------------------- anti-clog -------------------- */
function currentVibeAmpDeg(topCount) {
  const stallSec = stallFrames / fps;
  let amp = vibeAmpBaseDeg;
  if (stallSec > unclogDelaySec) {
    const t = Math.min(1, (stallSec - unclogDelaySec) / 1.2); // faster ramp
    amp = vibeAmpBaseDeg + (vibeAmpMaxDeg - vibeAmpBaseDeg) * (0.5 - 0.5*Math.cos(Math.PI*t));
  }
  // If almost empty above the neck, force a stronger wobble
  if (topCount <= rescueTopCount) amp = Math.max(amp, vibeAmpMaxDeg);
  return amp;
}

function pulseNeck(topCount) {
  const yBand = topCount <= rescueTopCount ? Math.max(pulseZoneY, 40) : pulseZoneY;
  const xLimit = xHalf(0) + 2*r;
  const every = topCount <= rescueTopCount ? Math.min(pulseEverySec, 0.08) : pulseEverySec;
  const force = topCount <= rescueTopCount ? Math.max(pulseForce, 2.0e-5) : pulseForce;
  if (pulseAccum < every) return;
  pulseAccum = 0;

  for (const g of grains) {
    if (g._removed) continue;
    const p = g.position;
    const yLoc = localY(p);
    if (Math.abs(yLoc) > yBand) continue;
    if (pulseTopOnly && yLoc >= 0) continue;
    if (Math.abs(p.x) > xLimit) continue;

    // lateral jitter + small downward bias when above the neck
    const fx = (Math.random() - 0.5) * force * 2;
    const fy = (Math.random() - 0.5) * force * 0.6 + (yLoc < 0 ? -rescueDownBias : 0);
    Body.applyForce(g, p, { x: fx, y: fy });
  }
}

/* -------------------- loop -------------------- */
const runner = Runner.create({ isFixed:true, delta:DT });

function stepOnce() {
  // Cull obvious escapes
  for (const g of grains) {
    if (g._removed) continue;
    if (!isInside(g.position) && (g.position.y < -H-10 || g.position.y > H+10 || Math.abs(g.position.x) > bulb + 30)) {
      Composite.remove(engine.world, g); g._removed = true;
    }
  }

  // Sleep policy: ONLY below neck
  for (const g of grains) {
    if (g._removed) continue;
    const yLoc = localY(g.position);
    const speed = Math.hypot(g.velocity.x, g.velocity.y);
    if (yLoc >= 0) {
      if (speed < sleepVel) g._sleepAccum += DT*1000; else g._sleepAccum = 0;
      if (g._sleepAccum >= sleepMs) { Composite.remove(engine.world, g); g._removed = true; continue; }
    } else {
      g._sleepAccum = 0;
    }
    g._prevLocalY = yLoc;
  }

  const topCount = countTopInside();

  // Adaptive gravity wobble
  const tSec = frames / fps;
  const amp = currentVibeAmpDeg(topCount);
  const ang = (tiltDeg + amp * Math.sin(2 * Math.PI * vibeHz * tSec)) * Math.PI/180;
  engine.gravity.x = Math.sin(ang);
  engine.gravity.y = Math.cos(ang);

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

  // Declare last-cross when top empties
  if (lastCrossFrame == null && topBulbEmptyNow()) lastCrossFrame = frames;

  // Pulses (stronger/faster when nearly empty above the neck)
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
    meta: { duration, fps, grains:grainsN, full, neck, H, bulb, r, k, tiltDeg, slat, c1, c2, Q, mode:outputMode, wallThickness,
            antiClog:{ vibeAmpBaseDeg, vibeAmpMaxDeg, vibeHz, unclogDelaySec, rescueTopCount, pulseEverySec, pulseZoneY, pulseTopOnly, pulseForce, rescueDownBias } },
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
