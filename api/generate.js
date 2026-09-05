/* Vercel serverless function — POST /api/generate
   Proxies requests to Google Gemini.
   Key comes ONLY from GEMINI_API_KEY env var (Vercel dashboard). */
"use strict";

// ---- Tiny .env loader (local dev convenience) ------------------------------
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
      if (key && !(key in process.env)) process.env[key] = value;
    }
  } catch (_) { /* no .env — fine */ }
}
loadDotEnv();

// ---- The actual Gemini call (uses only "contents", no system_instruction) ---
async function callGemini(model, apiKey, fullPrompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
    generationConfig: {
      temperature: 0.55,
      maxOutputTokens: 4096,
      topP: 0.95,
    },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

// ---- Vercel handler ----------------------------------------------------------
module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: { code: 405, message: "Method not allowed" } });
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const apiKey = (process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey) {
    return res.status(503).json({ error: { code: 503, message: "GEMINI_API_KEY not set in environment variables." } });
  }

  // Build the full prompt: system instructions embedded in user message
  // (avoids model-specific system_instruction compatibility issues)
  const system = body.system || "You are StudyLens AI, an academic PDF assistant. Answer ONLY from the provided document. Do not hallucinate. If the answer is not in the document, say so clearly.";
  const fullPrompt = `${system}\n\n---\n\n${body.prompt || ""}`;

  const model = body.model || "gemini-1.5-flash";

  try {
    // Try the requested model first
    let result = await callGemini(model, apiKey, fullPrompt);

    // If 400 error, fallback to gemini-1.5-flash (more compatible)
    if (result.status === 400 && model !== "gemini-1.5-flash") {
      result = await callGemini("gemini-1.5-flash", apiKey, fullPrompt);
    }

    // Extract answer text
    let answer = "";
    if (result.status >= 200 && result.status < 300) {
      const parts = result.data?.candidates?.[0]?.content?.parts;
      answer = Array.isArray(parts) ? parts.map((p) => p.text || "").join("") : "";
    }

    if (result.status >= 200 && result.status < 300 && answer.trim()) {
      return res.status(200).json({
        candidates: [{ content: { parts: [{ text: answer.trim() }] } }],
      });
    }

    // Forward the Gemini error as-is
    return res.status(result.status).json(
      result.data || { error: { code: result.status, message: "Empty or failed response from Gemini." } }
    );

  } catch (err) {
    return res.status(502).json({ error: { code: 502, message: err.message } });
  }
};

module.exports.config = { maxDuration: 30 };
