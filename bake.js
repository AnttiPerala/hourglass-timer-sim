import fs from "fs";
import path from "path";
import Matter from "matter-js";
const { Engine, World, Bodies, Body, Composite, Runner } = Matter;

// --- tiny args parser ---
const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) {
  const k = argv[i];
  if (k.startsWith("--")) {
    const key = k.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next; i++;
    }
  }
}
const num  = (k, d) => (args[k] !== undefined ? Number(args[k]) : d);
const bool = (k)    => Boolean(args[k]);
const str  = (k, d) => (args[k] ?? d);

// --- inputs ---
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
const sleepVel     = num("sleepVel", 2);
const sleepMs      = num("sleepMs", 500);
const flushMaxSec  = num("flushMaxSec", 15);
const noFlush      = bool("noFlush");
const outDir       = str("outDir", "bakes");
const outputMode   = str("outputMode", "dense"); // dense|sparse
const Q            = num("Q", 32);
const progress     = bool("progress");
const sparseThresholdPx = num("sparseThresholdPx", 1 / Q);

// anti-clog helpers (tunable)
const vibeAmpDeg     = num("vibeAmpDeg", 0.25);       // 0 to disable
const vibeHz         = num("vibeHz", 2);
const antiClog       = !bool("noAntiClog");           // on by default
const antiClogPeriod = num("antiClogPeriod", 0.5);    // seconds without a cross before a nudge
const antiClogKick   = num("antiClogKick", 0.000002); // tiny lateral force

// world constants
const DT = 1 / fps;
const WORLD_W = bulb * 2 + 40;
const WORLD_H = H * 2 + 40;

// --- engine ---
const engine = Engine.create();
engine.positionIterations = 8;
engine.velocityIterations = 8;
const baseTiltRad = tiltDeg * Math.PI / 180;
// gravity is oriented by tilt + optional micro-vibration
engine.gravity.x = Math.sin(baseTiltRad);
engine.gravity.y = Math.cos(baseTiltRad);

// Helpers to convert world -> glass local (unrotate by base tilt).
// Local y′=0 is the neck plane; y′<0 == top bulb, y′>0 == bottom bulb.
const sinT = Math.sin(baseTiltRad);
const cosT = Math.cos(baseTiltRad);
const localY = (p) => (-p.x * sinT) + (p.y * cosT);

// ---- Hourglass geometry (correct profile) ----
function xHalf(y) {
  const ay = Math.abs(y);
  const t = Math.min(1, ay / H);     // 0 at neck, 1 at bulb ends
  const bump = t * (1 - t);          // 0 at neck & ends, peak mid-bulb
  let s = t + c1 * bump + c2 * (2 * bump * (t - 0.5));
  s = Math.max(0, Math.min(1, s));
  return (neck / 2) + (bulb - neck / 2) * s;
}

// Build walls (zero friction, rounded joins)
function buildWalls() {
  const segs = 160;
  const thickness = 6;
  const yMin = -H, yMax = H;
  const dy = (yMax - yMin) / segs;

  const wallOpts = (angle) => ({
    isStatic: true,
    angle,
    friction: 0, frictionStatic: 0, restitution: 0,
    chamfer: { radius: 3 }
  });

  const bodies = [];
  for (let i = 0; i < segs; i++) {
    const y0 = yMin + i * dy;
    const y1 = yMin + (i + 1) * dy;
    const xm0 = xHalf(y0), xm1 = xHalf(y1);

    // left
    {
      const lx0 = -xm0, lx1 = -xm1;
      const cx = (lx0 + lx1) / 2;
      const cy = (y0 + y1) / 2;
      const len = Math.hypot(lx1 - lx0, y1 - y0) + 0.6;
      const ang = Math.atan2(y1 - y0, lx1 - lx0);
      bodies.push(Bodies.rectangle(cx, cy, len, thickness, wallOpts(ang)));
    }
    // right
    {
      const rx0 = xm0, rx1 = xm1;
      const cx = (rx0 + rx1) / 2;
      const cy = (y0 + y1) / 2;
      const len = Math.hypot(rx1 - rx0, y1 - y0) + 0.6;
      const ang = Math.atan2(y1 - y0, rx1 - rx0);
      bodies.push(Bodies.rectangle(cx, cy, len, thickness, wallOpts(ang)));
    }
  }
  if (slat > 0) bodies.push(Bodies.rectangle(0, 0, slat, thickness, { isStatic: true, friction:0, frictionStatic:0 }));

  // ceiling/floor guards
  bodies.push(Bodies.rectangle(0, yMin - 10, WORLD_W, thickness, { isStatic: true, friction:0, frictionStatic:0 }));
  bodies.push(Bodies.rectangle(0, yMax + 10, WORLD_W, thickness, { isStatic: true, friction:0, frictionStatic:0 }));

  // rotate container to base tilt
  bodies.forEach(b => Body.rotate(b, baseTiltRad));
  bodies.forEach(b => World.add(engine.world, b));
}
buildWalls();

