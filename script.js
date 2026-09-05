/* ==========================================================================
   StudyLens AI – Intelligent PDF Q&A
   --------------------------------------------------------------------------
   Vanilla JavaScript (async/await) — no frameworks.

   SECTIONS
   01. Configuration ................ API key, model, endpoints, demo data
   02. Global state .................. in-memory application state
   03. DOM references ................ cached element lookups
   04. Utilities ..................... small helpers
   05. Toasts ........................ friendly notifications
   06. Particles + ripple + nav ..... ambient visual effects
   07. Hero parallax ................. mouse tilt on the 3D visual
   08. Counter animation ............. animated insight numbers
   09. File intake ................... validation + drag & drop
   10. PDF extraction ................ PDF.js text extraction per page
   11. Text processing ............... cleanup, insights, unit detection
   12. Context engine ................ findRelevantContext() + broad context
   13. Gemini API .................... fetch() request with error handling
   14. Chat .......................... messages, typing, actions, history
   15. Voice input ................... Web Speech API
   16. Exam Mode ..................... generate & render practice exams
   17. Summary Mode .................. smart summaries + revision notes
   18. Settings modal ................ API key (in-memory) + model select
   19. Init .......................... wire everything up

   NOTE ON SECURITY:
   The real Gemini API key is NEVER stored in frontend code. AI requests go
   through the optional backend proxy (server.js) which keeps the key
   private, or through a session key pasted into the Settings modal. A
   rule-based offline brain keeps the app working even without any key.
   ========================================================================== */

"use strict";

/* ============================ 01. CONFIGURATION ========================= */

// IMPORTANT: no API key exists anywhere in this frontend. AI requests go
// through the bundled backend proxy (server.js), which owns the key.
const CONFIG = {
  model: "gemini-2.5-flash", // "gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-pro"
  temperature: 0.55,
  maxOutputTokens: 4096,
  // When a PDF is small enough we send the whole document as context.
  maxFullContextChars: 16000,
  // Maximum size of selected context for large documents.
  maxRelevantContextChars: 10000,
  maxFileSizeMB: 60,
};

// ---- Engine resolution -------------------------------------------------
// AI is reached through the backend proxy at /api/... (the key lives on the
// server). If the proxy is unreachable, the offline engine answers from the
// document itself, so the app always works.
let _proxyOk = null;
async function proxyAvailable() {
  if (_proxyOk !== null) return _proxyOk;
  const proto = window.location.protocol;
  if (proto === "file:" || proto === "about:") { _proxyOk = false; return false; }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`${window.location.origin}/api/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    _proxyOk = res.ok;
  } catch (_) { _proxyOk = false; }
  return _proxyOk;
}

const engineCanDoAI = proxyAvailable;

// System prompt used for every Q&A call. Forces document-only answers.
const SYSTEM_INSTRUCTION = `You are StudyLens AI, an academic PDF assistant.

Rules:
1. Answer ONLY from the provided document.
2. Do not hallucinate or invent information.
3. If the information is not present, say clearly: "This information is not available in the uploaded PDF."
4. Give clear, student-friendly answers.
5. For exam questions, prioritize the important concepts found in the document.
6. For summaries, preserve the original meaning of the document.
7. When possible, mention the relevant unit, section or page number.
8. Answer in the same language the student used (Odia, Hindi, English, etc.).`;

// Built-in demo document so users can try the app without uploading a PDF.
const DEMO_DOC = {
  name: "Demo – Operating Systems Notes",
  pages: [
    `UNIT 1 : INTRODUCTION TO OPERATING SYSTEMS

An operating system (OS) is system software that manages computer hardware and software resources and provides common services for computer programs. The OS acts as an intermediary between users and the computer hardware.

Functions of an operating system:
- Process management: scheduling and executing processes.
- Memory management: allocating and deallocating memory.
- File system management: organizing data into files and directories.
- Device management: controlling input/output devices.
- Security and protection: ensuring authorized access.

A process is a program in execution. A process has states: New, Ready, Running, Waiting and Terminated. The Process Control Block (PCB) stores process information. Scheduling algorithms include First Come First Serve (FCFS), Shortest Job Next (SJN), Round Robin (RR) and Priority Scheduling.

Key concept: Context switching is the mechanism to switch the CPU from one process to another process.`,
    `UNIT 2 : MEMORY MANAGEMENT

Memory management is the functionality of an operating system which handles the computer's primary memory. The main memory and the cache are usually managed as a set of contiguous or non-contiguous blocks.

Techniques:
- Contiguous allocation: processes are allocated a single contiguous block.
- Paging: memory is divided into fixed-size blocks called frames; processes are divided into pages. The page table maps logical addresses to physical addresses.
- Segmentation: processes are divided into variable-size segments; the segment table keeps the base and limit.

Virtual memory is a technique that gives the illusion of a very large main memory. Demand paging loads pages only when they are needed. Page replacement algorithms: FIFO, Optimal and Least Recently Used (LRU).

Thrashing happens when the system spends more time swapping pages than executing processes.`,
    `UNIT 3 : DEADLOCKS AND FILE SYSTEMS

A deadlock is a situation where a set of processes are blocked because each process is holding a resource and waiting for another resource held by another process.

Conditions for deadlock: Mutual Exclusion, Hold and Wait, No Preemption, and Circular Wait.

Deadlock handling:
- Prevention: break at least one of the four conditions.
- Avoidance: use the Banker's algorithm.
- Detection and recovery: detect using a wait-for graph and recover by preemption or killing a process.

File systems are the method and data structure used by the OS to control how data is stored and retrieved. Directory structures include single-level, two-level, tree and acyclic-graph.

Important exam topics: FCFS and Round Robin scheduling, page replacement algorithms, Banker's algorithm and deadlock conditions.`,
  ],
};

/* ============================ 02. GLOBAL STATE ========================== */

const state = {
  fileName: null,
  fileSize: null,
  pageText: [],       // cleaned text, one entry per page (index = page n-1)
  pageCount: 0,
  wordCount: 0,
  charCount: 0,
  units: [],
  questionsAsked: 0,
  processing: false,
  ready: false,
  currentAnswerEl: null, // element of the last AI answer (for regenerate)
  lastQuestion: null,
  lastContextInfo: null,
  chatHistory: [],    // [{ role: 'user'|'ai', text, ctx }]
  examAnswers: null,  // [{ question, type, options, answer }]
};

/* ============================ 03. DOM REFERENCES ======================== */

const $ = (id) => document.getElementById(id);

const dom = {
  particles: $("fx-particles"),
  dropzone: $("dropzone"),
  fileInput: $("fileInput"),
  dzTitle: $("dzTitle"),
  progressWrap: $("progressWrap"),
  uploadProgress: $("uploadProgress"),
  progressLabel: $("progressLabel"),
  statusList: $("statusList"),
  stUpload: $("statusList").querySelector(".st-upload"),
  stExtract: $("statusList").querySelector(".st-extract"),
  stReady: $("statusList").querySelector(".st-ready"),
  fileInfoCard: $("fileInfoCard"),
  fileName: $("fileName"),
  fileSize: $("fileSize"),
  fileStatusBadge: $("fileStatusBadge"),
  chatBody: $("chatBody"),
  chatEmpty: $("chatEmpty"),
  chatDocName: $("chatDocName"),
  questionInput: $("questionInput"),
  btnAsk: $("btnAsk"),
  btnMic: $("btnMic"),
  srVoice: $("srVoice"),
  btnClearChat: $("btnClearChat"),
  btnSavePdf: $("btnSavePdf"),
  btnSuggestionOpen: $("btnSuggestionOpen"),
  suggestionsWrap: $("suggestionsWrap"),
  insPages: $("insPages"),
  insWords: $("insWords"),
  insChars: $("insChars"),
  insTime: $("insTime"),
  insUnits: $("insUnits"),
  insAsked: $("insAsked"),
  unitList: $("unitList"),
  statusDot: $("statusDot"),
  statusText: $("statusText"),
  statusHint: $("statusHint"),
  toastContainer: $("toastContainer"),
  loadingOverlay: $("loadingOverlay"),
  loaderText: $("loaderText"),
  examCount: $("examCount"),
  examDifficulty: $("examDifficulty"),
  examType: $("examType"),
  btnGenerateExam: $("btnGenerateExam"),
  examResults: $("examResults"),
  examEmpty: $("examEmpty"),
  summaryText: $("summaryText"),
  summaryLabel: $("summaryLabel"),
  summaryOutput: $("summaryOutput"),
  btnCopySummary: $("btnCopySummary"),
  year: $("year"),
};

/* ============================ 04. UTILITIES ============================= */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const fmtBytes = (bytes) => {
  if (!Number.isFinite(bytes)) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
};

const isEmpty = (s) => !s || !String(s).trim();

// Lightweight text formatter: bold + line breaks (safe, escapes HTML first)
const formatRich = (text) => {
  const esc = String(text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  return esc
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");
};

// JSON-safe progress updates that never freeze the UI thread
const nextTick = () => new Promise((r) => setTimeout(r, 0));

// Clipboard helper that works on any origin (not just localhost/https),
// with a legacy <textarea> fallback when the Clipboard API is unavailable.
function copyToClipboard(text) {
  return new Promise((resolve, reject) => {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(resolve, () => legacyCopy(text, resolve, reject));
    } else {
      legacyCopy(text, resolve, reject);
    }
  });
}
function legacyCopy(text, resolve, reject) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    if (ok) resolve(); else reject(new Error("copy command failed"));
  } catch (err) { reject(err); }
}

