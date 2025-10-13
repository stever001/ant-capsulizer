// src/inferencer/merge.js
/**
 * mergeCapsules(base, inferred, opts)
 * -----------------------------------
 * Merges explicit metadata (base) with inferred data (heuristic/LLM).
 * Adds provenance, preserves explicit data unless opts.overwriteExplicit = true,
 * and computes an overall agentnet:confidence score.
 */

function mergeCapsules(base = {}, inferred = {}, opts = {}) {
  const out = { ...base };
  const prov = { ...(out["agentnet:inferred"] || {}) };
  const infProv = inferred["agentnet:inferred"] || {};

  // Merge regular fields
  for (const [k, v] of Object.entries(inferred)) {
    if (["@context", "agentnet:inferred"].includes(k)) continue;

    const hasExplicit = Object.prototype.hasOwnProperty.call(base, k);
    const empty =
      typeof base[k] === "undefined" ||
      base[k] === "" ||
      base[k] === null ||
      (Array.isArray(base[k]) && !base[k].length);

    if (!hasExplicit || empty || opts.overwriteExplicit) {
      out[k] = v;
    }
  }

  // Merge provenance
  out["agentnet:inferred"] = { ...prov, ...infProv };

  // Calculate an overall confidence score
  const confidences = Object.values(out["agentnet:inferred"])
    .map((p) => Number(p.confidence))
    .filter((n) => !isNaN(n));

  if (confidences.length) {
    const avg = confidences.reduce((a, b) => a + b, 0) / confidences.length;
    out["agentnet:confidence"] = Number(avg.toFixed(2));
  }

  // Always keep the most trusted context
  if (!out["@context"]) out["@context"] = "https://agentnet.ai/context";

  return out;
}

module.exports = { mergeCapsules };