// ---- Seed grains in top bulb ----
const grains = [];
const topAreaYMin = -H + 20;
const topAreaYMax = -10;
const maxTries = grainsN * 50;
let placed = 0, tries = 0;
while (placed < grainsN && tries < maxTries) {
  tries++;
  const y = topAreaYMin + Math.random() * (topAreaYMax - topAreaYMin);
  const xBound = Math.max(4, xHalf(y) - r - 2);
  const x = (Math.random() * 2 - 1) * xBound;
  const circle = Bodies.circle(x, y, r, {
    restitution: 0.1,
    friction: 0.02,
    frictionStatic: 0.0,
    density: 0.001
  });
  // reject if overlaps existing
  let ok = true;
  for (const g of grains) {
    const dx = g.position.x - circle.position.x;
    const dy = g.position.y - circle.position.y;
    if (dx*dx + dy*dy < (r*2 + 0.5) ** 2) { ok = false; break; }
  }
  if (ok) {
    circle._sleepAccum = 0;
    circle._prevLocalY = localY(circle.position);
    grains.push(circle);
    World.add(engine.world, circle);
    placed++;
  }
}
while (placed < grainsN) {
  const circle = Bodies.circle(0, -H + 30 - placed * (2*r+0.1), r, {
    restitution:0.1, friction:0.02, frictionStatic:0.0, density:0.001
  });
  circle._sleepAccum = 0;
  circle._prevLocalY = localY(circle.position);
  grains.push(circle);
  World.add(engine.world, circle);
  placed++;
}

// ---- Output buffers / files ----
const nameBase = `hourglass_${duration}s_neck${neck}_g${grainsN}_${outputMode}_Q${Q}_${id}`;
const jsonPath = path.join(outDir, `${nameBase}.json`);
fs.mkdirSync(outDir, { recursive: true });

// quantization helpers
const clamp = (v, lo, hi) => v < lo ? lo : (v > hi ? hi : v);
const qx = (x) => clamp(Math.round((x + bulb + 5) * Q), 0, 65535);
const qy = (y) => clamp(Math.round((y + H + 5) * Q), 0, 65535);

let binStream = null;
let sbinStream = null;
let lastQ = new Array(grainsN).fill(null);

function writeU16(stream, v) { const b = Buffer.allocUnsafe(2); b.writeUInt16LE(v, 0); stream.write(b); }
function writeU32(stream, v) { const b = Buffer.allocUnsafe(4); b.writeUInt32LE(v, 0); stream.write(b); }
function writeVarint(stream, v) { // 7-bit LEB128
  let n = v >>> 0;
  while (n >= 0x80) { stream.write(Buffer.from([(n & 0x7f) | 0x80])); n >>>= 7; }
  stream.write(Buffer.from([n]));
}

let binRelPath = null, sbinRelPath = null;
if (outputMode === "dense") {
  const binPath = path.join(outDir, `${nameBase}.bin`);
  binStream = fs.createWriteStream(binPath);
  binRelPath = path.posix.join("bakes", path.basename(binPath));
} else {
  const sbinPath = path.join(outDir, `${nameBase}.sbin`);
  sbinStream = fs.createWriteStream(sbinPath);
  sbinStream.write(Buffer.from("HGSB"));
  writeU16(sbinStream, Q);
  writeU32(sbinStream, grainsN);
  writeU32(sbinStream, 0); // placeholder frames
  sbinRelPath = path.posix.join("bakes", path.basename(sbinPath));
}

const targetFrames = Math.round(duration * fps);
let frames = 0;
let lastCrossFrame = null; // first frame when top bulb is empty (local y′<0 none)
let lastFlowFrame = 0;     // last time a grain crossed the neck (y′: <0 -> >=0)

// Top empty detection in local coordinates
function topBulbEmpty() {
  for (let i = 0; i < grains.length; i++) {
    const g = grains[i];
    if (g._removed) continue;
    if (localY(g.position) < 0 - r * 0.5) return false; // a tiny slack
  }
  return true;
}

function recordFrame() {
  if (outputMode === "dense") {
    for (let i = 0; i < grains.length; i++) {
      const g = grains[i];
      writeU16(binStream, qx(g.position.x));
      writeU16(binStream, qy(g.position.y));
    }
  } else {
    const thresholdQ = Math.max(1, Math.round(sparseThresholdPx * Q));
    const changed = [];
    for (let i = 0; i < grains.length; i++) {
      const g = grains[i];
      const px = qx(g.position.x), py = qy(g.position.y);
      const prev = lastQ[i];
      if (frames === 0 || !prev || Math.abs(prev[0] - px) >= thresholdQ || Math.abs(prev[1] - py) >= thresholdQ) {
        changed.push([i, px, py]);
        lastQ[i] = [px, py];
      }
    }
    writeU16(sbinStream, changed.length);
    for (const [idx, px, py] of changed) {
      writeVarint(sbinStream, idx);
      writeU16(sbinStream, px);
      writeU16(sbinStream, py);
    }
  }
}

function emitProgress() {
  if (!progress) return;
  console.log("BAKE " + JSON.stringify({ event:"progress", frame:frames, target:targetFrames }));
}
function emitMeta() {
  console.log("BAKE " + JSON.stringify({ event:"meta", grains:grainsN, fps, duration, neck, bulb, H, r, Q, mode:outputMode }));
}
emitMeta();