/* ============================ 05. TOASTS ================================ */

function showToast(message, type = "info") {
  const el = document.createElement("div");
  el.className = `toast toast-ai ${type === "err" ? "err" : type === "ok" ? "ok" : ""}`;
  el.setAttribute("role", "status");
  el.innerHTML = `
    <div class="toast-body d-flex align-items-center gap-2 py-2">
      <i class="bi ${type === "err" ? "bi-x-octagon-fill" : type === "ok" ? "bi-check-circle-fill" : "bi-info-circle-fill"}"></i>
      <span class="small">${message}</span>
      <button class="btn-close btn-close-white ms-auto" style="font-size:10px" aria-label="Dismiss"></button>
    </div>`;
  dom.toastContainer.appendChild(el);
  const hide = () => el.classList.add("opacity-0", "translate-y-2");
  el.querySelector(".btn-close").addEventListener("click", () => { el.remove(); });
  setTimeout(hide, 4200);
  setTimeout(() => el.remove(), 4800);
}

/* ==================== 06. PARTICLES + RIPPLE + NAV ====================== */

// Lightweight canvas particle field (kept subtle for performance)
function initParticles() {
  const canvas = dom.particles;
  const ctx = canvas.getContext("2d");
  let w, h, parts = [];

  const resize = () => {
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
  };
  resize();
  window.addEventListener("resize", resize);

  const COUNT = Math.min(70, Math.floor(window.innerWidth / 18));
  const hues = [220, 255, 280, 320]; // blue / cyan / purple / pink

  for (let i = 0; i < COUNT; i++) {
    parts.push({
      x: Math.random() * w,
      y: Math.random() * h,
      r: Math.random() * 2.2 + 0.6,
      vy: -(Math.random() * 0.35 + 0.08),
      vx: (Math.random() - 0.5) * 0.12,
      hue: hues[(Math.random() * hues.length) | 0],
      tw: Math.random() * Math.PI * 2,
    });
  }

  (function loop() {
    ctx.clearRect(0, 0, w, h);
    for (const p of parts) {
      p.y += p.vy;
      p.x += p.vx + Math.sin(p.tw) * 0.08;
      p.tw += 0.02;
      if (p.y < -10) { p.y = h + 10; p.x = Math.random() * w; }
      if (p.x < -10) p.x = w + 10;
      if (p.x > w + 10) p.x = -10;
      const alpha = 0.25 + 0.4 * Math.abs(Math.sin(p.tw));
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${p.hue}, 90%, 65%, ${alpha})`;
      ctx.shadowColor = `hsl(${p.hue}, 90%, 60%)`;
      ctx.shadowBlur = 8;
      ctx.fill();
    }
    requestAnimationFrame(loop);
  })();
}

// Ripple effect for .ripple buttons
function initRipple() {
  document.addEventListener("pointerdown", (e) => {
    const host = e.target.closest(".ripple");
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 2;
    const ink = document.createElement("span");
    ink.className = "ripple-ink";
    ink.style.width = ink.style.height = `${size}px`;
    ink.style.left = `${e.clientX - rect.left - size / 2}px`;
    ink.style.top = `${e.clientY - rect.top - size / 2}px`;
    host.appendChild(ink);
    ink.addEventListener("animationend", () => ink.remove());
  });
}

// Scrollspy-lite: highlight the navbar link of the section in view
function initNavScroll() {
  const links = document.querySelectorAll(".navbar-nav a.nav-link");
  const map = {};
  links.forEach((l) => { map[l.getAttribute("href").slice(1)] = l; });
  const onScroll = () => {
    let current = "hero";
    for (const id of Object.keys(map)) {
      const sec = document.getElementById(id);
      if (!sec) continue;
      if (window.scrollY >= sec.offsetTop - 140) current = id;
    }
    links.forEach((l) => l.classList.toggle("active", l.getAttribute("href").slice(1) === current));
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
  // Close the collapsed mobile menu after clicking a link
  document.querySelectorAll(".navbar-nav a.nav-link").forEach((a) => {
    a.addEventListener("click", () => {
      const collapse = document.getElementById("navMenu");
      if (collapse.classList.contains("show")) bootstrap.Collapse.getOrCreateInstance(collapse).hide();
    });
  });
}

/* ======================= 07. HERO PARALLAX TILT ========================= */

function initHeroTilt() {
  const visual = document.getElementById("heroVisual");
  if (!visual) return;
  visual.addEventListener("mousemove", (e) => {
    const r = visual.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    visual.style.transform = `rotateY(${x * 10}deg) rotateX(${-y * 10}deg)`;
    visual.style.transition = "transform 0.15s ease-out";
  });
  visual.addEventListener("mouseleave", () => {
    visual.style.transform = "";
    visual.style.transition = "transform 0.6s ease";
  });
}

/* ======================== 08. COUNTER ANIMATION ========================= */

function animateCount(el, target) {
  const from = parseInt(el.dataset.last || "0", 10);
  const to = clamp(parseInt(target, 10) || 0, 0, 99999);
  el.dataset.last = to;
  if (el.dataset.prefix && el.dataset.prefix === "k" && to >= 1000) {
    // handled by formatters below
  }
  const dur = 900;
  const t0 = performance.now();
  const tick = (t) => {
    const p = clamp((t - t0) / dur, 0, 1);
    const ease = 1 - Math.pow(1 - p, 3);
    const val = Math.round(from + (to - from) * ease);
    el.textContent = val >= 1000 ? `${(val / 1000).toFixed(1)}k` : val;
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/* ============================= 09. FILE INTAKE ========================== */

function setStatus(badge, dot, text, hint) {
  if (badge) {
    dom.fileStatusBadge.className = `file-badge ${badge}`;
    dom.fileStatusBadge.textContent = text;
  }
  dom.statusDot.className = `status-dot ${dot}`;
  dom.statusText.textContent = text;
  if (hint) dom.statusHint.textContent = hint;
}

function setUiReady(v) {
  state.ready = v;
  dom.btnAsk.disabled = !v;
  dom.btnMic.disabled = !v;
  dom.questionInput.placeholder = v
    ? "Ask anything about this PDF…"
    : "Upload a PDF to get started…";
}

function validateFile(file) {
  if (!file) return { ok: false, err: "No file selected." };
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (!isPdf) return { ok: false, err: "Invalid file type. Please upload a PDF (.pdf) only." };
  if (file.size === 0) return { ok: false, err: "This PDF appears to be empty." };
  if (file.size > CONFIG.maxFileSizeMB * 1024 * 1024) {
    return { ok: false, err: `File too large (max ${CONFIG.maxFileSizeMB} MB).` };
  }
  return { ok: true };
}

function handleFile(file) {
  const check = validateFile(file);
  if (!check.ok) { showToast(check.err, "err"); return; }

  state.pageText = [];
  state.pageCount = 0;
  state.wordCount = 0;
  state.charCount = 0;
  state.units = [];
  state.questionsAsked = 0;
  state.ready = false;
  state.currentAnswerEl = null;
  if (state.fileName && state.fileName.startsWith("Demo")) {
    // switching from a demo: keep prior chat cleared
    clearChat(true);
  }

  state.fileName = file.name;
  state.fileSize = file.size;

  // Show file card
  dom.fileInfoCard.classList.remove("d-none");
  dom.fileName.textContent = file.name;
  dom.fileSize.textContent = fmtBytes(file.size);
  setStatus("busy", "working", "Extracting text…", "Reading your PDF with PDF.js");
  setUiReady(false);

  // Reset upload steps UI
  dom.statusList.classList.remove("d-none");
  dom.progressWrap.classList.remove("d-none");
  dom.uploadProgress.style.width = "0%";
  dom.progressLabel.textContent = "Uploading… 0%";
  [dom.stUpload, dom.stExtract, dom.stReady].forEach((s) => {
    s.classList.remove("done", "active");
    s.querySelector("i").className = "bi bi-circle";
  });

  // Simulated upload progress (keeps animation alive while PDF.js works)
  let prog = 0;
  const uploadTimer = setInterval(() => {
    prog = Math.min(prog + 3 + Math.random() * 7, 96);
    dom.uploadProgress.style.width = prog + "%";
    dom.progressLabel.textContent = `Uploading… ${Math.round(prog)}%`;
  }, 90);

  dom.stUpload.classList.add("active");
  dom.stUpload.querySelector("i").className = "bi bi-arrow-repeat";

  // Read as ArrayBuffer and hand it to PDF.js
  const reader = new FileReader();
  reader.onload = async () => {
    clearInterval(uploadTimer);
    dom.uploadProgress.style.width = "100%";
    dom.progressLabel.textContent = "Uploading… 100%";
    await nextTick();
    dom.stUpload.classList.remove("active");
    dom.stUpload.classList.add("done");
    dom.stUpload.querySelector("i").className = "bi bi-check-circle-fill";

    await extractPdf(reader.result);
  };
  reader.onerror = () => {
    clearInterval(uploadTimer);
    failDocument("Could not read this file. Please try another PDF.");
  };
  reader.readAsArrayBuffer(file);
}

function failDocument(message) {
  setStatus("err", "idle", "Extraction failed", message);
  setUiReady(false);
  dom.progressWrap.classList.add("d-none");
  showToast(message, "err");
}

// Global file-input handling + drag & drop + click to browse
function initFileUpload() {
  dom.fileInput.addEventListener("change", (e) => {
    if (e.target.files && e.target.files[0]) handleFile(e.target.files[0]);
    dom.fileInput.value = ""; // allow re-selecting the same file
  });

  const openPicker = () => dom.fileInput.click();
  dom.dropzone.addEventListener("click", openPicker);
  dom.dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPicker(); }
  });

  ["dragover", "dragenter"].forEach((ev) =>
    dom.dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dom.dropzone.classList.add("dragover");
    })
  );
  ["dragleave", "dragout"].forEach((ev) =>
    dom.dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dom.dropzone.classList.remove("dragover");
    })
  );
  dom.dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dom.dropzone.classList.remove("dragover");
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFile(f);
    else showToast("Please drop a single PDF file.", "err");
  });

  // Allow dropping anywhere on the dashboard to start the flow
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    if (e.target.closest("#dropzone")) return; // handled above
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFile(f);
  });

  // Hero + empty-state upload buttons
  $("btnHeroUpload").addEventListener("click", () => {
    document.getElementById("dashboard").scrollIntoView({ behavior: "smooth" });
    setTimeout(openPicker, 350);
  });
  $("btnEmptyUpload").addEventListener("click", openPicker);

  // Try Demo — load the built-in sample document instantly
  $("btnDemo").addEventListener("click", async () => {
    if (state.processing) return;
    clearChat(true);
    state.fileName = DEMO_DOC.name;
    state.fileSize = null;
    dom.fileInfoCard.classList.remove("d-none");
    dom.fileName.textContent = DEMO_DOC.name;
    dom.fileSize.textContent = "Built-in sample";
    setStatus("busy", "working", "Loading demo…", "Preparing a sample Operating Systems PDF");
    dom.progressWrap.classList.add("d-none");

    dom.statusList.classList.remove("d-none");
    dom.stUpload.classList.remove("active", "done");
    dom.stExtract.classList.remove("active", "done");
    dom.stReady.classList.remove("active", "done");
    [dom.stUpload, dom.stExtract, dom.stReady].forEach((s) => {
      s.querySelector("i").className = "bi bi-circle";
    });
    dom.stUpload.classList.add("done");
    dom.stUpload.querySelector("i").className = "bi bi-check-circle-fill";
    dom.stExtract.classList.add("active");
    dom.stExtract.querySelector("i").className = "bi bi-arrow-repeat";

    await nextTick();
    state.pageText = DEMO_DOC.pages.map((t) => cleanText(t));
    state.pageCount = state.pageText.length;
    finalizeDocument();
  });
}

/* ======================== 10. PDF EXTRACTION (PDF.js) =================== */

async function extractPdf(arrayBuffer) {
  if (!window.pdfjsLib) {
    failDocument("PDF.js failed to load. Check your internet connection.");
    return;
  }
  // Worker path must point to the matching CDN version
  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  dom.stExtract.classList.add("active");
  dom.stExtract.querySelector("i").className = "bi bi-arrow-repeat";
  dom.progressLabel.textContent = "Reading PDF…";

  try {
    // Load document from raw bytes
    const pdf = await pdfjsLib.getDocument({
      data: arrayBuffer,
      isEvalSupported: false,
    }).promise;

    if (pdf.numPages === 0) throw new Error("No pages found in this PDF.");

    const maxPages = Math.min(pdf.numPages, 400);
    if (pdf.numPages > 400) {
      showToast("This is a very large document — only the first 400 pages will be read.", "err");
    }

    // Page-by-page extraction with small pauses so the UI stays responsive
    for (let i = 1; i <= maxPages; i++) {
      dom.progressLabel.textContent = `Reading page ${i}…`;
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      const pageText = tc.items
        .map((it) => (it.str ? it.str : ""))
        .join(" ");
      state.pageText.push(cleanText(pageText));
      if (i % 5 === 0) await nextTick(); // let the browser paint/scroll
    }

    state.pageCount = state.pageText.length;
    dom.progressLabel.textContent = "Analyzing document…";
    await nextTick();
    finalizeDocument();
  } catch (err) {
    // Friendly mapping of PDF.js errors
    let msg = "Could not read this PDF. The file may be damaged.";
    if (err && err.name === "PasswordException") {
      msg = "This PDF is password-protected. Please open it and save an unprotected copy, then upload again.";
    } else if (err && err.message && /invalid pdf|corrupt|format/i.test(err.message)) {
      msg = "Invalid PDF file. Please upload a valid PDF document.";
    } else if (err && err.message && /worker/i.test(err.message)) {
      msg = "PDF.js worker failed to start. Check your internet connection and reload.";
    }
    failDocument(msg);
    console.error("[StudyLens] PDF extraction error:", err);
  }
}

/* ====================== 11. TEXT PROCESSING ============================= */

// Clean raw extracted text: collapse whitespace, drop junk fragments
function cleanText(raw) {
  return String(raw || "")
    .replace(/\s+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

// Detect units / chapters / sections / heading-style lines
function detectUnits() {
  const found = new Set();
  const combos = [];
  state.pageText.forEach((t, i) => {
    const page = t;
    // "UNIT 3 : ...", "Chapter 2", "Module 1", "Section 4.2"
    const re = /(unit|module|chapter|section|lesson|topic|part)\s*[:#-]?\s*[\d.]+/gi;
    let m;
    while ((m = re.exec(page))) {
      if (m[0].length <= 30) found.add(m[0].toUpperCase().replace(/\s+/g, " "));
    }
    // short heading-style lines (end with ':') or ALL CAPS lines
    const lines = page.split(/(?<=[.!?])\s+|\n/);
    for (const ln of lines) {
      const s = ln.trim().replace(/:$/, "");
      if ((ln.trim().endsWith(":") || /^[A-Z][A-Z\s]{4,}$/.test(s)) && s.length <= 60) {
        found.add(s.replace(/\s+/g, " "));
      }
    }
    if (i === 0 && page.slice(0, 80)) combos.push(page.slice(0, 80));
  });
  return [...found].slice(0, 10);
}

// Combined stats from all pages
function computeStats() {
  let words = 0, chars = 0;
  state.pageText.forEach((t) => {
    chars += t.length;
    words += (t.match(/\S+/g) || []).length;
  });
  state.charCount = chars;
  state.wordCount = words;
  // reading time ~220 words/min, at least 1 minute
  state.readTime = Math.max(1, Math.round(words / 220));
}

// Finish processing: render all insights + unlock chat
function finalizeDocument() {
  const hasText = state.pageText.some((t) => t && t.length > 40);
  if (!hasText) {
    failDocument("No readable text could be extracted. This PDF may be scanned images only (OCR not supported).");
    return;
  }
  computeStats();
  state.units = detectUnits();
  state.processing = false;

  dom.stExtract.classList.remove("active");
  dom.stExtract.classList.add("done");
  dom.stExtract.querySelector("i").className = "bi bi-check-circle-fill";
  dom.stReady.classList.add("done");
  dom.stReady.querySelector("i").className = "bi bi-check-circle-fill";

  setStatus("ok", "ready", "Ready for questions", "Ask anything — answers come from this document only.");
  dom.progressWrap.classList.add("d-none");

  dom.chatDocName.innerHTML = `<i class="bi bi-file-earmark-pdf"></i> ${escapeHtml(state.fileName)}`;
  dom.chatDocName.classList.add("ready");
  dom.chatEmpty.classList.add("d-none");

  // Optional: restore a previous chat persisted in localStorage for this file
  restoreChatHistory();

  // Insights
  animateCount(dom.insPages, state.pageCount);
  animateCount(dom.insWords, state.wordCount);
  animateCount(dom.insChars, state.charCount);
  animateCount(dom.insAsked, state.questionsAsked);
  dom.insTime.textContent = state.readTime > 1 ? `${state.readTime} min` : "<1 min";
  dom.insUnits.textContent = state.units.length;

  // Unit chips
  dom.unitList.innerHTML = "";
  if (state.units.length) {
    state.units.forEach((u) => {
      const c = document.createElement("span");
      c.className = "unit-chip";
      c.textContent = u;
      dom.unitList.appendChild(c);
    });
  } else {
    dom.unitList.innerHTML = '<span class="text-muted small">No explicit units/chapters detected.</span>';
  }

  if (setUiReady) setUiReady(true);
  showToast(`Document ready — ${state.pageCount} pages, ${state.wordCount.toLocaleString()} words.`, "ok");
  dom.questionInput.focus();
}

/* ======================= 12. CONTEXT ENGINE ============================= */

// Tokenizer that handles Odia/Hindi/English words and drops stop-words
function tokenize(text) {
  const stop = new Set([
    "what", "why", "how", "the", "a", "an", "and", "or", "is", "are", "was",
    "were", "of", "in", "on", "for", "to", "from", "with", "this", "that",
    "these", "those", "my", "me", "give", "give", "me", "please", "can",
    "about", "its", "it", "do", "does", "did", "bata", "kya", "ka", "ki",
  ]);
  // Guard: questions with emojis / punctuation only would return null here
  const words =
    String(text)
      .toLowerCase()
      .match(/[\u0900-\u097F\u0B00-\u0B7F\u0B80-\u0BFF\u0C00-\u0C7F\u0D00-\u0D7F\u0E00-\u0E7F]+|[a-z0-9]{3,}/g) || [];
  return words.filter((w) => !stop.has(w));
}

// Escape regex metacharacters so user input is safe inside RegExp sources
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Keyword-based context selection for large PDFs.
 * Scores each page by how well it matches the question words, then returns
 * the most relevant non-overlapping chunks, capped by maxRelevantContextChars.
 */
function findRelevantContext(question, pages) {
  const tokens = tokenize(question);
  // Score every page: 2 points per hit, extra for units/chapters mentions
  const scored = pages.map((text, i) => {
    const lower = text.toLowerCase();
    let score = 0;
    for (const tk of tokens) {
      const idx = lower.indexOf(tk);
      if (idx !== -1) {
        score += 2;
        // bonus if a whole-word match (meta chars in the token are escaped)
        if (new RegExp(`\\b${escapeRegExp(tk)}\\b`).test(lower)) score += 1;
      }
    }
    return { i, text, score };
  });

  scored.sort((a, b) => b.score - a.score);

  // If nothing matched, fall back to the first pages (usually the intro/units)
  const top = scored.filter((s) => s.score > 0).length
    ? scored.filter((s) => s.score > 0)
    : scored.slice(0, Math.min(4, pages.length));

  // Assemble up to maxRelevantContextChars of the best pages
  let budget = CONFIG.maxRelevantContextChars;
  const chosen = [];
  const chosenPages = [];
  for (const pg of top) {
    const text = pg.text.slice(0, Math.min(pg.text.length, budget));
    if (!text) continue;
    budget -= text.length;
    chosen.push(`[From page ${pg.i + 1}]\n${text}`);
    chosenPages.push(pg.i + 1);
    if (budget <= 0) break;
  }
  return { text: chosen.join("\n\n"), pages: chosenPages };
}

// Broad context for exam/summary modes: sample all pages evenly
function getBroadContext(pages, maxChars) {
  if (!pages.length) return { text: "", pages: [] };
  const total = pages.reduce((s, t) => s + t.length, 0);
  const out = [];
  const chosenPages = [];
  let used = 0;
  if (total <= maxChars) {
    pages.forEach((t, i) => {
      out.push(`[From page ${i + 1}]\n${t}`);
      chosenPages.push(i + 1);
    });
  } else {
    const perPage = Math.max(400, Math.floor(maxChars / pages.length));
    pages.forEach((t, i) => {
      const slice = t.slice(0, perPage);
      if (slice) {
        out.push(`[From page ${i + 1}]\n${slice}`);
        chosenPages.push(i + 1);
        used += slice.length;
      }
    });
    // If still under budget but pages were short, take a second pass
    if (used < maxChars * 0.7) {
      const extra = maxChars - used;
      pages.forEach((t, i) => {
        if (extra <= 0) return;
        const slice = t.slice(perPage, perPage * 2);
        if (slice && !out[i]) { out[i] += "\n" + slice; used += slice.length; }
      });
    }
  }
  return { text: out.join("\n\n"), pages: chosenPages };
}

// Decide full-document vs relevant context, returns { text, pages, mode }
function selectContext(question) {
  const allText = state.pageText.join("\n");
  const total = allText.length;
  if (total <= CONFIG.maxFullContextChars) {
    return { text: allText, pages: state.pageText.map((_, i) => i + 1), mode: "full" };
  }
  const rel = findRelevantContext(question, state.pageText);
  return { ...rel, mode: "relevant" };
}

/* ==================== 12b. LOCAL ENGINE (no-key fallback) ================
   When no API key is configured, a tiny rule-based engine answers from the
   extracted PDF so the whole app still runs end-to-end (chat, exam,
   summary). Real Gemini AI is used automatically once an API key is set. */

const brainDelay = () => new Promise((r) => setTimeout(r, 450 + Math.random() * 350));

// All readable sentences in the document, tagged with their page number
function docSentences() {
  const out = [];
  state.pageText.forEach((t, i) => {
    String(t)
      .split(/(?<=[.!?])\s+|\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 32)
      .forEach((s) => out.push({ page: i + 1, text: s }));
  });
  return out;
}

// How strongly a sentence matches the question (keyword overlap)
const scoreFor = (question, text) =>
  tokenize(question).reduce((sum, tk) => sum + (text.toLowerCase().includes(tk) ? 1 : 0), 0);

function topSentenceHits(question, n = 6) {
  return docSentences()
    .map((s) => ({ ...s, sc: scoreFor(question, s.text) }))
    .filter((s) => s.sc > 0)
    .sort((a, b) => b.sc - a.sc || b.text.length - a.text.length)
    .slice(0, n);
}

function pageRef(sents) {
  const pages = unique(sents.map((s) => s.page));
  return `(Pages ${pages.join(", ")})`;
}

// Most frequent content words in the document (rough "important topics")
function topTerms(limit = 12) {
  const freq = {};
  tokenize(state.pageText.join(" ")).forEach((w) => { freq[w] = (freq[w] || 0) + 1; });
  return Object.entries(freq)
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([w]) => w);
}

const qHas = (q, words) => words.some((w) => q.toLowerCase().includes(w));

// Offline Q&A — extractive answers built from the document itself
function localQa(question, ctx) {
  const q = question.toLowerCase();

  if (qHas(q, ["mcq", "multiple choice", "objective"])) {
    // Honour an explicit count like "20 MCQs…", otherwise default to 10
    const askedNum = (question.match(/\d+/) || [10])[0];
    const list = localExam({ count: String(clamp(parseInt(askedNum, 10) || 10, 5, 20)), difficulty: "Medium", type: "MCQ" });
    if (!list.length) return "This information is not available in the uploaded PDF.";
    return list.map((it, i) => `${i + 1}. ${it.q}\n${it.options.join("\n")}\nAnswer: ${it.a}`).join("\n\n");
  }
  if (qHas(q, ["important topic", "important question", "exam question", "which topic"])) {
    const terms = topTerms(12);
    if (!terms.length) return "This information is not available in the uploaded PDF.";
    return "Important topics found in your document:\n\n" + terms.map((t) => `• ${t}`).join("\n");
  }
  if (qHas(q, ["summar", "revision", "short note", "review"])) {
    const sents = docSentences().sort((a, b) => b.text.length - a.text.length).slice(0, 6);
    return "Short summary from your document:\n\n" +
      sents.map((s) => `• ${s.text}`).join("\n") + "\n\n" + pageRef(sents);
  }
  const hits = topSentenceHits(question, 6);
  if (!hits.length) {
    if (qHas(q, ["explain", "describe", "what is", "meaning", "example"])) {
      const defs = docSentences().filter((s) => / is | are | called | defined | means /.test(s.text)).slice(0, 4);
      if (defs.length) {
        return "From your document:\n\n" + defs.map((s) => `• ${s.text}`).join("\n") + "\n\n" + pageRef(defs);
      }
    }
    return "This information is not available in the uploaded PDF.";
  }
  return "Based on your document:\n\n" +
    hits.map((s) => `• ${s.text}`).join("\n") + "\n\n" + pageRef(hits);
}

// Offline exam generator — always produces EXACTLY `count` questions.
// For short documents it expands the pool with clause chunks, varies the
// MCQ split point, and rotates question frames so 20 requested questions
// are always delivered.
function localExam(cfg) {
  const count = parseInt(cfg.count || "5", 10) || 5;
  const type = cfg.type || "Mixed";
  const sents = docSentences().filter((s) => s.text.length >= 40);
  if (!sents.length) return [];

  // Enrich the pool: add clause-level chunks of long sentences for variety
  const pool = [];
  const seenKeys = new Set();
  const pushPool = (page, text) => {
    const t = text.trim();
    const key = t + "#" + page;
    if (!seenKeys.has(key) && t.length >= 45 && t.length <= 320) {
      seenKeys.add(key);
      pool.push({ page, text: t });
    }
  };
  sents.forEach((s) => {
    pushPool(s.page, s.text);
    if (s.text.length >= 150) {
      s.text
        .split(/[;,]|\band\b|\bbut\b|\bwhich\b|\bthat\b/)
        .map((x) => x.trim())
        .filter((x) => x.length >= 45)
        .forEach((chunk) => pushPool(s.page, chunk));
    }
  });
  if (!pool.length) return [];

  const letters = ["A", "B", "C", "D"];
  const items = [];
  const usedQs = new Set();
  const frames = ["According to the document, ", "Based on this PDF, ", "From the study notes, "];
  const pattern = ["mcq", "short", "long"]; // Mixed rotation
  const pcts = [0.38, 0.55, 0.70];           // different MCQ split points per sentence
  let idx = 0;
  let guard = 0;
  const guardMax = Math.max(count * 14, 240);

  while (items.length < count && guard++ < guardMax) {
    const base = pool[idx % pool.length];
    idx += 1;

    const slot = items.length % 3;
    const wantMcq = type === "MCQ" || (type === "Mixed" && pattern[slot] === "mcq");
    const longForm = type === "Long Answer" || (type === "Mixed" && pattern[slot] === "long");

    let q = "";
    let a = "";
    let options = [];

    if (wantMcq) {
      let cut = -1;
      const target = Math.round(base.text.length * pcts[items.length % pcts.length]);
      const before = base.text.lastIndexOf(" ", target);
      const after = base.text.indexOf(" ", target);
      cut = before > 0 && (after === -1 || target - before <= after - target) ? before : after === -1 ? target : after;
      const stem = base.text.slice(0, cut).trimEnd();
      const correct = base.text.slice(cut).trim();
      if (stem.length < 25 || correct.length < 10) {
        // Sentence too short for a clean fill-blank — use a "which statement"
        // MCQ built from real document sentences so the count is never missed.
        const picks = [];
        for (let k2 = 0; k2 < pool.length && picks.length < 4; k2++) {
          const cand = pool[(idx + k2) % pool.length].text;
          if (!picks.includes(cand)) picks.push(cand);
        }
        if (picks.length < 4) continue;
        q = frames[items.length % frames.length] + "which one of these statements is actually in the document?";
        a = `${letters[0]} ${picks[0]}`;
        options = picks.map((o, i) => `${letters[i]}) ${o}`);
      } else {
        q = frames[items.length % frames.length] + stem + " ______";
        const distractors = [];
        for (let k = 1; k <= 3 && distractors.length < 3; k++) {
          const other = pool[(idx + k) % pool.length];
          const d = other.text.slice(Math.round(other.text.length * 0.55)).trim();
          if (d && d !== correct && !distractors.includes(d)) distractors.push(d);
        }
        const opts = [correct, ...distractors].slice(0, 4);
        while (opts.length < 4) opts.push("None of the above");
        a = `${letters[opts.indexOf(correct)]} ${correct}`;
        options = opts.map((o, i) => `${letters[i]}) ${o}`);
      }
    } else {
      const lead = base.text.split(" ").slice(0, 6).join(" ").replace(/,$/, "");
      q = `${frames[items.length % frames.length]}write ${longForm ? "a detailed answer" : "a short note"} on: "${lead}…"`;
      a = base.text;
    }

    if (q && !usedQs.has(q)) {
      usedQs.add(q);
      items.push({ q, t: wantMcq ? "MCQ" : longForm ? "Long Answer" : "Short", options, a });
    }
  }

  // ---- Guaranteed fill 1: topic-based questions from extracted terms -----
  const termSrc = topTerms(40);
  const holder = pool[0];
  while (items.length < count && termSrc.length) {
    const k = items.length;
    const slot = k % 3;
    const wantMcq = type === "MCQ" || (type === "Mixed" && pattern[slot] === "mcq");
    const longForm = type === "Long Answer" || (type === "Mixed" && pattern[slot] === "long");
    const term = termSrc.shift();
    let q = "";
    let a = "";
    const options = [];
    if (wantMcq) {
      const four = [term, ...termSrc.slice(0, 3)];
      if (four.length < 4) break;
      q = `${frames[k % frames.length]}which of these is discussed as an important topic in the document?`;
      four.forEach((tm, i) => options.push(`${letters[i]}) ${tm}`));
      a = `${letters[0]} ${four[0]}`;
    } else {
      q = `${frames[k % frames.length]}write ${longForm ? "a detailed answer" : "a short note"} on the topic: "${term}"`;
      a = holder.text;
    }
    if (!usedQs.has(q)) {
      usedQs.add(q);
      items.push({ q, t: wantMcq ? "MCQ" : longForm ? "Long Answer" : "Short", options, a });
    }
  }

  // ---- Guaranteed fill 2: numbered statements — the count is ALWAYS met ----
  while (items.length < count) {
    const k = items.length;
    const base = pool[k % pool.length];
    const mcqSlot = type === "MCQ" || (type === "Mixed" && k % 3 === 0);
    if (mcqSlot) {
      const picks = [];
      for (let x = 0; x < pool.length && picks.length < 4; x++) {
        const c = pool[x].text;
        if (!picks.includes(c)) picks.push(c);
      }
      const four = picks.length >= 4 ? picks : picks.concat(["Not in the document", "Not in the document", "Not in the document"]).slice(0, 4);
      items.push({
        q: `Question ${items.length + 1} · ${frames[k % frames.length]}which one of these statements is from the document?`,
        t: "MCQ",
        options: four.map((o, i) => `${letters[i]}) ${o}`),
        a: `${letters[0]} ${four[0]}`,
      });
    } else {
      items.push({
        q: `Question ${items.length + 1} · ${frames[k % frames.length]}review the statement: "${base.text.split(" ").slice(0, 9).join(" ")}…"`,
        t: type === "Long Answer" ? "Long Answer" : "Short",
        options: [],
        a: base.text,
      });
    }
  }
  return items;
}

// Offline smart-summaries — extractive variants of each summary type
function localSummary(kind) {
  const sents = docSentences();
  if (!sents.length) return "No readable text to summarize.";
  const head = "";

  switch (kind) {
    case "chapter": {
      const blocks = state.units.length
        ? state.units.map((u) => {
            const rel = sents.filter((s) => s.text.toLowerCase().includes(u.toLowerCase())).slice(0, 3);
            const body = rel.length ? rel.map((s) => `• ${s.text}`).join("\n") : "(no sentences found for this label)";
            return `### ${u}\n${body}`;
          })
        : sents.slice(0, 8).map((s) => `• ${s.text}`).join("\n");
      return head + "Chapter Summary\n\n" + blocks + "\n\n" + pageRef(sents);
    }
    case "unit":
      return head + "Unit-wise Summary\n\n" +
        (state.units.length ? state.units.map((u) => `### ${u}`).join("\n") : "No explicit units were detected in this PDF.");
    case "concepts": {
      const terms = topTerms(12);
      return head + "Key Concepts\n\n" +
        (terms.length
          ? terms.map((t) => {
              const ex = sents.find((s) => s.text.toLowerCase().includes(t));
              return `• ${t}${ex ? ` — ${ex.text}` : ""}`;
            }).join("\n")
          : "No key concepts detected.");
    }
    case "definitions": {
      const defs = sents.filter((s) => / is | are | called | defined | means /.test(s.text)).slice(0, 6);
      return head + "Important Definitions\n\n" +
        (defs.length ? defs.map((s) => `• ${s.text}`).join("\n") : "No definition sentences detected.");
    }
    case "revision": {
      const short = sents.filter((s) => s.text.length <= 130).sort((a, b) => b.text.length - a.text.length).slice(0, 10);
      return head + "Exam Revision Notes\n\n" +
        short.map((s) => `• ${s.text}`).join("\n") + "\n\n" + pageRef(sents);
    }
    case "mcqs": {
      const list = localExam({ count: "20", difficulty: "Medium", type: "MCQ" });
      if (!list.length) return "20 MCQs with answers:\n\n(no readable sentences available)";
      return "20 MCQs with answers:\n\n" +
        list.map((it, i) => `${i + 1}. ${it.q}\n${it.options.join("\n")}\nAnswer: ${it.a}`).join("\n\n");
    }
    default:
      return head + sents.slice(0, 8).map((s) => `• ${s.text}`).join("\n");
  }
}

