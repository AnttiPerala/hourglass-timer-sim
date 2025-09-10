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
const BAKE_SCRIPT = path.join(ROOT, "bake.js");

// Ensure folders/files exist
if (!fs.existsSync(BAKES_DIR)) fs.mkdirSync(BAKES_DIR, { recursive: true });
if (!fs.existsSync(INDEX_PATH)) fs.writeFileSync(INDEX_PATH, "[]", "utf-8");

app.use(express.json({ limit: "2mb" }));

/* =========================
   In-memory SSE task state
   ========================= */
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

/* ===============  API  =============== */

// Health probe
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// Start a bake
app.post("/api/bake", (req, res) => {
  try {
    const p = req.body || {};
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;

    const args = [
      BAKE_SCRIPT,
      "--id", id,
      "--duration", String(p.duration ?? 10),
      "--fps", String(p.fps ?? 60),
      "--grains", String(p.grains ?? 500),
      "--full", String(p.full ?? 1),
      "--neck", String(p.neck ?? 12),
      "--H", String(p.H ?? 500),
      "--bulb", String(p.bulb ?? 220),
      "--r", String(p.r ?? 2),
      "--bounce", String(p.bounce ?? 0.12),            // NEW: bounciness
      "--k", String(p.k ?? 0.1),
      "--tiltDeg", String(p.tiltDeg ?? 0),
      "--c1", String(p.c1 ?? 0.0),
      "--c2", String(p.c2 ?? 0.0),
      "--slat", String(p.slat ?? 0),
      "--wallThickness", String(p.wallThickness ?? 0), // outward-only walls

      "--sleepVel", String(p.sleepVel ?? 2),
      "--sleepMs", String(p.sleepMs ?? 500),
      "--flushMaxSec", String(p.flushMaxSec ?? 15),
      ...(p.noFlush ? ["--noFlush"] : []),

      "--outDir", "bakes",
      "--outputMode", String(p.outputMode ?? "dense"),
      "--Q", String(p.Q ?? 32),

      "--progress"
    ];

    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], cwd: ROOT });
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
          else addBacklog(id, "log", { level: "info", msg: s });
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

// SSE stream — return 404 for unknown IDs (no phantom streams)
app.get("/api/stream/:id", (req, res) => {
  const { id } = req.params;
  const t = tasks.get(id);
  if (!t) {
    res.status(404).json({ error: "unknown task id" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  res.write(`: connected ${Date.now()}\n\n`);

  t.clients.add(res);
  res.write(makeEvent("hello", { id, now: Date.now() }));
  for (const evt of t.backlog) res.write(makeEvent(evt.name, evt.data));

  const hb = setInterval(() => { try { res.write(makeEvent("ping", { t: Date.now() })); } catch {} }, 15_000);
  req.on("close", () => { clearInterval(hb); t.clients.delete(res); });
});

// Index JSON
app.get("/api/index", (_req, res) => {
  try {
    const raw = fs.readFileSync(INDEX_PATH, "utf-8");
    res.setHeader("Content-Type", "application/json");
    res.send(raw);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/* ============== HTML & static ============== */
function sendHtml(res, file) { res.setHeader("Cache-Control", "no-cache"); res.sendFile(path.join(PUB_DIR, file)); }
app.get("/baker.html", (_req, res) => sendHtml(res, "baker.html"));
app.get("/player.html", (_req, res) => sendHtml(res, "player.html"));
app.get("/index.html", (_req, res) => sendHtml(res, "index.html"));
app.get("/", (_req, res) => res.redirect("/baker.html"));
app.use("/public", express.static(PUB_DIR, { extensions: ["html"] }));
app.use("/bakes", express.static(BAKES_DIR));
app.use("/", express.static(PUB_DIR));

/* ============== errors ============== */
app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal Server Error" });
});

app.listen(PORT, () => {
  console.log(`Hourglass server listening on http://localhost:${PORT}/`);
  console.log(`Baker UI: http://localhost:${PORT}/baker.html`);
});
// vim: set ts=2 sw=2 et: