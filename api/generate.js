/* Vercel serverless function — POST /api/generate
   Proxies the request to Google Gemini.
   The API key comes ONLY from the GEMINI_API_KEY environment variable
   (set in Vercel → Settings → Environment Variables). Never from frontend. */
"use strict";

// ---- Tiny zero-dependency .env loader (local dev only) ---------------------
// Loads GEMINI_API_KEY from a local `.env` file into process.env (if present).
// `.env` is git-ignored, and a real environment variable always wins.
function loadDotEnv() {
  try {
    const fs = require("fs");
    const path = require("path");
    const text = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && !(key in process.env)) process.env[key] = value; // real env wins
    }
  } catch (_) { /* no .env file present — fine */ }
}
loadDotEnv();

// ---- API key resolution (server-side only!) --------------------------------
const resolveApiKey = () => (process.env.GEMINI_API_KEY || "").trim() || null;

// ---- The Gemini proxy call ---------------------------------------------------
async function proxyGemini(body) {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    throw Object.assign(new Error("Gemini API key is not configured. Set GEMINI_API_KEY as an environment variable."), { status: 503 });
  }
  const model = (body && body.model) || "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const payload = {
    system_instruction: { parts: [{ text: body.system || "You are StudyLens AI, an academic PDF assistant. Answer ONLY from the provided document." }] },
    contents: [{ role: "user", parts: [{ text: body.prompt || "" }] }],
    generationConfig: {
      temperature: Number.isFinite(body.temperature) ? body.temperature : 0.55,
      maxOutputTokens: Number.isFinite(body.maxTokens) ? body.maxTokens : 4096,
      topP: 0.95,
    },
  };

  const gemRes = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await gemRes.json().catch(() => null);
  return { status: gemRes.status, data };
}

// ---- Vercel handler ----------------------------------------------------------
module.exports = async function handler(req, res) {
  // Vercel Node runtime already parses JSON bodies into req.body
  const body = req.body && typeof req.body === "object" ? req.body : {};
  try {
    const { status, data } = await proxyGemini(body);
    res.status(status).json(data || { error: { code: status, message: "Empty response from Gemini." } });
  } catch (err) {
    const status = err.status || 502;
    res.status(status).json({ error: { code: status, message: err.message } });
  }
};

// Gemini answers can take a few seconds — allow up to 30s serverless runtime
module.exports.config = { maxDuration: 30 };