/* ========================= 13. GEMINI API =============================== */

// Parse + error-map Gemini's JSON response (same shape from proxy or direct)
async function parseGeminiResponse(res) {
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const code = data && data.error && data.error.code;
    const msg = data && data.error && data.error.message;
    let friendly = "";
    if (code === 429) friendly = "API rate limit reached. Please wait a moment and try again.";
    else if (code === 400) friendly = "The request was invalid. Try a shorter question or smaller document.";
    else if (code === 401 || code === 403) friendly = "Your API key is invalid or unauthorized. Check it in the backend proxy / API settings.";
    else if (code === 404) friendly = "The selected model is not available. Choose another model in settings.";
    else friendly = `AI service error (${code || res.status}). ${msg ? " " + msg : ""}`;
    throw new Error(friendly);
  }
  const text =
    data &&
    data.candidates &&
    data.candidates[0] &&
    data.candidates[0].content &&
    data.candidates[0].content.parts
      ? data.candidates[0].content.parts.map((p) => p.text).join("")
      : "";
  if (!text || !text.trim()) {
    throw new Error("The AI returned an empty response. Please try again.");
  }
  return text.trim();
}

// Single entry point: calls Gemini via the backend proxy, or directly with a
// session key as fallback. Returns the answer text.
async function callGemini(userPrompt, { system = SYSTEM_INSTRUCTION, temperature = CONFIG.temperature, maxTokens = CONFIG.maxOutputTokens, label = "Asking AI…" } = {}) {
  dom.loadingOverlay.classList.remove("d-none");
  dom.loaderText.textContent = label;
  try {
    // The backend proxy (server.js / api) owns the API key — never the frontend
    const body = {
      model: CONFIG.model,
      system,
      prompt: userPrompt,
      temperature,
      maxTokens,
    };
    const res = await fetch(`${window.location.origin}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return await parseGeminiResponse(res);
  } finally {
    dom.loadingOverlay.classList.add("d-none");
  }
}

// Build the Q&A prompt : SYSTEM rules + DOCUMENT + USER QUESTION
function buildQaPrompt(question, context) {
  return [
    `DOCUMENT:\n${context.text}`,
    `\n\nUSER QUESTION:\n${question}`,
    `\n\nRemember: answer ONLY from the document above. If the answer is not in the document, say it is not available in the uploaded PDF.`,
  ].join("");
}

/* ============================ 14. CHAT ================================= */

function clearChat(force) {
  if (!force && state.chatHistory.length === 0) return;
  state.chatHistory = [];
  dom.chatBody.innerHTML = "";
  state.questionsAsked = 0;
  animateCount(dom.insAsked, 0);
  dom.chatEmpty.classList.remove("d-none");
  saveHistoryStorage();
  if (!force) showToast("Chat cleared.", "ok");
}

function renderUserMsg(text) {
  const wrap = document.createElement("div");
  wrap.className = "msg msg-user";
  wrap.innerHTML = `
    <div class="bubble"></div>
    <div class="msg-meta"><span>You</span><span class="msg-time"></span></div>`;
  wrap.querySelector(".bubble").textContent = text;
  wrap.querySelector(".msg-time").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  dom.chatBody.appendChild(wrap);
  dom.chatBody.scrollTop = dom.chatBody.scrollHeight;
  return wrap;
}

// Animated "● ● ●" thinking bubble
function renderThinking() {
  const wrap = document.createElement("div");
  wrap.className = "msg msg-ai";
  wrap.innerHTML = `
    <div class="thinking"><span>Analyzing your document</span>
      <span class="t-dots"><span></span><span></span><span></span></span>
    </div>`;
  dom.chatBody.appendChild(wrap);
  dom.chatBody.scrollTop = dom.chatBody.scrollHeight;
  return wrap;
}

// Typewriter effect for AI text — fast enough on long answers, skippable on click
function typeInto(el, text) {
  return new Promise((resolve) => {
    const plain = text;
    let i = 0;
    const total = plain.length;
    const steps = Math.min(90, Math.max(30, Math.round(total / 60)));
    const chunkSize = Math.max(1, Math.ceil(total / (steps || 1)));
    let done = false;
    const finish = () => { if (done) return; done = true; resolve(); };
    (function step() {
      if (done) { finish(); return; }
      i = Math.min(total, i + chunkSize);
      el.innerHTML = escapeHtml(plain.slice(0, i)) + (i < total ? '<span class="caret"></span>' : "");
      dom.chatBody.scrollTop = dom.chatBody.scrollHeight;
      if (i < total) setTimeout(step, 16);
      else finish();
    })();
    // Tap the answer box to instantly finish typing
    el.closest(".bubble")?.addEventListener("pointerdown", finish, { once: true });
  });
}

function renderAiMsg(text, ctxInfo) {
  const wrap = document.createElement("div");
  wrap.className = "msg msg-ai";
  const ctxHtml = ctxInfo
    ? `<div class="ai-ctx"><i class="bi bi-pin-angle-fill"></i> Context selected from ${ctxInfo}</div>`
    : "";
  wrap.innerHTML = `
    <div class="bubble">
      <div class="ai-inner">
        <div class="msg-ai-title">
          <span class="ai-mini-orb"><i class="bi bi-stars"></i></span>
          AI Answer
        </div>
        <div class="ai-content"></div>
        ${ctxHtml}
        <div class="ai-actions">
          <button class="btn btn-sm btn-outline-ai act-copy"><i class="bi bi-clipboard me-1"></i>Copy</button>
          <button class="btn btn-sm btn-outline-ai act-regen"><i class="bi bi-arrow-repeat me-1"></i>Regenerate</button>
          <button class="btn btn-sm btn-outline-ai act-follow"><i class="bi bi-plus-circle me-1"></i>Ask Follow-up</button>
        </div>
      </div>
    </div>`;
  dom.chatBody.appendChild(wrap);
  dom.chatBody.scrollTop = dom.chatBody.scrollHeight;

  const content = wrap.querySelector(".ai-content");
  typeInto(content, text).then(() => {
    content.innerHTML = formatRich(text);
  });

  attachAiActions(wrap, text);

  return wrap;
}

// Wire up the Copy / Regenerate / Ask Follow-up buttons of an AI message.
// Used both for fresh answers and for restored chat history.
function attachAiActions(wrap, text) {
  const copy = wrap.querySelector(".act-copy");
  if (copy) {
    copy.addEventListener("click", () => {
      copyToClipboard(text)
        .then(() => showToast("Answer copied to clipboard.", "ok"))
        .catch(() => showToast("Could not copy. Select the text and copy manually.", "err"));
    });
  }

  const regen = wrap.querySelector(".act-regen");
  if (regen) {
    regen.addEventListener("click", async () => {
      if (state.processing) {
        showToast("Please wait for the current answer to finish.", "err");
        return;
      }
      const q = state.lastQuestion;
      if (!q) return;
      wrap.remove();
      await askAi(q);
    });
  }

  const follow = wrap.querySelector(".act-follow");
  if (follow) {
    follow.addEventListener("click", () => {
      dom.questionInput.focus();
      dom.questionInput.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }
}

// Open a print-friendly export of the conversation and let the user save it
// as a PDF via the browser's built-in "Save as PDF" target.
function saveAsPdf() {
  const msgs = dom.chatBody.querySelectorAll(".msg");
  if (!msgs.length) {
    showToast("Nothing to save yet — ask a question first.", "err");
    return;
  }
  const w = window.open("", "_blank");
  if (!w) {
    showToast("Pop-up blocked by the browser. Allow pop-ups, then try again.", "err");
    return;
  }

  const docName = escapeHtml(state.fileName || "My study document");
  const stamp = new Date().toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

  const rows = [];
  msgs.forEach((m) => {
    const isUser = m.classList.contains("msg-user");
    let text = "";
    if (isUser) {
      const bubble = m.querySelector(".bubble");
      text = bubble ? bubble.textContent : "";
    } else {
      const c = m.querySelector(".ai-content");
      text = c ? (c.innerText || c.textContent) : "";
      const ctx = m.querySelector(".ai-ctx");
      if (ctx) text += "\n(" + ctx.textContent.trim() + ")";
    }
    if (!text.trim()) return;
    rows.push(
      `<div class="pair ${isUser ? "user" : "ai"}">
        <div class="who">${isUser ? "Question" : "AI Answer"}</div>
        <div class="body">${escapeHtml(text)}</div>
      </div>`
    );
  });

  const insights = state.ready
    ? `Document: <b>${docName}</b> &middot; ${state.pageCount} pages &middot; ${state.wordCount.toLocaleString()} words`
    : `Document: <b>${docName}</b>`;
  const summary = state.summaryTextValue
    ? `<h2>Smart Summary</h2><div class="card">${formatRich(state.summaryTextValue)}</div>`
    : "";

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>StudyLens AI - ${escapeHtml(state.fileName || "Chat")}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:'Segoe UI',Roboto,Arial,sans-serif;color:#14101f;margin:32px auto;max-width:820px;padding:0 24px;line-height:1.55}
  .logo{font-size:13px;color:#6d28d9;font-weight:800;letter-spacing:2px;text-transform:uppercase}
  h1{font-size:22px;margin:6px 0 4px}
  .meta{color:#555;font-size:12px;margin-bottom:20px;padding-bottom:12px;border-bottom:2px solid #6d28d9}
  .pair{margin:0 0 18px;page-break-inside:avoid}
  .who{font-weight:800;color:#6d28d9;font-size:11px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px}
  .body{padding:10px 14px;border-radius:10px;white-space:pre-wrap;font-size:14px}
  .user .body{background:#eef2ff;border:1px solid #dbe3ff}
  .ai .body{background:#faf7ff;border:1px solid #e4d9ff}
  h2{font-size:15px;margin:22px 0 8px;color:#1e1b4b}
  .card{background:#faf7ff;border:1px solid #e4d9ff;border-radius:10px;padding:12px 14px;font-size:13px}
  .foot{font-size:11px;color:#999;margin-top:26px}
  @media print{body{max-width:100%}}
</style></head><body>
  <div class="logo">StudyLens AI</div>
  <h1>Study Q&amp;A &mdash; ${docName}</h1>
  <div class="meta">${insights} &middot; saved ${escapeHtml(stamp)}</div>
  ${rows.join("")}
  ${summary}
  <div class="foot">Generated by StudyLens AI (PDF &rarr; AI Analysis &rarr; Student Question &rarr; Intelligent Answer)</div>
</body></html>`;

  w.document.open();
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
}

// Core "ask" flow used by input, suggestions, demo chips and regenerate
async function askAi(question) {
  if (!state.ready) {
    showToast("Upload a PDF first — the AI answers only from your document.", "err");
    return;
  }
  if (state.processing) {
    showToast("Please wait for the current answer to finish.", "err");
    return;
  }
  const q = String(question).trim();
  if (!q) return;

  state.processing = true;
  state.lastQuestion = q;
  state.questionsAsked += 1;
  animateCount(dom.insAsked, state.questionsAsked);

  renderUserMsg(q);
  saveToHistory("user", q, null);

  // Hide the empty-state placeholder once a conversation starts
  dom.chatEmpty.classList.add("d-none");

  // Animated thinking indicator
  const thinkNode = renderThinking();
  try {
    const ctx = selectContext(q);
    const prompt = buildQaPrompt(q, ctx);
    const answer = (await engineCanDoAI())
      ? await callGemini(prompt, { label: "Asking your document…" })
      : (await brainDelay(), localQa(q, ctx));

    thinkNode.remove();
    const ctxPages = unique(ctx.pages);
    const ctxLabel = ctx.mode === "full"
      ? "the full document"
      : `pages ${ctxPages.join(", ")}`;
    const aiWrap = renderAiMsg(answer, ctxLabel);
    state.currentAnswerEl = aiWrap;
    state.lastContextInfo = ctxLabel;
    saveToHistory("ai", answer, ctxLabel);
  } catch (err) {
    const emsg = (err && err.message) || "Something went wrong. Please try again.";
    thinkNode.innerHTML = `
      <div style="color:#ff7b94; font-size:.85rem">
        <i class="bi bi-exclamation-triangle-fill me-1"></i>${escapeHtml(emsg)}
      </div>`;
    showToast(emsg, "err");
  }
  state.processing = false;
}

const escapeHtml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const unique = (arr) => [...new Set(arr)];

function initChat() {
  // Ask button
  dom.btnAsk.addEventListener("click", () => {
    const v = dom.questionInput.value.trim();
    if (!v) return;
    askAi(v.replace(/\s*\n\s*$/, ""));
    dom.questionInput.value = "";
    dom.questionInput.style.height = "auto";
  });

  // Enter to send, Shift+Enter for a new line
  dom.questionInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      dom.btnAsk.click();
    }
  });

  // Auto-grow the textarea up to ~4 lines
  dom.questionInput.addEventListener("input", () => {
    dom.questionInput.style.height = "auto";
    dom.questionInput.style.height = clamp(dom.questionInput.scrollHeight, 48, 130) + "px";
  });

  // Suggestion chips fill the input
  document.querySelectorAll(".sugg-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      dom.questionInput.value = chip.dataset.q;
      dom.questionInput.style.height = "auto";
      dom.questionInput.focus();
    });
  });

  // Suggestion toggle (desktop label above chips stays visible; button just focuses)
  dom.btnSuggestionOpen.addEventListener("click", () => {
    dom.suggestionsWrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });

  dom.btnClearChat.addEventListener("click", () => clearChat(false));
  dom.btnSavePdf.addEventListener("click", saveAsPdf);

  // Disable controls until a document is loaded
  setUiReady(false);
}

