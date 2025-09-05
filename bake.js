// bake.js  — Node 18+, npm i matter-js
const fs = require('fs');
const path = require('path');
const Matter = require('matter-js');

function widthAtY(y, neck, bulb, H){
  const a = (bulb - neck) / (H*H);
  return neck + a * y * y;
}

async function bake({duration=60, fps=30, grains=4000, neck=16, H=330, bulb=205, r=3}) {
  const Engine = Matter.Engine, Bodies = Matter.Bodies, World = Matter.World;
  const engine = Engine.create({ gravity: { x:0, y:1 }});
  const world = engine.world;
  world.gravity.scale = 0.0018; // tune

  // Build hourglass walls from many small static rectangles (curve approximation)
  const walls = [];
  const step = 8;
  for (let y=-H; y<=H; y+=step){
    const w = widthAtY(y, neck, bulb, H);
    const left  = Bodies.rectangle(-w, y, 8, step+2, { isStatic:true, friction:0.1, restitution:0.0 });
    const right = Bodies.rectangle(+w, y, 8, step+2, { isStatic:true, friction:0.1, restitution:0.0 });
    walls.push(left, right);
  }
  // floor/ceiling caps
  walls.push(Bodies.rectangle(0,-H-8, bulb*2+40, 16, {isStatic:true}));
  walls.push(Bodies.rectangle(0, H+8, bulb*2+40, 16, {isStatic:true}));
  World.add(world, walls);

  // Sand
  const bodies = [];
  for (let i=0;i<grains;i++){
    const yy = -H + 12 + Math.random()*(H*0.85);
    const w  = widthAtY(yy, neck, bulb, H) - 2;
    const xx = (Math.random()*2-1)*w*0.75;
    const b = Bodies.circle(xx, yy, r, {
      friction: 0.05, frictionStatic: 0.02, frictionAir: 0.001, restitution: 0.05,
      density: 0.001
    });
    bodies.push(b);
  }
  World.add(world, bodies);

  // Step & record
  const hzPhys = 240;
  const dt = 1000/hzPhys;
  const sampleEvery = Math.max(1, Math.round(hzPhys / fps));
  const frames = Math.ceil(duration * fps);
  const Q = 32; // quantization ticks per pixel (1/Q px precision)
  const xSpan = bulb*2 + 10, ySpan = H*2 + 10;

  const store = new Uint16Array(frames * grains * 2);
  let frameIndex = 0, tick = 0;

  while(frameIndex < frames){
    // anti-jam: tiny horizontal jiggle near the neck
    for (const b of bodies){
      const ay = Math.abs(b.position.y);
      if (ay < 20) Matter.Body.applyForce(b, b.position, {x:(Math.random()-0.5)*1e-5, y:0});
    }
    Engine.update(engine, dt);
    tick++;

    if (tick % sampleEvery === 0){
      // dump positions this frame
      for (let i=0;i<grains;i++){
        const b = bodies[i];
        const xq = Math.max(0, Math.min(65535, Math.round((b.position.x + bulb + 5) * Q)));
        const yq = Math.max(0, Math.min(65535, Math.round((b.position.y + H + 5) * Q)));
        const base = (frameIndex*grains + i)*2;
        store[base] = xq; store[base+1] = yq;
      }
      frameIndex++;
      if (frameIndex % 60 === 0) process.stdout.write('.');
    }
  }
  console.log(`\nBaked ${frames} frames @${fps}fps for ${grains} grains.`);

  const meta = { version:1, fps, grains, frames, Q, neck, H, bulb, r, cssW:900, cssH: Math.round(900*1.1) };
  const out = {
    meta,
    data: Buffer.from(store.buffer).toString('base64')
  };
  const outDir = path.join(__dirname,'bakes');
  fs.mkdirSync(outDir, {recursive:true});
  const fname = path.join(outDir, `hourglass_${duration}s_neck${neck}.json`);
  fs.writeFileSync(fname, JSON.stringify(out));
  console.log('Wrote', fname);
}

bake({
  duration: 60,   // make more runs with 30/60/120s etc.
  fps: 30,
  grains: 3500,   // push higher for prettier bakes
  neck: 16,
  H: 330, bulb: 205, r: 2.6
});
