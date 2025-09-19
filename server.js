import express from "express";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";

const app = express();
const PORT = process.env.PORT || 5173;
const ROOT = process.cwd();
const PUB_DIR = path.join(ROOT, "public");
const BAKES_DIR = path.join(ROOT, "bakes");
const INDEX_PATH = path.join(BAKES_DIR, "index.json");

if (!fs.existsSync(BAKES_DIR)) fs.mkdirSync(BAKES_DIR, { recursive: true });
if (!fs.existsSync(INDEX_PATH)) fs.writeFileSync(INDEX_PATH, "[]", "utf-8");

app.use(express.json({ limit: "2mb" }));
app.use("/public", express.static(PUB_DIR, { extensions: ["html"] }));
app.use("/bakes", express.static(BAKES_DIR));

// In-memory task registry for SSE
const tasks = new Map(); // id -> { backlog:[], clients:Set, proc }
const makeEvent = (name, data) => `event: ${name}\n` + `data: ${JSON.stringify(data)}\n\n`;

function addBacklog(id, name, payload) {
  const t = tasks.get(id);
  if (!t) return;
  const evt = { name, data: payload, at: Date.now() };
  t.backlog.push(evt);
  if (t.backlog.length > 200) t.backlog.splice(0, t.backlog.length - 200);
  for (const res of t.clients) {
    try { res.write(makeEvent(name, payload)); } catch {}
  }
}

// POST /api/bake — spawn bake.js with flags sourced ONLY from UI
app.post("/api/bake", (req, res) => {
  try {
    const p = req.body || {};
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;

    const arg = (k, v) => v === undefined || v === null ? [] : ["--" + k, String(v)];
    const flag = (k, on) => on ? ["--" + k] : [];

    const args = [
      "bake.js",
      ...arg("id", id),
      ...arg("duration", p.duration),
      ...arg("fps", p.fps),
      ...arg("grains", p.grains),
      ...arg("full", p.full),
      ...arg("neck", p.neck),
      ...arg("H", p.H),
      ...arg("bulb", p.bulb),
      ...arg("r", p.r),
      ...arg("bounce", p.bounce),
      ...arg("friction", p.friction),
      ...arg("tiltDeg", p.tiltDeg),
      ...arg("c1", p.c1),
      ...arg("c2", p.c2),
      ...arg("slat", p.slat),
      ...arg("wallThickness", p.wallThickness),
      ...arg("sleepVel", p.sleepVel),
      ...arg("sleepMs", p.sleepMs),
      ...arg("sleepMode", p.sleepMode),
      ...arg("flushMaxSec", p.flushMaxSec),
      ...flag("noFlush", !!p.noFlush),
      ...arg("outDir", "bakes"),
      ...arg("outputMode", p.outputMode),
      ...arg("Q", p.Q),
      ...arg("outsideKillPad", p.outsideKillPad),
      ...arg("outsideCullFrames", p.outsideCullFrames),
      ...arg("maxSpeed", p.maxSpeed),
      ...arg("wallSlipPx", p.wallSlipPx),
      ...arg("wallSlipVel", p.wallSlipVel),
      ...arg("wallSlipKickF", p.wallSlipKickF),
      ...arg("wallSlipKickDownF", p.wallSlipKickDownF),
      ...arg("wallSlipCooldownMs", p.wallSlipCooldownMs),
      ...(p.unclogAssist ? ['--unclogAssist'] : []),
      "--progress"
    ];

    const node = process.execPath;
    const child = spawn(node, args, { stdio: ["ignore", "pipe", "pipe"] });
    const task = { backlog: [], clients: new Set(), proc: child };
    tasks.set(id, task);
    res.json({ id });

    const onLine = (line, isErr=false) => {
      const s = line.toString().trim();
      if (!s) return;
      if (s.startsWith("BAKE ")) {
        try {
          const obj = JSON.parse(s.slice(5));
          if (obj && obj.event) addBacklog(id, obj.event, obj);
        } catch {
          addBacklog(id, "log", { level: "warn", msg: s });
        }
      } else {
        addBacklog(id, "log", { level: isErr ? "err" : "info", msg: s });
      }
    };

    let outBuf = "";
    child.stdout.on("data", (chunk) => {
      outBuf += chunk.toString();
      let idx;
      while ((idx = outBuf.indexOf("\n")) >= 0) {
        const ln = outBuf.slice(0, idx);
        outBuf = outBuf.slice(idx + 1);
        onLine(ln, false);
      }
    });
    let errBuf = "";
    child.stderr.on("data", (chunk) => {
      errBuf += chunk.toString();
      let idx;
      while ((idx = errBuf.indexOf("\n")) >= 0) {
        const ln = errBuf.slice(0, idx);
        errBuf = errBuf.slice(idx + 1);
        onLine(ln, true);
      }
    });
    child.on("exit", (code, signal) => {
      addBacklog(id, "exit", { code, signal });
      setTimeout(() => tasks.delete(id), 5 * 60_000);
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
});

app.get("/api/stream/:id", (req, res) => {
  const { id } = req.params;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  let t = tasks.get(id);
  if (!t) { t = { backlog: [], clients: new Set(), proc: null }; tasks.set(id, t); }
  t.clients.add(res);

  res.write(makeEvent("hello", { id, now: Date.now() }));
  for (const evt of t.backlog) res.write(makeEvent(evt.name, evt.data));

  const hb = setInterval(() => { try { res.write(makeEvent("ping", { t: Date.now() })); } catch {} }, 15_000);
  req.on("close", () => { clearInterval(hb); t.clients.delete(res); });
});

app.get("/api/index", (req, res) => {
  try {
    const raw = fs.readFileSync(INDEX_PATH, "utf-8");
    res.setHeader("Content-Type", "application/json");
    res.send(raw);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/", (req, res) => res.redirect("/public/baker.html"));
app.use("/", express.static(PUB_DIR, { extensions: ["html"] }));

app.listen(PORT, () => {
  console.log(`Hourglass server listening on http://localhost:${PORT}/`);
  console.log(`Baker UI: http://localhost:${PORT}/baker.html`);
});