/* ==================== 15. VOICE INPUT (Web Speech API) ================== */

function initVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    dom.btnMic.title = "Voice input is not supported in this browser";
    dom.btnMic.style.opacity = "0.45";
    dom.btnMic.addEventListener("click", () =>
      showToast("Voice input isn't supported in this browser. Try Chrome or Edge.", "err"));
    return;
  }
  const rec = new SR();
  rec.lang = "en-IN";
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  let listening = false;

  dom.btnMic.addEventListener("click", () => {
    if (!state.ready) { showToast("Upload a PDF first to start asking.", "err"); return; }
    listening = !listening;
    if (listening) { rec.start(); dom.btnMic.classList.add("listening"); dom.srVoice.classList.remove("d-none"); }
    else { rec.stop(); dom.btnMic.classList.remove("listening"); dom.srVoice.classList.add("d-none"); }
  });

  rec.onresult = (e) => {
    const transcript = e.results[0][0].transcript;
    dom.questionInput.value = transcript;
    dom.questionInput.style.height = "auto";
    dom.questionInput.focus();
  };
  rec.onerror = (e) => {
    listening = false;
    dom.btnMic.classList.remove("listening");
    dom.srVoice.classList.add("d-none");
    if (e.error === "not-allowed") showToast("Microphone permission denied.", "err");
    else if (e.error === "no-speech") showToast("No speech detected. Try again.", "info");
  };
  rec.onend = () => {
    listening = false;
    dom.btnMic.classList.remove("listening");
    dom.srVoice.classList.add("d-none");
  };
}

