// bake.js — Baked hourglass with classic shape, no leftovers
// npm i matter-js
const fs = require('fs');
const path = require('path');
const Matter = require('matter-js');

function arg(name, def){ const i = process.argv.indexOf(name); return i>0 ? process.argv[i+1] : def; }

const OPT = {
  duration: +arg('--duration', 60),       // seconds
  fps:      +arg('--fps', 30),
  grains:   +arg('--grains', 3500),
  full:     +arg('--full', 0.92),         // 0..1, how "full" the top starts
  neck:     +arg('--neck', 16),
  H:        +arg('--H', 330),             // half-height
  bulb:     +arg('--bulb', 205),          // half-width at caps
  r:        +arg('--r', 2.6),             // grain radius
  k:        +arg('--k', 1.05),            // shape exponent: 1 ≈ straight sides, >1 rounder
  tiltDeg:  +arg('--tilt', 1.2),          // tiny gravity tilt to avoid perfect symmetry jams
  slat:     +arg('--slat', 4),            // y-step for rotated wall slats (smaller = smoother)
};

OPT.grains = Math.max(200, Math.round(OPT.grains * OPT.full));

// Classic, icon-like silhouette: nearly linear sides with slight rounding near the waist.
function widthAtY(y, neck=OPT.neck, bulb=OPT.bulb, H=OPT.H, k=OPT.k){
  const t = Math.min(1, Math.abs(y)/H);           // 0 at neck, 1 at caps
  const s = Math.pow(t, k);                        // k≈1 -> straight sides
  return neck + (bulb - neck) * s;
}

// Build smooth walls with rotated slats (no horizontal ledges)
function buildWalls(world){
  const {Bodies, World} = Matter;
  const parts = [];
  const thick = 8;                // glass wall thickness (collision only)
  for (let y=-OPT.H; y<OPT.H; y+=OPT.slat){
    const y0 = y, y1 = Math.min(OPT.H, y + OPT.slat);
    const w0 = widthAtY(y0), w1 = widthAtY(y1);
    const addSlat = (x0,y0,x1,y1) => {
      const cx=(x0+x1)/2, cy=(y0+y1)/2;
      const len=Math.hypot(x1-x0,y1-y0);
      const ang=Math.atan2(y1-y0, x1-x0);
      parts.push(Bodies.rectangle(cx, cy, thick, len+1, {
        isStatic:true, angle:ang, friction:0.08, frictionStatic:0.02, restitution:0.0
      }));
    };
    addSlat(-w0,y0,-w1,y1); // left
    addSlat(+w0,y0,+w1,y1); // right
  }
  // top/bottom caps
  parts.push(Bodies.rectangle(0, -OPT.H-8, OPT.bulb*2+40, 16, { isStatic:true }));
  parts.push(Bodies.rectangle(0,  OPT.H+8, OPT.bulb*2+40, 16, { isStatic:true }));

  World.add(world, parts);
}

async function bake(){
  const {Engine, World, Bodies, Body} = Matter;
  const engine = Engine.create();
  const world  = engine.world;

  // Gravity with tiny tilt
  const gMag = 0.0018;                      // tuned for matter-js
  const th = OPT.tiltDeg * Math.PI/180;
  world.gravity.x = Math.sin(th);
  world.gravity.y = Math.cos(th);
  world.gravity.scale = gMag;

  buildWalls(world);

  // Sand (top bulb only)
  const grains = [];
  for (let i=0;i<OPT.grains;i++){
    const yy = -OPT.H + 12 + Math.random()*(OPT.H*0.82);
    const w  = widthAtY(yy) - 2;
    const xx = (Math.random()*2-1) * w * 0.74;
    const b = Bodies.circle(xx, yy, OPT.r, {
      friction: 0.05, frictionStatic: 0.02, frictionAir: 0.001, restitution: 0.05, density: 0.001
    });
    grains.push(b);
  }
  World.add(world, grains);

  // Bake loop
  const hzPhys = 240;
  const dtMs = 1000/hzPhys;
  const sampleEvery = Math.max(1, Math.round(hzPhys / OPT.fps));
  const targetFrames = Math.ceil(OPT.duration * OPT.fps);

  const Q = 32; // quantization ticks per pixel
  const arr = []; // we’ll push xq,yq pairs per grain per frame

  let frame = 0, tick = 0, lastCrossTick = 0;

  const nearNeckJiggle = () => {
    // gentle horizontal jiggle near the neck; stronger in last 15%
    const prog = frame / targetFrames;
    const amp = prog > 0.85 ? 2.0 : 1.0;
    for (const b of grains){
      const ay = Math.abs(b.position.y);
      if (ay < 26) Body.applyForce(b, b.position, { x:(Math.random()-0.5)*1e-5*amp, y:0 });
    }
  };

  const dump = () => {
    for (let i=0;i<grains.length;i++){
      const b = grains[i];
      const xq = Math.max(0, Math.min(65535, Math.round((b.position.x + OPT.bulb + 5) * Q)));
      const yq = Math.max(0, Math.min(65535, Math.round((b.position.y + OPT.H   + 5) * Q)));
      arr.push(xq, yq);
    }
  };

  const anyTop = () => grains.some(b => b.position.y < 0);

  while (frame < targetFrames){
    nearNeckJiggle();
    Engine.update(engine, dtMs);
    tick++;
    // detect flow for stall stats (not essential)
    if (tick % sampleEvery === 0){
      dump(); frame++;
    }
  }

  // Guarantee empty top: keep baking until no grain has y<0 (max +20s)
  let extra = 0, maxExtra = OPT.fps * 20;
  while (anyTop() && extra < maxExtra){
    nearNeckJiggle();
    Engine.update(engine, dtMs);
    tick++;
    if (tick % sampleEvery === 0){
      dump(); frame++; extra++;
    }
  }

  // Retiming: set fps so playback lasts exactly OPT.duration seconds
  const frames = frame;
  const retimeFps = frames / OPT.duration;

  // Pack
  const store = Uint16Array.from(arr);
  const meta = {
    version: 2,
    fps: retimeFps,            // <- viewer will play it for exactly duration seconds
    grains: OPT.grains,
    frames,
    Q,
    neck: OPT.neck,
    H: OPT.H,
    bulb: OPT.bulb,
    r: OPT.r
  };

  const out = { meta, data: Buffer.from(store.buffer).toString('base64') };
  const outDir = path.join(process.cwd(), 'bakes');
  fs.mkdirSync(outDir, { recursive:true });
  const fname = path.join(outDir, `hourglass_${OPT.duration}s_neck${OPT.neck}_k${OPT.k}_full${OPT.full}.json`);
  fs.writeFileSync(fname, JSON.stringify(out));
  console.log(`\nBaked ${frames} frames (retime fps=${retimeFps.toFixed(3)}) → ${fname}`);
}

bake().catch(err => { console.error(err); process.exit(1); });
