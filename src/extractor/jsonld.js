// src/extractor/jsonld.js
// Extract JSON-LD blocks from HTML with basic provenance.
//
// Usage:
//   const { extractJsonLd } = require("./extractor/jsonld");
//   const res = extractJsonLd(html, url, { capturedAt: new Date().toISOString() });
//   if (res.found) { ... }

const cheerio = require("cheerio");
const crypto = require("crypto");

/**
 * Hash helper (sha256 hex)
 */
function sha256Hex(input) {
  return crypto.createHash("sha256").update(input || "", "utf8").digest("hex");
}

/**
 * Normalize JSON-LD blocks into a flat list of objects.
 * Handles:
 * - single object
 * - array of objects
 * - @graph arrays (keeps wrapper + graph objects)
 */
function flattenJsonLd(parsed) {
  const out = [];
  if (!parsed) return out;

  if (Array.isArray(parsed)) {
    for (const item of parsed) out.push(...flattenJsonLd(item));
    return out;
  }

  if (typeof parsed === "object") {
    // Keep the object as-is
    out.push(parsed);

    // Also surface @graph entries if present
    if (Array.isArray(parsed["@graph"])) {
      for (const g of parsed["@graph"]) {
        if (g && typeof g === "object") out.push(g);
      }
    }
  }

  return out;
}

/**
 * Attempt to parse JSON-LD safely.
 * Some sites include multiple top-level JSON objects separated by whitespace/newlines,
 * which is invalid JSON. We keep this conservative: parse once; on failure return null.
 */
function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Extract JSON-LD blocks from HTML
 *
 * @param {string} html
 * @param {string} url
 * @param {object} [opts]
 * @param {string} [opts.capturedAt] ISO timestamp; default now
 * @param {boolean} [opts.flattenGraph] default true
 * @returns {{
 *   found: boolean,
 *   blocks: Array<{ json: any, provenance: object }>,
 *   rawCount: number,
 *   parseErrors: Array<{ index: number, message: string }>,
 * }}
 */
function extractJsonLd(html, url, opts = {}) {
  const capturedAt = opts.capturedAt || new Date().toISOString();
  const flattenGraph = opts.flattenGraph !== false;

  const $ = cheerio.load(html || "");
  const parseErrors = [];
  const blocks = [];

  const scripts = $("script[type='application/ld+json']").toArray();
  const rawCount = scripts.length;

  scripts.forEach((el, i) => {
    const raw = ($(el).html() || "").trim();
    if (!raw) return;

    const parsed = safeJsonParse(raw);
    if (!parsed) {
      parseErrors.push({
        index: i,
        message: "Invalid JSON (JSON.parse failed)",
      });
      return;
    }

    const normalized = flattenGraph ? flattenJsonLd(parsed) : [parsed];
    const snippetHash = sha256Hex(raw);

    for (const obj of normalized) {
      blocks.push({
        json: obj,
        provenance: {
          sourceUrl: url,
          capturedAt,
          evidenceType: "jsonld-script",
          scriptIndex: i,
          selector: "script[type='application/ld+json']",
          snippetHash: `sha256:${snippetHash}`,
        },
      });
    }
  });

  return {
    found: blocks.length > 0,
    blocks,
    rawCount,
    parseErrors,
  };
}

module.exports = { extractJsonLd };