/* ============================ 16. EXAM MODE ============================= */

function examPrompt() {
  const count = dom.examCount.value;
  const diff = dom.examDifficulty.value;
  const type = dom.examType.value;
  const ctx = getBroadContext(state.pageText, 14000);
  const typeRule = type === "MCQ"
    ? "All questions must be multiple choice with 4 options each."
    : type === "Short Answer"
      ? "All questions must be short-answer type (2-3 sentence answers)."
      : type === "Long Answer"
        ? "All questions must be long-answer type with detailed answers."
        : "Mix MCQ, short-answer and long-answer questions.";

  return {
    label: `Generating ${count} ${type.toLowerCase()} questions (${diff.toLowerCase()})…`,
    system: [
      SYSTEM_INSTRUCTION,
      `You are an expert exam setter. Create practice exam questions using ONLY the provided document.`,
    ].join("\n\n"),
    prompt: [
      `Generate a practice exam with EXACTLY ${count} questions, difficulty level: ${diff}.`,
      typeRule,
      `Use ONLY the content available in the DOCUMENT below. For every question also give a model answer.`,
      ``,
      `Return your output ONLY as a valid JSON array. No markdown, no code fences.`,
      `Each item: { "q": question text, "t": "MCQ"|"Short"|"Long", "options": ["A) ..","B) ..","C) ..","D) .."] (only for MCQ, 4 items), "a": model answer }.`,
      ``,
      `DOCUMENT:\n${ctx.text}`,
    ].join("\n"),
  };
}

