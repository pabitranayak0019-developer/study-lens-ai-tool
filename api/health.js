/* Vercel serverless function — mirrors GET /api/health from server.js.
   The frontend probes this endpoint to detect the backend proxy. */
"use strict";

module.exports = function handler(req, res) {
  res.status(200).json({ ok: true, ai: !!process.env.GEMINI_API_KEY });
};

module.exports.config = { maxDuration: 10 };