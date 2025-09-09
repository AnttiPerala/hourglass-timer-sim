// bake_sparse.js — sparse, streamed baker with settle-culling
// Usage:
//   node bake_sparse.js --duration 300 --fps 60 --grains 4500 --full 0.9 --neck 16 --k 1.0
//
// One-time setup:  npm i matter-js

const fs = require('fs');
const path = require('path');
const Matter = require('matter-js');

function arg(name, def){ const i=process.argv.indexOf(name); return i>0 ? process.argv[i+1] : def; }

const OPT = {
  duration: +arg('--duration', 60),          // desired playback length (seconds)
  fps:      +arg('--fps', 30),               // viewer fps (we retime exactly later)
  grains:   +arg('--grains', 3500),
  full:     +arg('--full', 0.92),            // spawn “fullness” of the top bulb (lower => ensures full empty)
  neck:     +arg('--neck', 16),
  H:        +arg('--H', 330),
  bulb:     +arg('--bulb', 205),
  r:        +arg('--r', 2.6),
  k:        +arg('--k', 1.05),               // 1.0 ≈ straight icon sides; >1 rounder
  tiltDeg:  +arg('--tilt', 1.2),             // tiny gravity tilt to avoid symmetrical arches
  slat:     +arg('--slat', 4),               // wall smoothness
  flushMaxSec: +arg('--flushMaxSec', 20),    // bake extra seconds max to fully empty top
  // settle detection (in physics time):
  settleSec: +arg('--settleSec', 1.5),       // must be still this long
  settleSpeed: +arg('--settleSpeed', 0.02),  // max speed (px/s) considered “still”
};

OPT.grains = Math.max(200, Math.round(OPT.grains * OPT.full));

const Q = 32; // quantization ticks per CSS pixel for storage (1/Q px precision)

function widthAtY(y, neck=OPT.neck, bulb=OPT.bulb, H=OPT.H, k=OPT.k){
  const t = Math.min(1, Math.abs(y)/H);
  return neck + (bulb - neck) * Math.pow(t, k);
}

function buildWalls(world){
  const {Bodies, World} = Matter;
  const parts = [];
  const thick = 8;
  for (let y=-OPT.H; y<OPT.H; y+=OPT.slat){
    const y0=y, y1=Math.min(OPT.H, y+OPT.slat);
    const w0=widthAtY(y0), w1=widthAtY(y1);
    const add = (x0,y0,x1,y1)=>{
      const cx=(x0+x1)/2, cy=(y0+y1)/2;
      const len=Math.hypot(x1-x0,y1-y0);
      const ang=Math.atan2(y1-y0, x1-x0);
      parts.push(Bodies.rectangle(cx, cy, thick, len+1, {
        isStatic:true, angle:ang, friction:0.08, frictionStatic:0.02, restitution:0
      }));
    };
    add(-w0,y0,-w1,y1);
    add(+w0,y0,+w1,y1);
  }
  parts.push(Bodies.rectangle(0, -OPT.H-8, OPT.bulb*2+40, 16, { isStatic:true }));
  parts.push(Bodies.rectangle(0,  OPT.H+8, OPT.bulb*2+40, 16, { isStatic:true }));
  World.add(world, parts);
}

