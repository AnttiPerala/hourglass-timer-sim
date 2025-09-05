// server.js — Bake UI server (Express + SSE)
// Run:  node server.js
// Then open: http://localhost:5173/baker.html

const express = require("express");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const PORT = process.env.PORT || 5173;
const ROOT = process.cwd();
const BAKES_DIR = path.join(ROOT, "bakes");
const PUBLIC_DIR = path.join(ROOT, "public");

fs.mkdirSync(BAKES_DIR, { recursive: true });
fs.mkdirSync(PUBLIC_DIR, { recursive: true });

const app = express();
app.use(express.json());
app.use("/bakes", express.static(BAKES_DIR, { maxAge: 0 }));
app.use("/", express.static(PUBLIC_DIR, { maxAge: 0 }));

// ---- in-memory task registry ----
const tasks = new Map();
const newId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function sendSSE(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ---- start a bake ----
app.post("/api/bake", (req, res) => {
  const id = newId();
  const opts = req.body || {};
  const bakePath = path.join(ROOT, "bake.js");

  const args = [bakePath, "--progress"];
  for (const [k, v] of Object.entries(opts)) {
    if (v === undefined || v === null || v === "") continue;
    args.push(`--${k}`, String(v));
  }

  const proc = spawn(process.execPath, args, { cwd: ROOT, env: process.env });

  const task = { id, proc, logs: [], listeners: [], done: false };
  tasks.set(id, task);

  // line buffer for stdout/stderr
  let buffer = "";
  const handleChunk = (chunk) => {
    buffer += chunk.toString("utf8");
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trimEnd();
      buffer = buffer.slice(idx + 1);
      handleLine(line);
    }
  };
  const push = (event, payload) => {
    task.logs.push({ event, payload, t: Date.now() });
    for (const r of task.listeners) sendSSE(r, event, payload);
  };
  const handleLine = (line) => {
    if (!line) return;
    if (line.startsWith("BAKE ")) {
      try {
        const msg = JSON.parse(line.slice(5));
        if (msg.event === "progress") {
          const pct = Math.max(
            0,
            Math.min(100, Math.round((msg.frame / Math.max(1, msg.target)) * 100))
          );
          push("progress", { pct, frame: msg.frame, target: msg.target });
        } else if (msg.event === "done") {
          task.done = true;
          // Normalize Windows path to URL path
          const rel = msg.file.replace(/\\/g, "/").replace(/^(\.\/|\/)?/, "");
          push("done", { file: `/${rel}`, frames: msg.frames, fps: msg.fps });
        } else {
          push("meta", msg);
        }
      } catch {
        push("log", { line });
      }
    } else {
      push("log", { line });
    }
  };

  proc.stdout.on("data", handleChunk);
  proc.stderr.on("data", handleChunk);
  proc.on("close", (code) => push("exit", { code }));

  res.json({ id });
});

// ---- progress stream (SSE) ----
app.get("/api/stream/:id", (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) {
    res.status(404).end("No such task.");
    return;
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // send backlog
  for (const { event, payload } of task.logs) sendSSE(res, event, payload);
  task.listeners.push(res);

  req.on("close", () => {
    task.listeners = task.listeners.filter((r) => r !== res);
  });
});

// ---- existing bakes list ----
app.get("/api/index", (_req, res) => {
  try {
    const p = path.join(BAKES_DIR, "index.json");
    if (!fs.existsSync(p)) return res.json([]);
    res.json(JSON.parse(fs.readFileSync(p, "utf8")));
  } catch {
    res.json([]);
  }
});

app.listen(PORT, () => {
  console.log(`Bake UI listening on http://localhost:${PORT}/baker.html`);
});
