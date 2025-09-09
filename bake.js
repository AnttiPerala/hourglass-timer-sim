// bake.js — cubic classic profile, retimed FPS, index.json, progress, and last-cross detection
// Example:
//   node bake.js --duration 60 --grains 3500 --full 0.90 --neck 12 --c1 1.15 --c2 1.7
// Options to control flushing extra frames:
//   --flushMaxSec 20    # how many seconds max to continue after target to empty the top
//   --noFlush           # stop exactly at target (lastCross may be < end)
// Progress lines are prefixed with:  BAKE {json}

const fs = require('fs');
const path = require('path');
const Matter = require('matter-js');

function arg(name, def){ const i = process.argv.indexOf(name); return i>0 ? process.argv[i+1] : def; }
const WANT_PROGRESS = process.argv.includes('--progress') || process.env.BAKE_PROGRESS === '1';
const emit = (obj) => { if (WANT_PROGRESS) process.stdout.write('BAKE ' + JSON.stringify(obj) + '\n'); };

const OPT = {
  duration:   +arg('--duration', 60),
  fps:        +arg('--fps', 30),      // capture fps (player is retimed)
  grains:     +arg('--grains', 3500),
  full:       +arg('--full', 0.92),   // 0..1 top fill
  neck:       +arg('--neck', 12),
  H:          +arg('--H', 330),
  bulb:       +arg('--bulb', 205),
  r:          +arg('--r', 2.6),
  c1:         +arg('--c1', 1.10),     // cubic curvature controls
  c2:         +arg('--c2', 1.55),
  tiltDeg:    +arg('--tilt', 1.2),
  slat:       +arg('--slat', 4),
  flushMaxSec:+arg('--flushMaxSec', 20),
  noFlush:    process.argv.includes('--noFlush'),
};
OPT.grains = Math.max(200, Math.round(OPT.grains * OPT.full));

const bez3=(p0,p1,p2,p3,t)=>{const u=1-t;return p0*u*u*u+3*p1*u*u*t+3*p2*u*t*t+p3*t*t*t;}
function widthAtY(y){
  const {H, bulb, neck, c1, c2} = OPT;
  if (y <= 0){ const t=(y+H)/H; return bez3(bulb, bulb*c1, neck*c2, neck, Math.max(0,Math.min(1,t))); }
  const t=y/H; return bez3(neck, neck*c2, bulb*c1, bulb, Math.max(0,Math.min(1,t)));
}
function buildWalls(world){
  const {Bodies, World} = Matter;
  const parts=[]; const thick=8;
  for(let y=-OPT.H;y<OPT.H;y+=OPT.slat){
    const y0=y, y1=Math.min(OPT.H,y+OPT.slat), w0=widthAtY(y0), w1=widthAtY(y1);
    const add=(x0,y0,x1,y1)=>{const cx=(x0+x1)/2,cy=(y0+y1)/2,len=Math.hypot(x1-x0,y1-y0),ang=Math.atan2(y1-y0,x1-x0);
      parts.push(Bodies.rectangle(cx,cy,thick,len+1,{isStatic:true,angle:ang,friction:0.08,frictionStatic:0.02,restitution:0}));};
    add(-w0,y0,-w1,y1); add(+w0,y0,+w1,y1);
  }
  parts.push(Matter.Bodies.rectangle(0,-OPT.H-8,OPT.bulb*2+40,16,{isStatic:true}));
  parts.push(Matter.Bodies.rectangle(0, OPT.H+8,OPT.bulb*2+40,16,{isStatic:true}));
  Matter.World.add(world, parts);
}

async function bake(){
  const {Engine, World, Bodies, Body} = Matter;
  const engine = Engine.create(); const world = engine.world;
  const th = OPT.tiltDeg * Math.PI/180;
  world.gravity.x = Math.sin(th); world.gravity.y = Math.cos(th); world.gravity.scale = 0.0018;

  buildWalls(world);

  // spawn grains in the top bulb
  const grains=[];
  for(let i=0;i<OPT.grains;i++){
    const yy=-OPT.H+12+Math.random()*(OPT.H*0.82);
    const w=Math.max(OPT.neck+3,widthAtY(yy)-2);
    const xx=(Math.random()*2-1)*w*0.74;
    grains.push(Bodies.circle(xx,yy,OPT.r,{friction:0.05,frictionStatic:0.02,frictionAir:0.001,restitution:0.05,density:0.001}));
  }
  World.add(world, grains);

  const hz=240, dtMs=1000/hz, sampleEvery=Math.max(1,Math.round(hz/OPT.fps));
  const targetFrames = Math.ceil(OPT.duration*OPT.fps);
  const Q=32; const packed=[]; let frame=0, tick=0;

  let lastCrossFrame = null;   // <-- we’ll record the first sample where top is empty

  const jiggle=()=>{const amp=(frame/targetFrames)>0.85?2.0:1.0;
    for(const b of grains){ if(Math.abs(b.position.y)<26) Body.applyForce(b,b.position,{x:(Math.random()-0.5)*1e-5*amp,y:0}); } };
  const anyTop=()=>grains.some(b=>b.position.y<0);
  const dump=()=>{ for(let i=0;i<grains.length;i++){ const b=grains[i];
    const xq=Math.max(0,Math.min(65535,Math.round((b.position.x+OPT.bulb+5)*Q)));
    const yq=Math.max(0,Math.min(65535,Math.round((b.position.y+OPT.H+5)*Q))); packed.push(xq,yq);} };

  emit({event:'meta', opts:OPT});

  // main pass
  while(frame<targetFrames){
    jiggle(); Engine.update(engine, dtMs); tick++;
    if(tick%sampleEvery===0){
      // if top just became empty, clip the moment
      if(lastCrossFrame===null && !anyTop()) lastCrossFrame = frame;  // record BEFORE increment
      dump(); frame++; if(frame%5===0) emit({event:'progress', frame, target:targetFrames});
    }
  }

  // flush until top empty (optional)
  let extra=0, maxExtra=Math.round(OPT.fps * OPT.flushMaxSec);
  while(!OPT.noFlush && anyTop() && extra<maxExtra){
    jiggle(); Engine.update(engine, dtMs); tick++;
    if(tick%sampleEvery===0){
      if(lastCrossFrame===null && !anyTop()) lastCrossFrame = frame;
      dump(); frame++; extra++; if(frame%5===0) emit({event:'progress', frame, target:targetFrames});
    }
  }
  if(lastCrossFrame===null) lastCrossFrame = Math.min(frame-1, targetFrames-1); // fallback

  // retime FPS so total playback = requested duration
  const frames=frame;
  const fpsRetimed = frames / OPT.duration;

  const store = Uint16Array.from(packed);
  const meta = {
    version: 4,
    fps: fpsRetimed,          // default playback fps (keeps whole bake at requested duration)
    captureFps: OPT.fps,      // capture fps (for reference)
    grains: OPT.grains,
    frames,
    Q,
    neck: OPT.neck,
    H: OPT.H,
    bulb: OPT.bulb,
    r: OPT.r,
    shape: "cubic",
    c1: OPT.c1,
    c2: OPT.c2,
    lastCrossFrame,               // <— the key new field
    lastCrossSec: lastCrossFrame / fpsRetimed   // time (sec) of last-cross at default playback
  };

  const out = { meta, data: Buffer.from(store.buffer).toString('base64') };
  const outDir = path.join(process.cwd(),'bakes'); fs.mkdirSync(outDir,{recursive:true});
  const fname = path.join(outDir, `hourglass_${OPT.duration}s_neck${OPT.neck}_c1${OPT.c1}_c2${OPT.c2}_full${OPT.full}.json`);
  fs.writeFileSync(fname, JSON.stringify(out));
  console.log(`\nBaked ${frames} frames (retime fps=${fpsRetimed.toFixed(3)}) → ${fname}`);

  // index.json maintenance
  const indexPath = path.join(outDir,'index.json');
  let index=[]; if(fs.existsSync(indexPath)){ try{ index=JSON.parse(fs.readFileSync(indexPath,'utf8')); }catch{} }
  const entry={ file:`bakes/${path.basename(fname)}`, label:`${OPT.duration}s • neck ${OPT.neck} • cubic c1=${OPT.c1} c2=${OPT.c2} • ${OPT.grains} grains`, duration:OPT.duration, grains:OPT.grains, neck:OPT.neck, c1:OPT.c1, c2:OPT.c2, lastCrossFrame, date:new Date().toISOString() };
  index = index.filter(e=>e.file!==entry.file); index.push(entry); index.sort((a,b)=>(a.duration-b.duration)||(a.neck-b.neck));
  fs.writeFileSync(indexPath, JSON.stringify(index,null,2));

  emit({event:'done', file: entry.file, frames, fps: fpsRetimed, lastCrossFrame});
}

bake().catch(err=>{ console.error(err); process.exit(1); });
