// bake.js — sparse “death marker” + wall-slip both halves + full controls (Linux/Windows friendly)
import fs from "fs";
import path from "path";
import Matter from "matter-js";
const { Engine, World, Bodies, Body, Composite, Runner, Sleeping } = Matter;

/* -------------------- args -------------------- */
const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) {
  const k = argv[i];
  if (k.startsWith("--")) {
    const key = k.slice(2);
    const nxt = argv[i + 1];
    if (nxt == null || nxt.startsWith("--")) args[key] = true;
    else { args[key] = nxt; i++; }
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
const bounce       = num("bounce", 0.12);
const friction     = num("friction", 0.02);
const tiltDeg      = num("tiltDeg", 0);
const c1           = num("c1", 0.0);
const c2           = num("c2", 0.0);
const slat         = num("slat", 0);
const wallThicknessArg = num("wallThickness", 0);
const wallMode     = str("wallMode", "capsule"); // "rect" | "capsule"
const sleepVel     = num("sleepVel", 2);
const sleepMs      = num("sleepMs", 500);
const sleepMode    = str("sleepMode", "static"); // "static" | "sleep" | "remove"
const flushMaxSec  = num("flushMaxSec", 15);
const noFlush      = bool("noFlush");
const outDir       = str("outDir", "bakes");
const outputMode   = str("outputMode", "sparse"); // dense|sparse
const Q            = num("Q", 32);
const sparseThresholdPx = num("sparseThresholdPx", 1 / Q);
const progress     = bool("progress");

/* stability & helpers */
const SUBSTEPS  = Math.max(1, Math.round(60 / Math.max(1, fps)));
const MAX_SPEED = num("maxSpeed", 24);

/* outside culling */
const outsideKillPad     = num("outsideKillPad", 0.5);
const outsideCullFrames  = Math.max(1, num("outsideCullFrames", 2));
const hardKillPad        = num("hardKillPad", 0.2);
const strictKillPad      = num("strictKillPad", 0.15);

/* sleep gating — only deep in bottom & far from neck */
const sleepOnlyBelowFrac = num("sleepOnlyBelowFrac", 0.58);
const neckNoSleepBandPx  = num("neckNoSleepBandPx", Math.max(80, neck * 3));
const bottomSleepBandPx  = num("bottomSleepBandPx", Math.round(H * 0.35));
const sleepOnlyBelowY    = Math.max(sleepOnlyBelowFrac * H, H - bottomSleepBandPx);

/* unclog aids */
const unclogAssist       = bool("unclogAssist");
const vibeAmpBaseDeg     = num("vibeAmpDeg", 0.25);
const vibeHz             = num("vibeHz", 2.0);
const unclogDelaySec     = num("antiClogPeriod", 0.30);
const rescueTopCount     = num("rescueTopCount", 25);
const vibeAmpMaxDeg      = num("antiClogMaxAmpDeg", 4.5);
const pulseEverySec      = num("antiClogPulseEvery", 0.12);
const pulseZoneY         = num("antiClogZoneY", 30);
const pulseBottomToo     = bool("pulseBottomToo");
const pulseForce         = num("antiClogPulseForce", 1.0e-5);
const rescueDownBias     = num("antiClogDownBias", 4.0e-6);

/* wall slip & bias (now on both halves) */
const wallSlipPx         = num("wallSlipPx", Math.max(0.6, r * 0.6));
const wallSlipVel        = num("wallSlipVel", 0.25);
const wallSlipKickF      = num("wallSlipKickF", 1.2e-4);
const wallSlipKickDownF  = num("wallSlipKickDownF", 4.0e-5);
const wallSlipCooldownMs = num("wallSlipCooldownMs", 250);
const wallBiasBandPx     = num("wallBiasBandPx", Math.max(14, r * 6));
const wallBiasInF        = num("wallBiasInF", 1.6e-4);
const wallBiasDownF      = num("wallBiasDownF", 6.0e-5);

/* -------------------- world -------------------- */
const DT = 1 / fps;
const engine = Engine.create();
engine.enableSleeping = true;
engine.positionIterations = 14;
engine.velocityIterations = 10;
engine.constraintIterations = 4;

const tiltRad = tiltDeg * Math.PI / 180;
engine.gravity.x = Math.sin(tiltRad);
engine.gravity.y = Math.cos(tiltRad);

const sinT = Math.sin(tiltRad);
const cosT = Math.cos(tiltRad);
const localY = (p) => (-p.x * sinT) + (p.y * cosT);

/* hourglass profile */
function xHalf(y) {
  const ay = Math.abs(y);
  const t = Math.min(1, ay / H);
  const bump = t * (1 - t);
  let s = t + c1 * bump + c2 * (2 * bump * (t - 0.5));
  s = Math.max(0, Math.min(1, s));
  return (neck / 2) + (bulb - neck / 2) * s;
}

/* walls (outward thickness) */
const wallThickness = wallThicknessArg > 0 ? wallThicknessArg : Math.max(12, Math.ceil(r * 4));

function buildWallsRect() {
  const segs = 240;
  const t = wallThickness, halfT = t / 2, overlap = t * 3.0;
  const yMin = -H, yMax = H, dy = (yMax - yMin) / segs;
  const w = (ang) => ({ isStatic: true, angle: ang, friction: 0, frictionStatic: 0, restitution: 0 });

  const add = (p0, p1, flip) => {
    const dx = p1.x - p0.x, dyS = p1.y - p0.y;
    const len = Math.hypot(dx, dyS) + overlap, ang = Math.atan2(dyS, dx);
    let nx = -dyS, ny = dx; const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
    if ((flip ? nx < 0 : nx > 0)) { nx = -nx; ny = -ny; } // push outward
    const cx = (p0.x + p1.x) / 2 + nx * halfT, cy = (p0.y + p1.y) / 2 + ny * halfT;
    World.add(engine.world, Bodies.rectangle(cx, cy, len, t, w(ang)));
  };

  for (let i = 0; i < segs; i++) {
    const y0 = yMin + i * dy, y1 = yMin + (i + 1) * dy;
    const xm0 = xHalf(y0), xm1 = xHalf(y1);
    add({ x: -xm0, y: y0 }, { x: -xm1, y: y1 }, false);
    add({ x: +xm0, y: y0 }, { x: +xm1, y: y1 }, true);
  }

  if (slat > 0) World.add(engine.world, Bodies.rectangle(0, 0, slat, t, { isStatic: true }));
  // bottom only
  World.add(engine.world, Bodies.rectangle(0, H + halfT, bulb * 2 + 80, t, { isStatic: true }));
}

function buildWallsCapsule() {
  const rad = wallThickness / 2, segs = 420, dy = (2 * H) / segs, eps = 1e-3;
  const circleOpts = { isStatic: true, friction: 0, frictionStatic: 0, restitution: 0, label: "wall" };
  const normalAt = (y) => {
    const dxdy = (xHalf(Math.min(H, y + eps)) - xHalf(Math.max(-H, y - eps))) / (2 * eps);
    const nx = 1, ny = -dxdy, inv = 1 / Math.hypot(nx, ny);
    return { nx: nx * inv, ny: ny * inv };
  };
  for (let i = 0; i <= segs; i++) {
    const y = -H + i * dy;
    { const x = xHalf(y); const { nx, ny } = normalAt(y); const cx = x + nx * rad, cy = y + ny * rad; World.add(engine.world, Bodies.circle(+cx, cy, rad, circleOpts)); }
    { const x = xHalf(y); const { nx, ny } = normalAt(y); const cx = -(x + nx * rad), cy = y + ny * rad; World.add(engine.world, Bodies.circle(+cx, cy, rad, circleOpts)); }
  }
  if (slat > 0) World.add(engine.world, Bodies.rectangle(0, 0, slat, wallThickness, { isStatic: true }));
  World.add(engine.world, Bodies.rectangle(0, H + rad, bulb * 2 + 80, wallThickness, { isStatic: true }));
}

if (wallMode === "capsule") buildWallsCapsule(); else buildWallsRect();

/* inside test (center vs inner curve) */
const inside = (p) => {
  if (p.y < -H - 2 || p.y > H + 2) return false;
  const limit = xHalf(p.y) - (r + outsideKillPad);
  return Math.abs(p.x) <= limit;
};

/* seed grains */
const grains = [];
const topYmin = -H + 20, topYmax = -10;
const maxTries = grainsN * 60;
let placed = 0, tries = 0;

function tryPlace(y) {
  const xBound = Math.max(4, xHalf(y) - r - 2);
  const x = (Math.random() * 2 - 1) * xBound;
  const g = Bodies.circle(x, y, r, {
    restitution: Math.max(0, Math.min(1, bounce)),
    friction: Math.max(0, Math.min(1, friction)),
    frictionStatic: 0,
    frictionAir: 0.003,
    density: 0.001
  });
  for (const h of grains) {
    const dx = h.position.x - g.position.x, dy = h.position.y - g.position.y;
    if (dx * dx + dy * dy < (2 * r + 0.5) ** 2) return false;
  }
  g._sleepAccum = 0; g._prevLocalY = localY(g.position);
  g._stuckAccum = 0; g._lastKickAt = -1e9; g._lastWallKickAt = -1e9;
  g._lastPos = { x: g.position.x, y: g.position.y }; g._outsideCount = 0;
  grains.push(g); World.add(engine.world, g); return true;
}
while (placed < grainsN && tries < maxTries) { tries++; const y = topYmin + Math.random() * (topYmax - topYmin); if (tryPlace(y)) placed++; }
while (placed < grainsN) { const y = -H + 30 - placed * (2 * r + 0.2); if (tryPlace(y)) placed++; }

/* -------------------- output -------------------- */
const nameBase = `hourglass_${duration}s_neck${neck}_g${grainsN}_${wallMode}_${outputMode}_Q${Q}_${id}`;
const jsonPath = path.join(outDir, `${nameBase}.json`);
fs.mkdirSync(outDir, { recursive: true });

const clamp = (v, lo, hi) => (v < lo ? lo : (v > hi ? hi : v));
const qx = (x) => clamp(Math.round((x + bulb + 5) * Q), 0, 65535);
const qy = (y) => clamp(Math.round((y + H + 5) * Q), 0, 65535);
const SENT = 65535; // death marker

let binStream = null, sbinStream = null;
let lastQ = new Array(grainsN).fill(null);
const pendingDeath = new Set();

function writeU16(s,v){ const b=Buffer.allocUnsafe(2); b.writeUInt16LE(v,0); s.write(b); }
function writeU32(s,v){ const b=Buffer.allocUnsafe(4); b.writeUInt32LE(v,0); s.write(b); }
function writeVarint(s,v){ let n=v>>>0; while(n>=0x80){ s.write(Buffer.from([(n&0x7f)|0x80])); n>>>=7; } s.write(Buffer.from([n])); }

const binFsPath  = path.join(outDir, `${nameBase}.bin`);
const sbinFsPath = path.join(outDir, `${nameBase}.sbin`);

if (outputMode === "dense") {
  binStream = fs.createWriteStream(binFsPath);
} else {
  sbinStream = fs.createWriteStream(sbinFsPath);
  // header: "HGSB", u16 Q, u32 grains, u32 frames (patched later)
  sbinStream.write(Buffer.from("HGSB")); writeU16(sbinStream, Q); writeU32(sbinStream, grainsN); writeU32(sbinStream, 0);
}

/* -------------------- sim state -------------------- */
const targetFrames = Math.round(duration * fps);
let frames = 0, lastCrossFrame = null, stallFrames = 0, pulseAccum = 0;

/* logs */
function emitProgress(){ if (progress) console.log("BAKE " + JSON.stringify({event:"progress", frame:frames, target:targetFrames})); }
function emitMeta(){
  console.log("BAKE " + JSON.stringify({
    event:"meta", grains:grainsN, fps, duration, neck, bulb, H, r, bounce, friction, Q, mode:outputMode, wallMode,
    wallThickness, sleepOnlyBelowFrac, neckNoSleepBandPx, bottomSleepBandPx,
    outsideKillPad, outsideCullFrames, hardKillPad, strictKillPad
  }));
}
emitMeta();

/* helpers */
function topBulbEmpty() {
  for (const g of grains) {
    if (g._removed) continue;
    if (!inside(g.position)) continue;
    if (localY(g.position) < -r * 0.5) return false;
  }
  return true;
}

/* record frame (adds pending death markers first) */
function recordFrame() {
  if (outputMode === "dense") {
    for (let i=0;i<grains.length;i++){ const g=grains[i]; writeU16(binStream, qx(g.position.x)); writeU16(binStream, qy(g.position.y)); }
    return;
  }
  const thQ = Math.max(1, Math.round(sparseThresholdPx * Q));
  const changed = [];

  // deaths
  if (pendingDeath.size) {
    for (const idx of pendingDeath) { changed.push([idx, SENT, SENT]); lastQ[idx] = [SENT, SENT]; }
    pendingDeath.clear();
  }
  // positions
  for (let i=0;i<grains.length;i++){
    const g=grains[i]; if (g._removed) continue;
    const px=qx(g.position.x), py=qy(g.position.y), prev=lastQ[i];
    if (frames===0 || !prev || Math.abs(prev[0]-px)>=thQ || Math.abs(prev[1]-py)>=thQ){ changed.push([i,px,py]); lastQ[i]=[px,py]; }
  }
  writeU16(sbinStream, changed.length);
  for (const [idx, px, py] of changed){ writeVarint(sbinStream, idx); writeU16(sbinStream, px); writeU16(sbinStream, py); }
}

/* culling */
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
function stepOnce() {
  // outside kill
  for (let i=0;i<grains.length;i++){
    const g=grains[i]; if (g._removed) continue;
    if (shouldCullOutside(g)){ Composite.remove(engine.world, g); g._removed = true; if (sbinStream) pendingDeath.add(i); }
  }

  // sleep only deep bottom + far from neck
  for (let i=0;i<grains.length;i++){
    const g=grains[i]; if (g._removed) continue;
    const yLoc = localY(g.position);
    const spd = Math.hypot(g.velocity.x, g.velocity.y);
    const farFromNeck = (yLoc >= neckNoSleepBandPx);
    const deepBottom  = (yLoc >= sleepOnlyBelowY);
    if (farFromNeck && deepBottom) {
      if (!g.isStatic) {
        if (spd < sleepVel) g._sleepAccum = (g._sleepAccum || 0) + DT * 1000; else g._sleepAccum = 0;
        if (g._sleepAccum >= sleepMs) {
          if (sleepMode === "remove") { Composite.remove(engine.world, g); g._removed = true; if (sbinStream) pendingDeath.add(i); }
          else if (sleepMode === "sleep") { Sleeping.set(g, true); g._softSleeping = true; g._sleepAccum = 0; }
          else { Body.setVelocity(g,{x:0,y:0}); Body.setAngularVelocity(g,0); Body.setStatic(g,true); g.isSensor=false; g._sleepAccum=0; }
        }
      }
    } else g._sleepAccum = 0;
    g._prevLocalY = yLoc;
  }

  // anti-stick + wall slip + bias — both halves
  const nowMs = frames / fps * 1000;
  for (const g of grains) {
    if (g._removed) continue;
    const p = g.position;
    const yLoc = localY(p);
    const dx = p.x - (g._lastPos?.x ?? p.x);
    const dy = p.y - (g._lastPos?.y ?? p.y);
    const moved = Math.hypot(dx, dy);
    const spd = Math.hypot(g.velocity.x, g.velocity.y);

    // stick kick
    const stuckVelPx = 0.18, stuckDistPx = 0.25, stuckKickAfterMs = 1000, stuckKickCooldownMs = 300;
    const stuckKickF = 1.8e-4, stuckKickInwardF = 1.2e-4;
    if (spd < stuckVelPx && moved < stuckDistPx) g._stuckAccum = (g._stuckAccum || 0) + DT * 1000; else g._stuckAccum = 0;
    if (g._stuckAccum >= stuckKickAfterMs && (nowMs - (g._lastKickAt || -1e9)) >= stuckKickCooldownMs) {
      const inward = (p.x >= 0) ? -1 : +1;
      Body.applyForce(g, p, { x: inward * stuckKickInwardF, y: +stuckKickF });
      g._lastKickAt = nowMs;
    }

    // wall slip
    const limit = xHalf(yLoc) - (r + 0.05);
    const nearWall = Math.abs(Math.abs(p.x) - limit) <= wallSlipPx;
    if (nearWall && spd < wallSlipVel) {
      if (nowMs - (g._lastWallKickAt || -1e9) >= wallSlipCooldownMs) {
        const inward = (p.x >= 0) ? -1 : +1;
        Body.applyForce(g, p, { x: inward * wallSlipKickF, y: wallSlipKickDownF });
        g._lastWallKickAt = nowMs;
      }
    }

    // gentle bias band
    const dist = Math.abs(limit - Math.abs(p.x));
    if (dist <= wallBiasBandPx) {
      const inward = (p.x >= 0) ? -1 : +1;
      Body.applyForce(g, p, { x: inward * wallBiasInF, y: wallBiasDownF });
    }

    g._lastPos = { x: p.x, y: p.y };
  }

  // optional wobble/pulses
  if (unclogAssist) {
    const stallSec = stallFrames / fps;
    let amp = vibeAmpBaseDeg;
    if (stallSec > unclogDelaySec) {
      const t = Math.min(1, (stallSec - unclogDelaySec) / 1.2);
      amp = vibeAmpBaseDeg + (vibeAmpMaxDeg - vibeAmpBaseDeg) * (0.5 - 0.5 * Math.cos(Math.PI * t));
    }
    const topCount = grains.reduce((n,g)=> n + (!g._removed && inside(g.position) && localY(g.position) < 0 ? 1 : 0), 0);
    if (topCount <= rescueTopCount) amp = Math.max(amp, vibeAmpMaxDeg);
    const ang = (tiltDeg + amp * Math.sin(2 * Math.PI * vibeHz * (frames / fps))) * Math.PI / 180;
    engine.gravity.x = Math.sin(ang); engine.gravity.y = Math.cos(ang);

    const flowed = grains.some(g => !g._removed && g._prevLocalY < 0 && localY(g.position) >= 0);
    if (flowed) { stallFrames = 0; pulseAccum = 0; } else { stallFrames++; pulseAccum += DT; }

    const every = (topCount <= rescueTopCount) ? Math.min(pulseEverySec, 0.08) : pulseEverySec;
    if (pulseAccum >= every) {
      pulseAccum = 0;
      const band = (topCount <= rescueTopCount) ? Math.max(pulseZoneY, Math.min(H, Math.max(80, 0.18 * H))) : pulseZoneY;
      for (const g of grains) {
        if (g._removed) continue;
        const yLoc = localY(g.position);
        if (Math.abs(yLoc) > band) continue;
        if (!pulseBottomToo && yLoc >= 0) continue;
        const xLimit = xHalf(yLoc) - (r + outsideKillPad);
        if (Math.abs(g.position.x) > xLimit + r * 0.5) continue;
        const fx = (Math.random() - 0.5) * pulseForce * 2;
        const fy = (Math.random() - 0.5) * pulseForce * 0.6 + (yLoc < 0 ? +rescueDownBias : 0);
        Body.applyForce(g, g.position, { x: fx, y: fy });
      }
    }
  } else {
    const ang = tiltDeg * Math.PI / 180;
    engine.gravity.x = Math.sin(ang); engine.gravity.y = Math.cos(ang);
  }

  // integrate + clamp
  const dtMs = (DT * 1000) / SUBSTEPS;
  for (let s = 0; s < SUBSTEPS; s++) Engine.update(engine, dtMs);
  for (const g of grains) {
    if (g._removed) continue;
    const vx = g.velocity.x, vy = g.velocity.y, sp = Math.hypot(vx, vy);
    if (sp > MAX_SPEED) { const m = MAX_SPEED / sp; Body.setVelocity(g, { x: vx * m, y: vy * m }); }
  }

  if (lastCrossFrame == null && topBulbEmpty()) lastCrossFrame = frames;

  recordFrame();
  frames++;
  if (progress && (frames % Math.max(1, Math.floor(fps / 2)) === 0)) emitProgress();
}

/* finalize */
function finalizeAndWrite() {
  const json = {
    meta: {
      duration, fps, grains: grainsN, full, neck, H, bulb, r, bounce, friction,
      tiltDeg, slat, c1, c2, Q, mode: outputMode, wallMode, wallThickness,
      sleepOnlyBelowFrac, neckNoSleepBandPx, bottomSleepBandPx,
      outsideKillPad, outsideCullFrames, hardKillPad, strictKillPad
    },
    frames, fps,
    lastCrossFrame: lastCrossFrame ?? null,
    ...(outputMode === "dense" ? { bin: `/bakes/${nameBase}.bin` } : { sbin: `/bakes/${nameBase}.sbin` })
  };
  fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2), "utf-8");

  const indexPath = path.join(outDir, "index.json");
  let idx = []; try { idx = JSON.parse(fs.readFileSync(indexPath, "utf-8")); } catch {}
  const entry = { file: `bakes/${path.basename(jsonPath)}`, label: nameBase, duration, fps, grains: grainsN, neck, c1, c2, lastCrossFrame: lastCrossFrame ?? null, date: new Date().toISOString() };
  const i = idx.findIndex(e => e.file === entry.file);
  if (i >= 0) idx[i] = entry; else idx.push(entry);
  idx.sort((a,b)=> new Date(b.date) - new Date(a.date));
  fs.writeFileSync(indexPath, JSON.stringify(idx, null, 2), "utf-8");

  console.log("BAKE " + JSON.stringify({ event: "done", file: `bakes/${path.basename(jsonPath)}`, frames, fps, lastCrossFrame: lastCrossFrame ?? null }));
}

let done = false;
const tMax = Date.now() + flushMaxSec * 1000;

function loop() {
  if (done) return;
  if (frames < Math.round(duration * fps)) { stepOnce(); return setImmediate(loop); }
  if (!noFlush && !topBulbEmpty() && Date.now() < tMax) { stepOnce(); return setImmediate(loop); }
  done = true;

  if (outputMode === "dense") {
    binStream.end(() => finalizeAndWrite());
  } else {
    // Patch frames field (offset 10) after stream closes — Linux/Windows safe
    sbinStream.end(() => {
      const fd = fs.openSync(path.join(outDir, `${nameBase}.sbin`), "r+");
      const buf = Buffer.allocUnsafe(4); buf.writeUInt32LE(frames, 0);
      fs.writeSync(fd, buf, 0, 4, 10);
      fs.closeSync(fd);
      finalizeAndWrite();
    });
  }
}

setImmediate(loop);
