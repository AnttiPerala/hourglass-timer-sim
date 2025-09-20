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

// Presets are kept in the repo (public/ so they’re easy to commit & also downloadable)
const PRESETS_PATH = path.join(PUB_DIR, "presets.json");

if (!fs.existsSync(BAKES_DIR)) fs.mkdirSync(BAKES_DIR, { recursive: true });
if (!fs.existsSync(INDEX_PATH)) fs.writeFileSync(INDEX_PATH, "[]", "utf-8");
if (!fs.existsSync(PRESETS_PATH)) {
  fs.mkdirSync(PUB_DIR, { recursive: true });
  fs.writeFileSync(PRESETS_PATH, JSON.stringify({ version: 1, items: [] }, null, 2), "utf-8");
}

app.use(express.json({ limit: "2mb" }));
app.use("/public", express.static(PUB_DIR, { extensions: ["html"] }));
app.use("/bakes", express.static(BAKES_DIR));

/* ------------------------ SSE task registry ------------------------ */
const tasks = new Map(); // id -> {backlog:[], clients:Set, proc}
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

/* ------------------------ Bake API ------------------------ */
app.post("/api/bake", (req, res) => {
  try {
    const p = req.body || {};
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;

    const args = [
      "bake.js",
      "--id", id,
      "--duration", String(p.duration ?? 10),
      "--fps", String(p.fps ?? 60),
      "--grains", String(p.grains ?? 500),
      "--full", String(p.full ?? 1),
      "--neck", String(p.neck ?? 12),
      "--H", String(p.H ?? 500),
      "--bulb", String(p.bulb ?? 220),
      "--r", String(p.r ?? 2),
      "--bounce", String(p.bounce ?? 0.1),
      "--friction", String(p.friction ?? 0.02),
      "--tiltDeg", String(p.tiltDeg ?? 0),
      "--c1", String(p.c1 ?? 0.0),
      "--c2", String(p.c2 ?? 0.0),
      "--slat", String(p.slat ?? 0),
      "--wallThickness", String(p.wallThickness ?? 10),

      "--sleepVel", String(p.sleepVel ?? 2),
      "--sleepMs", String(p.sleepMs ?? 1500),
      "--flushMaxSec", String(p.flushMaxSec ?? 15),
      ...(p.noFlush ? ["--noFlush"] : []),

      "--outDir", "bakes",
      "--outputMode", String(p.outputMode ?? "dense"),
      "--Q", String(p.Q ?? 32),
      "--progress"
    ];

    const node = process.execPath;
    const child = spawn(node, args, { stdio: ["ignore", "pipe", "pipe"] });
    const task = { backlog: [], clients: new Set(), proc: child };
    tasks.set(id, task);
    res.json({ id });

    const onLine = (line, isErr = false) => {
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

  const hb = setInterval(() => {
    try { res.write(makeEvent("ping", { t: Date.now() })); } catch {}
  }, 15_000);

  req.on("close", () => {
    clearInterval(hb);
    t.clients.delete(res);
  });
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

/* ------------------------ Presets API ------------------------ */

function readPresetsFile() {
  try {
    const raw = fs.readFileSync(PRESETS_PATH, "utf-8");
    const obj = JSON.parse(raw || "{}");
    if (!obj || !Array.isArray(obj.items)) return { version: 1, items: [] };
    return obj;
  } catch {
    return { version: 1, items: [] };
  }
}
function writePresetsFile(obj) {
  const tmp = PRESETS_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf-8");
  fs.renameSync(tmp, PRESETS_PATH);
}

app.get("/api/presets", (_req, res) => {
  const data = readPresetsFile();
  res.setHeader("Cache-Control", "no-cache");
  res.json(data);
});

app.get("/api/preset/:name", (req, res) => {
  const name = decodeURIComponent(req.params.name || "");
  const data = readPresetsFile();
  const item = data.items.find(it => it.name === name);
  if (!item) return res.status(404).json({ error: "Not found" });
  res.json(item);
});

app.post("/api/preset", (req, res) => {
  const { name, settings, overwrite } = req.body || {};
  if (!name || typeof name !== "string" || !settings || typeof settings !== "object") {
    return res.status(400).json({ error: "name and settings required" });
  }
  const data = readPresetsFile();
  const idx = data.items.findIndex(it => it.name === name);
  if (idx >= 0 && !overwrite) return res.status(409).json({ error: "exists" });
  const entry = { name, settings };
  if (idx >= 0) data.items[idx] = entry; else data.items.push(entry);
  data.items.sort((a, b) => a.name.localeCompare(b.name));
  writePresetsFile(data);
  res.json({ ok: true });
});

app.delete("/api/preset/:name", (req, res) => {
  const name = decodeURIComponent(req.params.name || "");
  const data = readPresetsFile();
  const before = data.items.length;
  data.items = data.items.filter(it => it.name !== name);
  if (data.items.length === before) return res.status(404).json({ error: "Not found" });
  writePresetsFile(data);
  res.json({ ok: true });
});

/* ------------------------ Static & boot ------------------------ */
app.get("/", (_req, res) => res.redirect("/public/index.html"));
app.use("/", express.static(PUB_DIR, { extensions: ["html"] }));

app.listen(PORT, () => {
  console.log(`Hourglass server listening on http://localhost:${PORT}/`);
  console.log(`Baker UI: http://localhost:${PORT}/baker.html`);
});

