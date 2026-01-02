// ant-capsulizer/src/inferencer/index.js (Orchestrator)
// Node: CommonJS module (safe for most Node setups)

/**
 * ANT-Capsulizer Inference Engine
 * --------------------------------
 * Adds a semantic inference layer to enrich sparse or missing capsule fields.
 * - Heuristics-first; optional LLM enrichment if OPENAI_API_KEY + options.model present
 * - Produces provenance via agentnet:inferred with {confidence, source, method}
 * - Never overwrites explicit source metadata unless configured to do so
 *
 * HARDENING UPDATE:
 * - extractedCapsule may be null/undefined/non-object; we normalize it.
 * - never read extractedCapsule["@type"] unless it is a valid object.
 *
 * PRICE GUARDRAIL UPDATE:
 * - Only infer price when:
 *   (A) asserted JSON-LD says Product, OR
 *   (B) heuristics say Product AND the page has strong commerce intent signals.
 */

const DEFAULT_CONTEXT = "https://agentnet.ai/context";

// --------------------------
// Utility helpers
// --------------------------
const clamp = (n, min = 0, max = 1) => Math.max(min, Math.min(max, n));
const uniq = (arr) => Array.from(new Set(arr.filter(Boolean)));
const safeTrim = (s) => (typeof s === "string" ? s.trim() : s);

function normText(s) {
  return (s || "")
    .replace(/\s+/g, " ")
    .replace(/[^\S\r\n]+/g, " ")
    .trim();
}

function toUSDLikeCurrency(sym) {
  if (!sym) return undefined;
  const map = { "$": "USD", "€": "EUR", "£": "GBP", "¥": "JPY", "C$": "CAD", "A$": "AUD" };
  return map[sym] || undefined;
}

function addProvenance(target, key, confidence, source, method) {
  target["agentnet:inferred"] ||= {};
  target["agentnet:inferred"][key] = {
    confidence: Number(clamp(confidence).toFixed(2)),
    source,
    method,
  };
}

function jsonParseSafe(s, fallback = null) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function asObject(x) {
  return x && typeof x === "object" && !Array.isArray(x) ? x : {};
}

