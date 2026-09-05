/* Vercel serverless function — POST /api/generate
   Proxies requests to Google Gemini with bullet-proof text sanitization. */
"use strict";

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
  } catch (_) {}
}
loadDotEnv();

// Strip control chars, null bytes, and other JSON-breaking characters
function sanitize(text) {
  return String(text || "")
    .replace(/[\0\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")  // control chars
    .replace(/\uFFFD/g, "")                                    // replacement char
    .replace(/\s+/g, " ")                                     // collapse whitespace
    .trim();
}

// Truncate prompt to stay within API limits (keep question visible)
function truncatePrompt(system, prompt, maxLen) {
  const header = system + "\n\n---\n\n";
  if ((header + prompt).length <= maxLen) return header + prompt;
  // Keep system + first part of doc + full question
  const qLines = prompt.split("\n");
  const question = qLines.pop() || "";
  const docPart = prompt.slice(0, maxLen - header.length - question.length - 200);
  return header + docPart + "\n\n...\n\n" + question;
}

async function geminiRequest(model, apiKey, fullPrompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

// Model fallback chain — use the current 2026 model first
const FALLBACK_MODELS = ["gemini-3.6-flash"];

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: { code: 405, message: "Method not allowed. Use POST." } });
  }

  const apiKey = (process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey) {
    return res.status(503).json({ error: { code: 503, message: "GEMINI_API_KEY not set in Vercel environment variables." } });
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  if (!body.prompt) {
    return res.status(400).json({ error: { code: 400, message: "No prompt provided." } });
  }

  // Sanitize everything
  const system = sanitize(body.system || "You are StudyLens AI, an academic PDF assistant. Answer ONLY from the provided document. Do not hallucinate. If the information is not available in the uploaded PDF, clearly say so.");
  const question = sanitize(body.prompt);
  const fullPrompt = truncatePrompt(system, question, 28000);
  const requestedModel = (body.model || "gemini-3.6-flash").trim();

  // Try models with fallback
  const modelsToTry = [requestedModel, ...FALLBACK_MODELS.filter((m) => m !== requestedModel)];
  let lastError = null;

  for (const model of modelsToTry) {
    try {
      const result = await geminiRequest(model, apiKey, fullPrompt);
      const answer = result.data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";

      if (result.status >= 200 && result.status < 300 && answer.trim()) {
        return res.status(200).json({
          candidates: [{ content: { parts: [{ text: answer.trim() }] } }],
        });
      }

      lastError = result.data?.error || { code: result.status, message: `Model ${model} returned ${result.status}` };

      // If it's a 400 or 404 (model not found), try next model
      if (result.status === 400 || result.status === 404) continue;

      // For other errors (429, 500, etc.), return immediately
      return res.status(result.status).json(result.data);

    } catch (err) {
      lastError = { code: 502, message: err.message };
      continue;
    }
  }

  // All models failed — return the last error with context
  return res.status(lastError?.code || 502).json({
    error: {
      code: lastError?.code || 502,
      message: `All models failed. Last error: ${lastError?.message || "unknown"}`,
    },
  });
};

module.exports.config = { maxDuration: 30 };