async function generateExam() {
  if (!state.ready) { showToast("Upload a PDF first to generate an exam.", "err"); return; }

  dom.examResults.classList.remove("hide");
  dom.examResults.innerHTML = `<div class="exam-loading"><div class="loader-ring"></div><div>Generating your exam…</div></div>`;
  dom.examEmpty.classList.add("d-none");
  dom.examResults.scrollIntoView({ behavior: "smooth", block: "nearest" });

  try {
    const cfg = examPrompt();
    const requested = parseInt(dom.examCount.value, 10) || 10;
    let data = [];
    if (await engineCanDoAI()) {
      try {
        const raw = await callGemini(cfg.prompt, { system: cfg.system, label: cfg.label, temperature: 0.4 });
        data = parseExamJson(raw);
      } catch (_) {
        // If the AI itself fails, fall back to the local engine so the exam still appears
        data = [];
      }
    }
    if (data.length < requested) {
      // Top up (or generate entirely) with the local engine so the exam ALWAYS
      // contains exactly the requested number of questions.
      const needed = requested - data.length;
      await brainDelay();
      data = data.concat(localExam({ count: String(Math.max(needed, 1)), difficulty: dom.examDifficulty.value, type: dom.examType.value }));
    }

    if (data.length === 0) {
      throw new Error("No questions could be generated from this document. Try again.");
    }

    renderExam(data.slice(0, requested));
    showToast(`Exam ready — ${Math.min(data.length, requested)} questions generated.`, "ok");
  } catch (err) {
    dom.examResults.innerHTML = "";
    showToast(err.message, "err");
  }
}

