// server.js — Bake UI server (Express + SSE, patched)
const express = require("express");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const PORT = process.env.PORT || 5173;
const ROOT = process.cwd();
const BAKES_DIR = path.join(ROOT, "bakes");
const PUBLIC_DIR = path.join(ROOT, "public");
const BAKE_JS = path.join(ROOT, "bake.js");

fs.mkdirSync(BAKES_DIR, { recursive: true });
fs.mkdirSync(PUBLIC_DIR, { recursive: true });

const app = express();
app.use(express.json());
app.use("/bakes", express.static(BAKES_DIR, { maxAge: 0 }));
app.use("/", express.static(PUBLIC_DIR, { maxAge: 0 }));

// ---- tasks registry ----
const tasks = new Map();
const newId = () => Math.random().toString(36).slice(2, 10);

// Helper to push SSE to every listener of a task
function pushEvent(task, event, payload) {
  task.logs.push({ event, payload, t: Date.now() });
  for (const res of task.listeners) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
}

// ---- start bake ----
app.post("/api/bake", (req, res) => {
  const id = newId();
  const task = { id, logs: [], listeners: [], done: false };
  tasks.set(id, task);

  const body = req.body || {};

  // Map known numeric/body options to CLI flags expected by bake.js
  const flagMap = {
    duration: "--duration",
    grains: "--grains",
    fps: "--fps",
    full: "--full",
    neck: "--neck",
    H: "--H",
    bulb: "--bulb",
    r: "--r",
    k: "--k",
    tiltDeg: "--tiltDeg",
    slat: "--slat",
    flushMaxSec: "--flushMaxSec",
    sleepVel: "--sleepVel",
    sleepMs: "--sleepMs",
    c1: "--c1",
    c2: "--c2",
  };

  const args = [BAKE_JS, "--progress", "--outDir", BAKES_DIR];
  for (const [key, flag] of Object.entries(flagMap)) {
    if (body[key] !== undefined && body[key] !== null && body[key] !== "") {
      args.push(flag, String(body[key]));
    }
  }
  if (body.noFlush) args.push("--noFlush");

  console.log(`[bake] spawn: node ${args.map(a => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`);

  const proc = spawn(process.execPath, args, { cwd: ROOT, env: process.env });
  task.proc = proc;

  // stream child output → parse progress
  let buffer = "";
  const handleChunk = (buf) => {
    buffer += buf.toString("utf8");
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trimEnd();
      buffer = buffer.slice(idx + 1);
      handleLine(line);
    }
  };

  const handleLine = (line) => {
    if (!line) return;
    if (line.startsWith("BAKE ")) {
      try {
        const msg = JSON.parse(line.slice(5));
        if (msg.event === "progress") {
          const pct = Math.max(0, Math.min(100, Math.round((msg.frame / Math.max(1, msg.target)) * 100)));
          pushEvent(task, "progress", { pct, frame: msg.frame, target: msg.target });
        } else if (msg.event === "done") {
          task.done = true;
          const rel = (msg.file || "").replace(/\\/g, "/").replace(/^(\.\/|\/)?/, "");
          pushEvent(task, "done", { file: `/${rel}`, frames: msg.frames, fps: msg.fps });
        } else {
          pushEvent(task, "meta", msg);
        }
      } catch (err) {
        pushEvent(task, "log", { line });
      }
    } else {
      pushEvent(task, "log", { line });
    }
  };

  proc.stdout.on("data", handleChunk);
  proc.stderr.on("data", handleChunk);
  proc.on("close", (code) => pushEvent(task, "exit", { code }));

  res.json({ id });
});

// ---- SSE stream ----
app.get("/api/stream/:id", (req, res) => {
  const id = req.params.id;
  const task = tasks.get(id);
  if (!task) return res.status(404).end();

  console.log(`[SSE] connect id=${id} (listeners=${task.listeners.length})`);

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  // If behind nginx: res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  // Send a hello + backlog so UI updates immediately
  res.write(`event: hello\ndata: {"ok":true}\n\n`);
  for (const { event, payload } of task.logs) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  // Heartbeat to keep connection alive
  const hb = setInterval(() => {
    res.write(`event: ping\n`);
    res.write(`data: ${Date.now()}\n\n`);
  }, 15000);

  task.listeners.push(res);
  req.on("close", () => {
    clearInterval(hb);
    task.listeners = task.listeners.filter((r) => r !== res);
    console.log(`[SSE] disconnect id=${id} (listeners=${task.listeners.length})`);
  });
});

// ---- index of existing bakes ----
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