// small lateral kick to grains in the throat when flow stalls
function nudgeNeck() {
  const yBand = 12;
  const xLimit = xHalf(0) + 4;
  for (const g of grains) {
    if (g._removed) continue;
    const p = g.position;
    const yLoc = localY(p);
    if (Math.abs(yLoc) < yBand && Math.abs(p.x) < xLimit) {
      const fx = (Math.random() - 0.5) * antiClogKick;
      Body.applyForce(g, p, { x: fx, y: 0 });
    }
  }
}

// ---- Simulation loop ----
const runner = Runner.create({ isFixed: true, delta: DT });

function stepOnce() {
  // pre-step: update sleep timers (ONLY for grains below the neck) & cache prev local y
  for (let i = 0; i < grains.length; i++) {
    const g = grains[i];
    if (g._removed) continue;
    const yLoc = localY(g.position);
    const speed = Math.hypot(g.velocity.x, g.velocity.y);

    // NEVER sleep grains above the neck (y′ < 0). Only bottom (y′ >= 0) can sleep.
    if (yLoc >= 0) {
      if (speed < sleepVel) g._sleepAccum += DT * 1000; else g._sleepAccum = 0;
      if (g._sleepAccum >= sleepMs) { Composite.remove(engine.world, g); g._removed = true; continue; }
    } else {
      g._sleepAccum = 0; // keep them active
    }
    g._prevLocalY = yLoc;
  }

  // micro-vibration in gravity to break arches (around the rotated container)
  if (vibeAmpDeg !== 0) {
    const t = frames / fps;
    const ang = (tiltDeg + vibeAmpDeg * Math.sin(2 * Math.PI * vibeHz * t)) * Math.PI / 180;
    engine.gravity.x = Math.sin(ang);
    engine.gravity.y = Math.cos(ang);
  }

  Engine.update(engine, DT * 1000);

  // detect a cross event (local y′ from <0 to >=0)
  let flowed = false;
  for (const g of grains) {
    if (g._removed) continue;
    const yLoc = localY(g.position);
    if (g._prevLocalY < 0 && yLoc >= 0) { flowed = true; break; }
  }
  if (flowed) lastFlowFrame = frames;

  // anti-clog nudge if no flow for a while
  if (antiClog && (frames - lastFlowFrame) > Math.round(antiClogPeriod * fps)) {
    nudgeNeck();
    lastFlowFrame = frames;
  }

  recordFrame();
  frames++;
  if (progress && (frames % Math.max(1, Math.floor(fps/2)) === 0)) emitProgress();
}

let done = false;
const tMax = Date.now() + flushMaxSec * 1000;

function loop() {
  if (done) return;
  if (frames < targetFrames) {
    stepOnce(); return setImmediate(loop);
  }
  if (noFlush) {
    done = true;
  } else {
    if (lastCrossFrame == null && topBulbEmpty()) lastCrossFrame = frames; // first frame top is empty in LOCAL coords
    if (topBulbEmpty() || Date.now() >= tMax) {
      done = true;
    } else {
      stepOnce(); return setImmediate(loop);
    }
  }

  // --- Finish ---
  if (outputMode === "dense") {
    binStream.end();
  } else {
    const sbinPath = path.join(outDir, `${nameBase}.sbin`);
    const fd = fs.openSync(sbinPath, "r+");
    const buf = Buffer.allocUnsafe(4);
    buf.writeUInt32LE(frames, 0);
    fs.writeSync(fd, buf, 0, 4, 4 + 2 + 4); // after magic+Q+grains
    fs.closeSync(fd);
    sbinStream.end();
  }

  const json = {
    meta: { duration, fps, grains: grainsN, full, neck, H, bulb, r, k, tiltDeg, slat, c1, c2, Q, mode: outputMode },
    frames, fps,
    lastCrossFrame: lastCrossFrame ?? null,
    ...(outputMode === "dense" ? { bin: `bakes/${nameBase}.bin` } : { sbin: `bakes/${nameBase}.sbin` })
  };
  fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2), "utf-8");

  // update index.json
  const indexPath = path.join(outDir, "index.json");
  let idx = [];
  try { idx = JSON.parse(fs.readFileSync(indexPath, "utf-8")); } catch {}
  const entry = {
    file: `bakes/${path.basename(jsonPath)}`,
    label: nameBase,
    duration, fps, grains: grainsN, neck, c1, c2, lastCrossFrame: lastCrossFrame ?? null,
    date: new Date().toISOString()
  };
  const i = idx.findIndex(e => e.file === entry.file);
  if (i >= 0) idx[i] = entry; else idx.push(entry);
  idx.sort((a,b)=> new Date(b.date) - new Date(a.date));
  fs.writeFileSync(indexPath, JSON.stringify(idx, null, 2), "utf-8");

  console.log("BAKE " + JSON.stringify({ event:"done", file:`bakes/${path.basename(jsonPath)}`, frames, fps, lastCrossFrame: lastCrossFrame ?? null }));
}

setImmediate(loop);