async function bake(){
  const {Engine, World, Bodies, Body} = Matter;
  const engine = Engine.create();
  const world  = engine.world;

  // gravity with tiny tilt
  const th = OPT.tiltDeg * Math.PI/180;
  world.gravity.x = Math.sin(th);
  world.gravity.y = Math.cos(th);
  world.gravity.scale = 0.0018;

  buildWalls(world);

  // spawn grains in top bulb
  const sand = [];
  for(let i=0;i<OPT.grains;i++){
    const yy = -OPT.H + 12 + Math.random()*(OPT.H*0.82);
    const w  = widthAtY(yy) - 2;
    const xx = (Math.random()*2-1)*w*0.74;
    const b = Bodies.circle(xx, yy, OPT.r, {
      friction:0.05, frictionStatic:0.02, frictionAir:0.001, restitution:0.05, density:0.001
    });
    sand.push(b);
  }
  World.add(world, sand);

  // output files
  const outDir = path.join(process.cwd(), 'bakes');
  fs.mkdirSync(outDir, {recursive:true});
  const base = `hourglass_${OPT.duration}s_neck${OPT.neck}_k${OPT.k}_full${OPT.full}_sparse`;
  const binPath  = path.join(outDir, `${base}.bin`);
  const jsonPath = path.join(outDir, `${base}.json`);
  const ws = fs.createWriteStream(binPath);

  // timing
  const physHz = 240;
  const dtMs = 1000/physHz;
  const sampleEvery = Math.max(1, Math.round(physHz / OPT.fps));
  const targetFrames = Math.ceil(OPT.duration * OPT.fps);
  const settleTicks = Math.max(1, Math.round(OPT.settleSec * physHz));

  // per-grain state for sparse & settle
  const lastXQ = new Uint16Array(OPT.grains);
  const lastYQ = new Uint16Array(OPT.grains);
  const stillCount = new Uint16Array(OPT.grains);
  const settled = new Uint8Array(OPT.grains); // 1 once “frozen”

  // helper writers
  const writeU16 = (v)=>{ const b = Buffer.allocUnsafe(2); b.writeUInt16LE(v,0); ws.write(b); };

  // frame 0: write all initial positions (x,y for every grain)
  for(let i=0;i<OPT.grains;i++){
    const b = sand[i];
    const xq = Math.max(0, Math.min(65535, Math.round((b.position.x + OPT.bulb + 5) * Q)));
    const yq = Math.max(0, Math.min(65535, Math.round((b.position.y + OPT.H   + 5) * Q)));
    lastXQ[i]=xq; lastYQ[i]=yq;
    writeU16(xq); writeU16(yq);
  }

  // sparse loop:
  // for each subsequent frame: [count:uint16][ id:uint16, xq:uint16, yq:uint16 ] * count
  let frame=1, tick=0, flushedExtra=0;
  const maxExtraFrames = Math.round(OPT.flushMaxSec * OPT.fps);

  const nearNeckJiggle = ()=>{
    const prog = frame/Math.max(1,targetFrames);
    const amp = prog>0.85 ? 2.0 : 1.0;
    for(const b of sand){
      if (Math.abs(b.position.y) < 26){
        Body.applyForce(b, b.position, {x:(Math.random()-0.5)*1e-5*amp, y:0});
      }
    }
  };

  const anyTop = ()=> sand.some((b,i)=> !settled[i] && b.position.y < 0);

  function dumpSparseFrame(){
    // temp buffer for updates (worst-case: all grains move → 2 + 6*gr)
    const upd = [];
    for(let i=0;i<OPT.grains;i++){
      if(settled[i]) continue;

      // settle test (velocity in px/s)
      const v = sand[i].velocity;
      const speed = Math.hypot(v.x, v.y);
      if (sand[i].position.y > OPT.r*2 && speed < OPT.settleSpeed){
        if (++stillCount[i] >= settleTicks){
          settled[i] = 1;
          // final snap to quantized pos (ensure we emit one last update)
          const xq = Math.max(0, Math.min(65535, Math.round((sand[i].position.x + OPT.bulb + 5) * Q)));
          const yq = Math.max(0, Math.min(65535, Math.round((sand[i].position.y + OPT.H   + 5) * Q)));
          if (xq !== lastXQ[i] || yq !== lastYQ[i]) {
            lastXQ[i]=xq; lastYQ[i]=yq;
            upd.push(i, xq, yq);
          }
          continue;
        }
      } else {
        stillCount[i] = 0; // moving again
      }

      // sparse delta: write only if quantized pos changed
      const xq = Math.max(0, Math.min(65535, Math.round((sand[i].position.x + OPT.bulb + 5) * Q)));
      const yq = Math.max(0, Math.min(65535, Math.round((sand[i].position.y + OPT.H   + 5) * Q)));
      if (xq !== lastXQ[i] || yq !== lastYQ[i]) {
        lastXQ[i]=xq; lastYQ[i]=yq;
        upd.push(i, xq, yq);
      }
    }

    // write count + updates
    writeU16(upd.length/3);
    const buf = Buffer.allocUnsafe(upd.length * 2);
    for(let j=0;j<upd.length;j++) buf.writeUInt16LE(upd[j], j*2);
    ws.write(buf);
  }

  // run main segment
  while(frame <= targetFrames){
    nearNeckJiggle();
    Matter.Engine.update(engine, dtMs);
    tick++;
    if (tick % sampleEvery === 0){
      dumpSparseFrame();
      frame++;
    }
  }

  // ensure top empties
  while(anyTop() && flushedExtra < maxExtraFrames){
    nearNeckJiggle();
    Matter.Engine.update(engine, dtMs);
    tick++;
    if (tick % sampleEvery === 0){
      dumpSparseFrame();
      frame++; flushedExtra++;
    }
  }

  // finalize
  const frames = frame;                       // total frames incl. extra
  const retimeFps = frames / OPT.duration;    // viewer uses this to land exactly on duration

  await new Promise(res => ws.end(res));

  const meta = {
    version: 4,
    format: "sparse",
    fps: retimeFps,
    grains: OPT.grains,
    frames,
    Q,
    neck: OPT.neck,
    H: OPT.H,
    bulb: OPT.bulb,
    r: OPT.r,
    k: OPT.k,
    bin: `${base}.bin`
  };

  fs.writeFileSync(jsonPath, JSON.stringify(meta, null, 2));
  console.log(`Wrote:\n  ${jsonPath}\n  ${binPath}`);
  console.log(`Tip: serve ${base}.bin with gzip for ~2–4× smaller transfer.`);
}

bake().catch(e=>{ console.error(e); process.exit(1); });