// Best-effort JSON extraction from the model's reply
function parseExamJson(raw) {
  try {
    const m = raw.match(/\[[\s\S]*\]/);
    if (m) {
      const parsed = JSON.parse(m[0]);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (_) { /* fall through */ }
  // Fallback: crude line-based split
  const lines = raw.split(/\n/).map((l) => l.trim()).filter(Boolean);
  const qs = [];
  let cur = null;
  for (const ln of lines) {
    if (/^\s*(Q\d*[\s.)]|#)/i.test(ln) || (ln.endsWith("?") && !cur)) {
      if (cur) qs.push(cur);
      cur = { q: ln.replace(/^\s*Q\d*[\s.)]*/i, "").replace(/^#\s*/, ""), t: "Short", options: [], a: "" };
    } else if (cur && ln) {
      cur.a += ln + "\n";
    }
  }
  if (cur) qs.push(cur);
  return qs;
}

function renderExam(data) {
  dom.examResults.innerHTML = "";
  data.forEach((item, idx) => {
    const qText = item.q || `Question ${idx + 1}`;
    const qType = (item.t || "Short").toUpperCase();
    const hasOptions = Array.isArray(item.options) && item.options.length >= 2;
    const diff = dom.examDifficulty.value.toLowerCase();

    const card = document.createElement("div");
    card.className = "card glass-card exam-card";
    card.style.animationDelay = `${idx * 45}ms`;

    const isMcq = hasOptions || qType === "MCQ";
    card.innerHTML = `
      <div class="card-body">
        <div class="exam-card-head">
          <span class="exam-q-num">${idx + 1}</span>
          <span class="exam-q-text"></span>
          <span class="exam-badge type">${qType}</span>
          <span class="exam-badge diff-${diff}">${dom.examDifficulty.value}</span>
        </div>
        <div class="exam-options"></div>
        <div class="exam-answer hidden">
          <div class="exam-answer-tag"><i class="bi bi-check-circle-fill"></i> Model Answer</div>
          <span class="ans-text"></span>
        </div>
        <div class="mt-2">
          <button class="btn btn-sm btn-outline-ai exam-toggle-ans">
            <i class="bi bi-eye me-1"></i>Show Answer
          </button>
        </div>
      </div>`;
    card.querySelector(".exam-q-text").textContent = qText;

    const optWrap = card.querySelector(".exam-options");
    if (isMcq && hasOptions) {
      item.options.forEach((o) => {
        const d = document.createElement("div");
        d.className = "exam-option";
        d.textContent = o.replace(/^[A-D][)\s.]/, (m) => `<b>${m.trim()}</b>` + "");
        d.innerHTML = d.textContent;
        optWrap.appendChild(d);
      });
    } else if (isMcq && item.a && /^[A-D]/i.test(item.a)) {
      optWrap.innerHTML = `<div class="exam-option"><b>Answer:</b> ${item.a}</div>`;
    }

    const ansEl = card.querySelector(".exam-answer");
    const ansText = ansEl.querySelector(".ans-text");
    ansText.textContent = item.a || "No answer provided.";

    const btn = card.querySelector(".exam-toggle-ans");
    btn.addEventListener("click", () => {
      const show = ansEl.classList.toggle("hidden");
      btn.innerHTML = show
        ? '<i class="bi bi-eye me-1"></i>Show Answer'
        : '<i class="bi bi-eye-slash me-1"></i>Hide Answer';
    });

    dom.examResults.appendChild(card);
  });
}

/* ============================ 17. SUMMARY MODE ========================== */

const SUMMARY_TEMPLATES = {
  chapter: {
    label: "Chapter Summary",
    system: SYSTEM_INSTRUCTION,
    prompt: (ctx) =>
      `Give a clear, well-structured summary of this document as if for exam revision. ` +
      `Cover: main idea, each major topic in short paragraphs/bullets, and the conclusion. ` +
      `Keep the original meaning. Only use document content.\n\nDOCUMENT:\n${ctx.text}`,
  },
  unit: {
    label: "Unit-wise Summary",
    system: SYSTEM_INSTRUCTION,
    prompt: (ctx) =>
      `Organize this document unit-by-unit (or chapter-by-chapter). For each detected unit give: ` +
      `a one-line title, 3-5 bullet key points, and the most exam-important topic. ` +
      `Use the unit/section labels found in the document.\n\nDOCUMENT:\n${ctx.text}`,
  },
  concepts: {
    label: "Key Concepts",
    system: SYSTEM_INSTRUCTION,
    prompt: (ctx) =>
      `List the 10-15 most important key concepts in this document. For each concept: ` +
      `the term in bold, and a 1-2 sentence student-friendly explanation. ` +
      `Only use the document content.\n\nDOCUMENT:\n${ctx.text}`,
  },
  definitions: {
    label: "Important Definitions",
    system: SYSTEM_INSTRUCTION,
    prompt: (ctx) =>
      `Extract the most important definitions and terminologies from this document. ` +
      `Format as a glossary: term in bold followed by its definition. Only use document content.\n\nDOCUMENT:\n${ctx.text}`,
  },
  revision: {
    label: "Exam Revision Notes",
    system: SYSTEM_INSTRUCTION,
    prompt: (ctx) =>
      `Create concise exam revision notes from this document: quick bullet-point notes per topic, ` +
      `formulas/definitions in boxes, and a "must remember" list. Optimized for last-minute studying. ` +
      `Only use document content.\n\nDOCUMENT:\n${ctx.text}`,
  },
  mcqs: {
    label: "20 MCQs",
    system: SYSTEM_INSTRUCTION,
    prompt: (ctx) =>
      `Create exactly 20 multiple-choice questions with 4 options each, based ONLY on this document. ` +
      `Format as:\n\n1. Question?\nA) ...\nB) ...\nC) ...\nD) ...\nAnswer: A) ...\n\n` +
      `DOCUMENT:\n${ctx.text}`,
  },
};

async function generateSummary(kind) {
  if (!state.ready) { showToast("Upload a PDF first to create summaries.", "err"); return; }
  const cfg = SUMMARY_TEMPLATES[kind];
  if (!cfg) return;

  dom.summaryLabel.textContent = cfg.label;
  dom.summaryOutput.classList.remove("d-none");
  dom.summaryText.innerHTML = `<div class="exam-loading"><div class="loader-ring"></div><div>Generating ${cfg.label.toLowerCase()}…</div></div>`;
  dom.summaryOutput.scrollIntoView({ behavior: "smooth", block: "nearest" });

  try {
    const ctx = getBroadContext(state.pageText, 14000);
    const text = (await engineCanDoAI())
      ? await callGemini(cfg.prompt(ctx), { system: cfg.system, label: `Generating ${cfg.label}…`, temperature: 0.5 })
      : (await brainDelay(), localSummary(kind));
    typeInto(dom.summaryText, text).then(() => { dom.summaryText.innerHTML = formatRich(text); });
    state.summaryTextValue = text;
    showToast(`${cfg.label} ready.`, "ok");
  } catch (err) {
    dom.summaryOutput.classList.add("d-none");
    showToast(err.message, "err");
  }
}

function initSummary() {
  document.querySelectorAll(".sum-card").forEach((btn) => {
    btn.addEventListener("click", () => generateSummary(btn.dataset.sum));
  });
  dom.btnCopySummary.addEventListener("click", () => {
    const text = state.summaryTextValue || dom.summaryText.innerText;
    if (!text) return;
    copyToClipboard(text)
      .then(() => showToast("Summary copied to clipboard.", "ok"))
      .catch(() => showToast("Could not copy. Select the text and copy manually.", "err"));
  });
}

/* ================ CHAT HISTORY (optional, localStorage) ================= */

const HISTORY_KEY = "studylens_chat_history";

function saveToHistory(role, text, ctx) {
  state.chatHistory.push({ role, text, ctx, ts: Date.now() });
  saveHistoryStorage();
}

function saveHistoryStorage() {
  try {
    const slim = {
      name: state.fileName,
      msgs: state.chatHistory.slice(-12).map((m) => ({ r: m.role, t: m.text.slice(0, 3000), c: m.ctx })),
    };
    localStorage.setItem(HISTORY_KEY, JSON.stringify(slim));
  } catch (_) { /* storage may be unavailable (private mode) */ }
}

// Re-renders the persisted chat only if it belongs to the currently open file
function restoreChatHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!data || !data.msgs || data.name !== state.fileName || !data.msgs.length) return;

    data.msgs.forEach((m) => {
      if (m.r === "user") {
        const wrap = document.createElement("div");
        wrap.className = "msg msg-user";
        wrap.innerHTML = '<div class="bubble"></div><div class="msg-meta"><span>You</span></div>';
        wrap.querySelector(".bubble").textContent = m.t || "";
        dom.chatBody.appendChild(wrap);
      } else if (m.r === "ai") {
        const ctxHtml = m.c
          ? `<div class="ai-ctx"><i class="bi bi-pin-angle-fill"></i> Context selected from ${escapeHtml(m.c)}</div>`
          : "";
        const wrap = document.createElement("div");
        wrap.className = "msg msg-ai";
        wrap.innerHTML = `
          <div class="bubble"><div class="ai-inner">
            <div class="msg-ai-title"><span class="ai-mini-orb"><i class="bi bi-stars"></i></span>AI Answer</div>
            <div class="ai-content">${formatRich(m.t || "")}</div>
            ${ctxHtml}
            <div class="ai-actions">
              <button class="btn btn-sm btn-outline-ai act-copy"><i class="bi bi-clipboard me-1"></i>Copy</button>
              <button class="btn btn-sm btn-outline-ai act-regen"><i class="bi bi-arrow-repeat me-1"></i>Regenerate</button>
              <button class="btn btn-sm btn-outline-ai act-follow"><i class="bi bi-plus-circle me-1"></i>Ask Follow-up</button>
            </div>
          </div></div>`;
        dom.chatBody.appendChild(wrap);
        attachAiActions(wrap, m.t || "");
      }
    });
    dom.chatEmpty.classList.add("d-none");
    if (data.msgs.length) showToast("Previous chat restored from this session.", "info");
  } catch (_) { /* ignore storage errors */ }
}

/* ============================= 19. INIT ================================= */

document.addEventListener("DOMContentLoaded", () => {
  dom.year.textContent = new Date().getFullYear();

  initParticles();
  initRipple();
  initNavScroll();
  initHeroTilt();
  initFileUpload();
  initChat();
  initVoice();
  initSummary();

  dom.btnGenerateExam.addEventListener("click", generateExam);
  $("btnGoExam").addEventListener("click", () => document.getElementById("exam").scrollIntoView({ behavior: "smooth" }));
  $("btnGoSummary").addEventListener("click", () => document.getElementById("summary").scrollIntoView({ behavior: "smooth" }));

  // Entrance animations referenced above are pure CSS — nothing to wire here.
});