// src/inferencer/heuristics.js --- Heuristic (pattern)-based inference functions()
function addProvenance(obj, key, confidence, source, method) {
  obj["agentnet:inferred"] ||= {};
  obj["agentnet:inferred"][key] = { confidence, source, method };
}

function detectType(text) {
  const t = text.toLowerCase();
  if (t.includes("add to cart") || t.includes("price")) return "agentnet:Product";
  if (t.includes("about us") || t.includes("team")) return "agentnet:Organization";
  if (t.includes("by ") && t.includes("published")) return "agentnet:Article";
  return "agentnet:Thing";
}

function extractPrice(text) {
  const m = text.match(/([$€£])\s?(\d+(?:[.,]\d{2})?)/);
  if (!m) return null;
  return { price: m[2], currency: m[1] };
}

function applyHeuristics({ html, text, extractedCapsule }) {
  const inferred = {};
  const type = detectType(text);

  if (!extractedCapsule["@type"]) {
    inferred["@type"] = type;
    addProvenance(inferred, "@type", 0.7, "heuristic", "type-detection");
  }

  if (type === "agentnet:Product") {
    const p = extractPrice(text);
    if (p) {
      inferred["agentnet:price"] = p.price;
      inferred["agentnet:priceCurrency"] = p.currency;
      addProvenance(inferred, "agentnet:price", 0.8, "heuristic", "price-regex");
    }
  }

  return inferred;
}

module.exports = { applyHeuristics };