// --------------------------
// Simple page feature detection
// --------------------------
function indicatorScore(text, indicators) {
  const t = text.toLowerCase();
  let score = 0;
  for (const ind of indicators) {
    const re = new RegExp(`\\b${ind.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
    const matches = t.match(re);
    if (matches) score += matches.length;
  }
  return score;
}

function detectType({ text, html }) {
  const productIndicators = [
    "add to cart",
    "buy now",
    "sku",
    "specifications",
    "in stock",
    "price",
    "was",
    "sale",
    "checkout",
  ];
  const orgIndicators = [
    "about us",
    "our team",
    "contact us",
    "headquarters",
    "mission",
    "careers",
    "phone",
    "address",
    "hours",
  ];
  const articleIndicators = ["by ", "author", "published", "updated", "read more", "minutes read", "newsletter"];

  const prodScore = indicatorScore(text, productIndicators);
  const orgScore = indicatorScore(text, orgIndicators);
  const artScore = indicatorScore(text, articleIndicators);

  const max = Math.max(prodScore, orgScore, artScore);
  let type = "agentnet:Thing";
  if (max === prodScore && max > 0) type = "agentnet:Product";
  if (max === orgScore && max > prodScore) type = "agentnet:Organization";
  if (max === artScore && max > prodScore && max > orgScore) type = "agentnet:Article";

  const confidence = clamp(max / Math.max(6, prodScore + orgScore + artScore || 1));
  return { type, confidence, scores: { prodScore, orgScore, artScore } };
}

// --------------------------
// Commerce-intent gate (for price inference)
// --------------------------
function hasStrongCommerceIntent(text) {
  // Require at least 2 distinct strong commerce tokens.
  const strong = [
    "add to cart",
    "checkout",
    "buy now",
    "shop now",
    "order now",
    "shipping",
    "returns",
    "size",
    "color",
    "quantity",
    "in stock",
    "out of stock",
    "variants",
    "select size",
    "select color",
  ];

  const t = text.toLowerCase();
  let hits = 0;
  for (const token of strong) {
    if (t.includes(token)) hits += 1;
    if (hits >= 2) return true;
  }
  return false;
}

// --------------------------
// Field extractors (heuristics)
// --------------------------
function extractPrice(text) {
  /**
   * Hardened to reduce false positives:
   * - Requires either a currency symbol OR a currency code.
   */
  const priceRe =
    /(?:USD|EUR|GBP|JPY|CAD|AUD)?\s*([$€£¥]|C\$|A\$)\s?(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?)\b|(?:\b(USD|EUR|GBP|JPY|CAD|AUD)\b)\s?(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?)\b/i;

  const m = text.match(priceRe);
  if (!m) return null;

  const sym = m[1] || null;
  const amountRaw1 = m[2] || null;
  const code = m[3] || null;
  const amountRaw2 = m[4] || null;

  const amountRaw = amountRaw1 || amountRaw2;
  if (!amountRaw) return null;

  const amount = Number(amountRaw.replace(/[.,](?=\d{3}\b)/g, "").replace(",", "."));
  if (!Number.isFinite(amount)) return null;

  const priceCurrency = code || toUSDLikeCurrency(sym);
  if (!priceCurrency) return null;

  return { price: amount.toFixed(2), priceCurrency };
}

function extractSKU(text) {
  const re = /\b(?:SKU|Part\s*(?:No\.?|Number))[:#]?\s*([A-Z0-9\-_/]{3,})\b/i;
  const m = text.match(re);
  return m ? m[1] : null;
}

function extractBrand(text, html) {
  const brandLine = text.match(/\bBrand[:]\s*([A-Za-z0-9&\-\s]{2,60})\b/);
  if (brandLine) return safeTrim(brandLine[1]);

  const metaBrand = html.match(/<meta[^>]+itemprop=["']?brand["']?[^>]*content=["']([^"']+)["']/i);
  if (metaBrand) return safeTrim(metaBrand[1]);

  const titleBrand = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleBrand && /\|/.test(titleBrand[1])) {
    const parts = titleBrand[1].split("|").map((s) => s.trim());
    if (parts[1]) return parts[1];
  }
  return null;
}

function extractContacts(text) {
  const emails = uniq(
    (text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map((e) => e.toLowerCase())
  );
  const phones = uniq(text.match(/(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}/g) || []);
  return { emails, phones };
}

function extractAddress(text) {
  const addrRe = /\b(\d{1,6}\s+[A-Za-z0-9.\- ]+)\s*,?\s*([A-Za-z.\- ]+),\s*([A-Z]{2})\s*(\d{5}(?:-\d{4})?)\b/;
  const m = text.match(addrRe);
  if (!m) return null;
  const [, street, city, region, postalCode] = m;
  return { street: safeTrim(street), addressLocality: safeTrim(city), addressRegion: region, postalCode };
}

function extractPublishDates(text, html) {
  const pubLine = text.match(
    /\b(Published|Posted|Updated)\s*[:\-]?\s*(\w{3,}\s+\d{1,2},\s+\d{4}|\d{4}\-\d{2}\-\d{2})\b/i
  );
  const metaPub = html.match(
    /<meta[^>]+(?:property|name)=["'](?:article:published_time|pubdate|datePublished)["'][^>]*content=["']([^"']+)["']/i
  );
  const metaUpd = html.match(
    /<meta[^>]+(?:property|name)=["'](?:article:modified_time|updated|dateModified)["'][^>]*content=["']([^"']+)["']/i
  );
  return {
    datePublished: pubLine ? pubLine[2] : metaPub ? metaPub[1] : undefined,
    dateModified: metaUpd ? metaUpd[1] : undefined,
  };
}

// --------------------------
// Optional LLM enrichment
// --------------------------
async function callLLMEnrichment({ url, html, text, seedCapsule, model, temperature = 0, maxTokens = 800 }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !model) return null;

  if (typeof fetch !== "function") {
    throw new Error("Global fetch() not available. Use Node 18+ or polyfill fetch.");
  }

  const prompt = [
    "You are transforming a web page into a JSON-LD AgentNet capsule.",
    "Rules:",
    "- Output ONLY valid JSON (no preamble or trailing comments).",
    "- Use the provided capsule fields if present; fill missing fields conservatively.",
    "- Keep @context and @type consistent with AgentNet style.",
    "- Include only fields that you can infer with reasonable confidence.",
    "- Do not invent phone numbers, addresses, or prices unless visible in the text.",
    "",
    `URL: ${url}`,
    "Existing Capsule (may be partial):",
    JSON.stringify(seedCapsule, null, 2),
    "",
    "HTML (truncated if long) and Visible Text have been provided separately.",
    "Return JSON only.",
  ].join("\n");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature,
      max_tokens: maxTokens,
      messages: [
        {
          role: "system",
          content: "You convert webpages to AgentNet JSON-LD capsules with conservative, well-structured outputs.",
        },
        { role: "user", content: prompt },
        { role: "user", content: `Visible Text (first 6000 chars):\n${text.slice(0, 6000)}` },
        { role: "user", content: `HTML (first 6000 chars):\n${html.slice(0, 6000)}` },
      ],
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const err = await response.text().catch(() => "");
    throw new Error(`LLM enrichment failed: ${response.status} ${err}`);
  }

  const json = await response.json();
  const raw = json?.choices?.[0]?.message?.content;
  return jsonParseSafe(raw, null);
}

// --------------------------
// Merge policy
// --------------------------
function mergeCapsules(original = {}, inferred = {}, { overwriteExplicit = false } = {}) {
  const orig = asObject(original);
  const inf = asObject(inferred);

  const out = JSON.parse(JSON.stringify(orig));
  const prov = out["agentnet:inferred"] || {};

  out["@context"] = out["@context"] || inf["@context"] || DEFAULT_CONTEXT;
  out["@type"] = out["@type"] || inf["@type"] || "agentnet:Thing";

  for (const [k, v] of Object.entries(inf)) {
    if (k === "@context" || k === "@type" || k === "agentnet:inferred") continue;

    const hasExplicit = Object.prototype.hasOwnProperty.call(orig, k);
    const isEmptyExplicit =
      typeof orig[k] === "undefined" || (typeof orig[k] === "string" && !orig[k].trim());

    if (!hasExplicit || isEmptyExplicit || overwriteExplicit) {
      out[k] = v;
    }
  }

  if (inf["agentnet:inferred"]) {
    out["agentnet:inferred"] = { ...prov, ...inf["agentnet:inferred"] };
  } else if (Object.keys(prov).length) {
    out["agentnet:inferred"] = prov;
  }

  return out;
}

// --------------------------
// Main inference function
// --------------------------
async function inferCapsule({ url, html = "", text = "", extractedCapsule = {}, options = {} }) {
  const extracted = asObject(extractedCapsule);

  const opts = {
    enableLLM: true,
    overwriteExplicit: false,
    model: undefined,
    ...options,
  };

  const t = normText(text);
  const typeGuess = detectType({ text: t, html });

  const inferred = {
    "@context": DEFAULT_CONTEXT,
    "@type": extracted["@type"] || typeGuess.type || "agentnet:Thing",
  };

  if (!extracted["@type"] && typeGuess.type !== "agentnet:Thing") {
    addProvenance(inferred, "@type", clamp(0.65 + 0.3 * typeGuess.confidence), "heuristic", "type-detection");
  }

  // --------------------------
  // PRICE GUARDRAIL:
  // Only infer price if:
  //  A) asserted type looks like a Product, OR
  //  B) we guessed Product AND page shows strong commerce intent.
  // --------------------------
  const assertedType = typeof extracted["@type"] === "string" ? extracted["@type"] : "";
  const assertedLooksProduct = /Product/i.test(assertedType);
  const guessedProduct = inferred["@type"] === "agentnet:Product";

  const allowPriceInference = assertedLooksProduct || (guessedProduct && hasStrongCommerceIntent(t));

  // Product-like fields
  if (guessedProduct || /product/i.test(t)) {
    if (allowPriceInference) {
      const p = extractPrice(t);
      if (p?.price) {
        inferred["agentnet:price"] = p.price;
        addProvenance(inferred, "agentnet:price", 0.8, "heuristic", "price-regex");
      }
      if (p?.priceCurrency) {
        inferred["agentnet:priceCurrency"] = p.priceCurrency;
        addProvenance(inferred, "agentnet:priceCurrency", 0.7, "heuristic", "currency-map");
      }
    }

    const sku = extractSKU(t);
    if (sku) {
      inferred["agentnet:sku"] = sku;
      addProvenance(inferred, "agentnet:sku", 0.7, "heuristic", "sku-regex");
    }
    const brand = extractBrand(t, html);
    if (brand) {
      inferred["agentnet:brand"] = brand;
      addProvenance(inferred, "agentnet:brand", 0.75, "heuristic", "brand-heuristic");
    }
  }

  // Organization-like fields
  if (inferred["@type"] === "agentnet:Organization") {
    const { emails, phones } = extractContacts(t);
    if (emails.length) {
      inferred["agentnet:email"] = emails[0];
      addProvenance(inferred, "agentnet:email", 0.85, "heuristic", "email-regex");
    }
    if (phones.length) {
      inferred["agentnet:telephone"] = phones[0];
      addProvenance(inferred, "agentnet:telephone", 0.8, "heuristic", "phone-regex");
    }
    const addr = extractAddress(t);
    if (addr) {
      inferred["agentnet:address"] = addr;
      addProvenance(inferred, "agentnet:address", 0.7, "heuristic", "address-regex");
    }
  }

  // Article-like fields
  if (inferred["@type"] === "agentnet:Article") {
    const dates = extractPublishDates(t, html);
    if (dates.datePublished) {
      inferred["agentnet:datePublished"] = dates.datePublished;
      addProvenance(inferred, "agentnet:datePublished", 0.8, "heuristic", "date-meta");
    }
    if (dates.dateModified) {
      inferred["agentnet:dateModified"] = dates.dateModified;
      addProvenance(inferred, "agentnet:dateModified", 0.7, "heuristic", "date-meta");
    }
    const byline = t.match(/\bby\s+([A-Z][A-Za-z.\- ]{1,60})\b/);
    if (byline) {
      inferred["agentnet:author"] = safeTrim(byline[1]);
      addProvenance(inferred, "agentnet:author", 0.65, "heuristic", "byline-regex");
    }
  }

  // Generic name/description
  if (!extracted["agentnet:name"]) {
    const title = (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1];
    if (title) {
      inferred["agentnet:name"] = safeTrim(title.replace(/\s*\|\s*[^|]+$/, ""));
      addProvenance(inferred, "agentnet:name", 0.6, "heuristic", "title-fallback");
    }
  }
  if (!extracted["agentnet:description"]) {
    const metaDesc = (html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["']/i) || [])[1];
    if (metaDesc) {
      inferred["agentnet:description"] = safeTrim(metaDesc);
      addProvenance(inferred, "agentnet:description", 0.65, "heuristic", "meta-description");
    }
  }

  // Optional LLM enrichment phase (conservative)
  if (opts.enableLLM && opts.model && process.env.OPENAI_API_KEY) {
    try {
      const seed = mergeCapsules(extracted, inferred);
      const llmCapsule = await callLLMEnrichment({
        url,
        html,
        text: t,
        seedCapsule: seed,
        model: opts.model,
      });

      if (llmCapsule && typeof llmCapsule === "object") {
        const llmAugmented = {};
        for (const [k, v] of Object.entries(llmCapsule)) {
          if (k === "@context" || k === "@type" || k === "agentnet:inferred") continue;
          if (typeof inferred[k] === "undefined" && typeof extracted[k] === "undefined") {
            llmAugmented[k] = v;
          }
        }
        for (const k of Object.keys(llmAugmented)) {
          addProvenance(inferred, k, 0.55, "llm", "openai-summary");
          inferred[k] = llmAugmented[k];
        }
      }
    } catch (e) {
      // Non-fatal; continue with heuristics
    }
  }

  const capsule = mergeCapsules(extracted, inferred, { overwriteExplicit: opts.overwriteExplicit });

  if (!capsule["@context"]) capsule["@context"] = DEFAULT_CONTEXT;

  return { capsule, inferred, typeGuess };
}

// --------------------------
// Public API
// --------------------------
module.exports = {
  inferCapsule,
  mergeCapsules,
};
