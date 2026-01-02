// src/worker.js
require("dotenv").config();

const { Worker } = require("bullmq");
const { chromium } = require("playwright");
const fs = require("fs-extra");
const crypto = require("crypto");
const path = require("path");

const Ajv = require("ajv");
const addFormats = require("ajv-formats");

const { checkProtocol } = require("./utils/checkProtocol");
const { connection, queueName } = require("./queue");
const { upsertNode, insertCapsule, pool } = require("./db");
const { fp } = require("./normalize");
const { inferCapsule } = require("./inferencer");
const { classifyNodeType } = require("./utils/classifyNodeType");

// ✅ JSON-LD extractor (must export { extractJsonLd })
const { extractJsonLd } = require("./extractor/jsonld");

// ------------------------------
// Config
// ------------------------------
const CONCURRENCY = parseInt(process.env.CONCURRENCY || 4, 10);
const UA = process.env.USER_AGENT || "AgentNet-Capsulizer/1.0 (+https://agentnet.ai)";
const PER_HOST_DELAY = parseInt(process.env.PER_HOST_DELAY_MS || 500, 10);
const MAX_DEPTH = parseInt(process.env.MAX_DEPTH || 10, 10);
const MAX_PAGES_PER_SITE = parseInt(process.env.MAX_PAGES_PER_SITE || 10, 10);

const LOG_PATH = "./crawler.log";
const SNAPSHOT_DIR = "./snapshots";
const RUNS_DIR = "./runs";

// Optional flags (safe defaults)
const ENABLE_LLM = (process.env.ENABLE_LLM ?? "true").toLowerCase() === "true";
const WRITE_SNAPSHOTS = (process.env.WRITE_SNAPSHOTS ?? "true").toLowerCase() === "true";

// Demo-friendly flag: default to single-page mode
const SINGLE_PAGE = (process.env.SINGLE_PAGE ?? "true").toLowerCase() === "true";

// Deterministic mode (reproducible fingerprints)
const CG_DETERMINISTIC = (process.env.CG_DETERMINISTIC ?? "false").toLowerCase() === "true";

// CG version marker
const CG_VERSION = process.env.CG_VERSION || "cg-0.5-determinism-ajv-output";

// Envelope schema validation gate
const VALIDATE_ENVELOPE = (process.env.VALIDATE_ENVELOPE ?? "true").toLowerCase() === "true";

// Determinism: disable LLM
const EFFECTIVE_ENABLE_LLM = CG_DETERMINISTIC ? false : ENABLE_LLM;

// ------------------------------
// AJV schema validator (SYNC init - CommonJS safe)
// ------------------------------
let validateEnvelope = null;
let envelopeSchemaLoaded = false;

if (VALIDATE_ENVELOPE) {
  try {
    const schemaPath = path.resolve(__dirname, "../schemas/cg-envelope.schema.json");
    const exists = fs.existsSync(schemaPath);

    if (!exists) {
      console.warn(
        `⚠️  VALIDATE_ENVELOPE=true but schema file not found at ${schemaPath}. Validation disabled.`
      );
    } else {
      const raw = fs.readFileSync(schemaPath, "utf8");
      if (!raw || !raw.trim()) {
        console.warn(
          `⚠️  VALIDATE_ENVELOPE=true but schema file is empty at ${schemaPath}. Validation disabled.`
        );
      } else {
        const schemaJson = JSON.parse(raw);

        const ajv = new Ajv({
          allErrors: true,
          strict: false,
          allowUnionTypes: true,
          // If you want formats to be *enforced*, keep addFormats(ajv) + install ajv-formats.
          // If not installed, we catch below.
        });

        try {
          addFormats(ajv);
        } catch (fmtErr) {
          // Still compile fine; formats will just be ignored.
          console.warn(`⚠️  ajv-formats not available (formats ignored): ${fmtErr.message}`);
        }

        validateEnvelope = ajv.compile(schemaJson);
        envelopeSchemaLoaded = true;
        console.log(`✅ Envelope schema loaded: ${schemaPath}`);
      }
    }
  } catch (e) {
    console.warn(`⚠️  Failed to initialize AJV validator. Validation disabled. ${e.message}`);
    validateEnvelope = null;
  }
}

// ------------------------------
// Polite throttle per host
// ------------------------------
const lastHit = new Map();
async function hostThrottle(url) {
  const host = new URL(url).host;
  const now = Date.now();
  const last = lastHit.get(host) || 0;
  const wait = Math.max(0, PER_HOST_DELAY - (now - last));
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastHit.set(host, Date.now());
}

// ------------------------------
// Structured logging
// ------------------------------
async function appendLog(entry) {
  const line = `[${new Date().toISOString()}] ${JSON.stringify(entry)}\n`;
  await fs.appendFile(LOG_PATH, line);
}

// ------------------------------
// URL normalization
// ------------------------------
function normalizeUrl(raw) {
  const u = new URL(raw);
  u.hash = "";

  const dropPrefixes = ["utm_", "gclid", "fbclid", "msclkid", "a_ajs_"];
  for (const key of [...u.searchParams.keys()]) {
    if (dropPrefixes.some((p) => key === p || key.startsWith(p)) || key.startsWith("a_ajs_")) {
      u.searchParams.delete(key);
    }
  }
  return u.toString();
}

// ------------------------------
// Snapshot naming (avoid ENAMETOOLONG)
// ------------------------------
function snapshotName(url) {
  const u = new URL(url);
  const base = `${u.host}${u.pathname}`.replace(/[^a-zA-Z0-9/_-]/g, "_");
  const hash = crypto.createHash("sha256").update(url).digest("hex").slice(0, 16);
  const safeBase = base.replace(/\//g, "_").slice(0, 120);
  return `${safeBase}__${hash}.html`;
}

// ------------------------------
// Run ID
// ------------------------------
function makeRunId() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const nonce = crypto.randomBytes(16).toString("hex").slice(0, 12);
  return `run_${ts}__${nonce}`;
}

// ------------------------------
// Deterministic helpers
// ------------------------------
function stableSortJsonLd(value) {
  if (Array.isArray(value)) {
    return value
      .map(stableSortJsonLd)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((acc, k) => {
        acc[k] = stableSortJsonLd(value[k]);
        return acc;
      }, {});
  }
  return value;
}

function selectPrimaryIndexDeterministic(blocks) {
  // blocks: [{ json, provenance }, ...]
  if (!Array.isArray(blocks) || blocks.length === 0) return { index: null, type: null };

  const scored = blocks.map((b, i) => ({
    i,
    s: JSON.stringify(b?.json ?? {}),
    t: b?.json ? b.json["@type"] : null,
  }));

  scored.sort((a, b) => a.s.localeCompare(b.s));
  const pick = scored[0];

  const type = Array.isArray(pick.t) ? pick.t[0] : pick.t;
  const cleanedType = typeof type === "string" ? type.replace(/^schema:/, "") : type;

  return { index: pick.i, type: cleanedType || null };
}

function stableFingerprintView(envelope) {
  const e = JSON.parse(JSON.stringify(envelope || {}));

  // Volatile envelope fields
  delete e["agentnet:captureDate"];
  delete e["agentnet:cgRunId"];
  delete e["agentnet:cgManifestPath"]; // varies per run

  // Volatile provenance timestamps
  const prov = e?.["agentnet:asserted"]?.provenance;
  if (prov && typeof prov === "object") {
    delete prov.capturedAt;
  }

  // Canonicalize asserted array/object
  const asserted = e?.["agentnet:asserted"]?.json;
  if (Array.isArray(asserted)) {
    const keyed = asserted.map((obj) => stableSortJsonLd(obj));
    keyed.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    e["agentnet:asserted"].json = keyed;
  } else if (asserted && typeof asserted === "object") {
    e["agentnet:asserted"].json = stableSortJsonLd(asserted);
  }

  // Canonicalize content (helps reduce fingerprint jitter)
  if (e["agentnet:content"] && typeof e["agentnet:content"] === "object") {
    e["agentnet:content"] = stableSortJsonLd(e["agentnet:content"]);
  }

  return e;
}

// ------------------------------
// Required tiny price guardrail
// ------------------------------
function guardTinyPrice(content, report) {
  const p = content?.["agentnet:price"];
  if (p == null) return;

  const n = typeof p === "string" ? Number(p) : Number(p);
  if (!Number.isFinite(n)) return;

  if (n > 0 && n < 5) {
    delete content["agentnet:price"];
    report.priceGuardrail = {
      dropped: true,
      reason: "tiny_price",
      threshold: 5,
      observed: n,
    };
  }
}

// ------------------------------
// Build envelope
// ------------------------------
function buildEnvelope({
  url,
  harvestedAt,
  cgRunId,
  manifestPath,
  assertedJsonLd, // array|object|null
  assertedProvenance,
  jsonldRawScriptCount,
  jsonldParseErrors,
  enrichedContent,
  inferredMeta,
  structuredMarkup,
  assertedPrimaryIndex,
  assertedPrimaryType,
}) {
  return {
    "@context": "https://agentnet.ai/context",
    "@type": "agentnet:Capsule",

    "agentnet:cgVersion": CG_VERSION,
    "agentnet:cgRunId": cgRunId,
    ...(manifestPath ? { "agentnet:cgManifestPath": manifestPath } : {}),

    "agentnet:source": url,
    "agentnet:captureDate": harvestedAt,

    "agentnet:asserted": assertedJsonLd
      ? { json: assertedJsonLd, provenance: assertedProvenance || null }
      : null,

    "agentnet:content": enrichedContent || {},

    ...(inferredMeta && Object.keys(inferredMeta).length ? { "agentnet:inferred": inferredMeta } : {}),

    "agentnet:report": {
      structuredMarkup,
      jsonldRawScriptCount: jsonldRawScriptCount || 0,
      jsonldParseErrors: jsonldParseErrors || 0,
      singlePageMode: SINGLE_PAGE,

      assertedPrimaryIndex: assertedPrimaryIndex ?? null,
      assertedPrimaryType: assertedPrimaryType ?? null,

      deterministic: CG_DETERMINISTIC,
      llmEnabled: EFFECTIVE_ENABLE_LLM,

      // if validation fails, we add schemaErrors here
    },
  };
}

// ------------------------------
// Crawl
// ------------------------------
async function crawlSite({ baseUrl, ctx, nodeId, cgRunId, manifestPath }) {
  const origin = new URL(baseUrl).origin;

  const visited = new Set();
  const q = [{ url: normalizeUrl(baseUrl), depth: 0 }];

  const siteStats = {
    site: origin,
    pages: 0,
    capsules: 0,
    inferred: 0,
    errors: 0,
    schemaErrors: 0,
    rejected: 0,
    inserted: 0,
    start: new Date().toISOString(),
    singlePageMode: SINGLE_PAGE,
    deterministic: CG_DETERMINISTIC,
  };

  const allCapsulesForClassifier = [];

  if (WRITE_SNAPSHOTS) await fs.ensureDir(SNAPSHOT_DIR);

  const pageLimit = SINGLE_PAGE ? 1 : MAX_PAGES_PER_SITE;

  while (q.length && visited.size < pageLimit) {
    const item = q.shift();
    if (!item) break;

    const url = normalizeUrl(item.url);
    const depth = item.depth;

    if (visited.has(url) || depth > MAX_DEPTH) continue;
    visited.add(url);

    try {
      checkProtocol(url);
    } catch (e) {
      console.warn(`⚠️ Protocol check warning for ${url}: ${e.message}`);
    }

    await hostThrottle(url);

    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(800);

      const harvestedAt = new Date().toISOString();
      const html = await page.content();
      const text = await page.evaluate(() => document.body?.innerText || "");

      // Extract asserted JSON-LD
      const jsonld = extractJsonLd(html, url, { capturedAt: harvestedAt });
      const rawCount = Number(jsonld?.rawCount || 0);
      const blocksRaw = Array.isArray(jsonld?.blocks) ? jsonld.blocks : [];
      const parseErrors = Array.isArray(jsonld?.parseErrors) ? jsonld.parseErrors : [];
      const found = Boolean(jsonld?.found);

      if (rawCount > 0 && !found) {
        console.warn(`⚠️ JSON-LD scripts present but unparsable on ${url}:`, parseErrors);
      }

      // Build single asserted-array
      let assertedJson = null;
      let assertedProvenance = null;
      let assertedPrimaryIndex = null;
      let assertedPrimaryType = null;

      if (found && blocksRaw.length > 0) {
        const blocks = blocksRaw.map((b) => {
          if (b && typeof b === "object" && "json" in b) return b;
          return { json: b, provenance: { evidenceType: "jsonld-script", url, capturedAt: harvestedAt } };
        });

        const cleanedBlocks = blocks.map((b) => ({
          json: CG_DETERMINISTIC ? stableSortJsonLd(b.json) : b.json,
          provenance: b.provenance || null,
        }));

        assertedJson = cleanedBlocks.map((b) => b.json);
        assertedProvenance = {
          evidenceType: "jsonld-script",
          url,
          capturedAt: harvestedAt,
        };

        const primary = selectPrimaryIndexDeterministic(cleanedBlocks);
        assertedPrimaryIndex = primary.index;
        assertedPrimaryType = primary.type;
      }

      const primaryAssertedObject =
        Array.isArray(assertedJson) && assertedJson.length > 0
          ? assertedJson[assertedPrimaryIndex ?? 0] || assertedJson[0]
          : {};

      // Inference
      let enrichedContent;
      let inferredMeta;

      try {
        const out = await inferCapsule({
          url,
          html,
          text,
          extractedCapsule:
            primaryAssertedObject && typeof primaryAssertedObject === "object" ? primaryAssertedObject : {},
          options: { enableLLM: EFFECTIVE_ENABLE_LLM },
        });
        enrichedContent = out.capsule;
        inferredMeta = out.inferred;
      } catch (infErr) {
        console.warn(`⚠️ Inference failed on ${url}: ${infErr.message}`);
        siteStats.errors += 1;

        enrichedContent = {
          "@context": "https://agentnet.ai/context",
          "@type": "agentnet:Thing",
          "agentnet:name": (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || "Unknown",
          "agentnet:inferred": {
            "agentnet:name": { confidence: 0.4, source: "heuristic", method: "title-fallback" },
          },
        };
        inferredMeta = enrichedContent["agentnet:inferred"] || {};
      }

      // Envelope
      const envelope = buildEnvelope({
        url,
        harvestedAt,
        cgRunId,
        manifestPath,
        assertedJsonLd: assertedJson,
        assertedProvenance,
        jsonldRawScriptCount: rawCount,
        jsonldParseErrors: parseErrors.length,
        enrichedContent,
        inferredMeta,
        structuredMarkup: found ? "jsonld" : "none",
        assertedPrimaryIndex,
        assertedPrimaryType,
      });

      // price guardrail
      guardTinyPrice(envelope["agentnet:content"], envelope["agentnet:report"]);

      // Deterministic fingerprint
      const fingerprint = fp(CG_DETERMINISTIC ? stableFingerprintView(envelope) : envelope);

      // Schema validation gate
      let status = "ok";
      if (validateEnvelope) {
        const valid = validateEnvelope(envelope);
        if (!valid) {
          status = "needs_review";
          envelope["agentnet:report"].schemaErrors = validateEnvelope.errors || [];
          siteStats.schemaErrors += (validateEnvelope.errors || []).length;
        }
      }

      await insertCapsule(nodeId, envelope, fingerprint, harvestedAt, status);

      siteStats.capsules += 1;
      siteStats.pages += 1;

      if (status === "ok") siteStats.inserted += 1;
      else siteStats.rejected += 1;

      if (inferredMeta && Object.keys(inferredMeta).length) siteStats.inferred += 1;

      allCapsulesForClassifier.push({ "agentnet:content": envelope["agentnet:content"] });

      if (WRITE_SNAPSHOTS) {
        const name = snapshotName(url);
        await fs.writeFile(`${SNAPSHOT_DIR}/${name}`, html);
      }

      console.log(
        `✅ 1 capsule processed for ${url} (JSON-LD scripts: ${rawCount}, parsed objects: ${blocksRaw.length})`
      );

      // Discover same-origin links (disabled in SINGLE_PAGE mode)
      if (!SINGLE_PAGE && depth < MAX_DEPTH) {
        const links = await page.$$eval("a[href]", (as) => as.map((a) => a.href).filter(Boolean));
        for (const link of links) {
          let normLink;
          try {
            normLink = normalizeUrl(link);
          } catch {
            continue;
          }
          try {
            if (new URL(normLink).origin !== origin) continue;
          } catch {
            continue;
          }
          if (!visited.has(normLink)) q.push({ url: normLink, depth: depth + 1 });
        }
      }
    } catch (e) {
      console.error(`❌ Error crawling ${url}: ${e.message}`);
      siteStats.errors += 1;
    } finally {
      await page.close();
    }
  }

  // Classify node type
  try {
    const category = classifyNodeType(allCapsulesForClassifier);
    await pool.query(`UPDATE nodes SET node_category=? WHERE id=?`, [category, nodeId]);
    console.log(`🏷️  Node ${origin} classified as '${category}'`);
    siteStats.nodeCategory = category;
  } catch (err) {
    console.warn(`⚠️ Node classification failed for ${origin}: ${err.message}`);
    siteStats.nodeCategory = null;
  }

  siteStats.end = new Date().toISOString();
  await appendLog(siteStats);
  console.log(`🌐 Crawl complete for ${origin}: ${visited.size} pages processed.`);

  return siteStats;
}

// ------------------------------
// Run manifest writer (Audit Receipt)
// ------------------------------
async function writeRunManifest({ runId, startedAt, finishedAt, seed, settings, node, summary, capsules, errors }) {
  await fs.ensureDir(RUNS_DIR);
  const manifestPath = `${RUNS_DIR}/${runId}.json`;

  const manifest = {
    runId,
    startedAt,
    finishedAt,
    cgVersion: CG_VERSION,
    queueName,
    seed,
    settings,
    node,
    summary,
    capsules,
    errors: errors || [],
    manifestPath,
    nodeCategory: node?.nodeCategory || null,

    // ✅ CG Output Contract
    "agentnet:cgOutput": {
      capsulesInserted: summary?.inserted ?? 0,
      capsulesRejected: summary?.rejected ?? 0,
      schemaErrorsCount: summary?.schemaErrors ?? 0,
    },
  };

  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return manifestPath;
}

// ------------------------------
// BullMQ Worker
// ------------------------------
new Worker(
  queueName,
  async (job) => {
    const { url, owner_slug } = job.data;

    const runId = makeRunId();
    const startedAt = new Date().toISOString();

    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ userAgent: UA });

    const settings = {
      SINGLE_PAGE,
      MAX_DEPTH,
      MAX_PAGES_PER_SITE,
      PER_HOST_DELAY,
      ENABLE_LLM,
      EFFECTIVE_ENABLE_LLM,
      CG_DETERMINISTIC,
      VALIDATE_ENVELOPE: Boolean(validateEnvelope),
      SCHEMA_LOADED: envelopeSchemaLoaded,
      WRITE_SNAPSHOTS,
      USER_AGENT: UA,
      CONCURRENCY,
    };

    const seed = { owner_slug, url };
    const capsuleReceipts = [];
    const errors = [];

    try {
      const nodeId = await upsertNode(owner_slug, url);

      // Capsules will write this into the envelope immediately
      const manifestPath = `${RUNS_DIR}/${runId}.json`;

      const stats = await crawlSite({
        baseUrl: url,
        ctx,
        nodeId,
        cgRunId: runId,
        manifestPath,
      });

      await browser.close();

      capsuleReceipts.push({
        url,
        finishedAt: stats.end || new Date().toISOString(),
        insertedStatus: "see-db",
      });

      const finishedAt = new Date().toISOString();

      const summary = {
        pages: stats.pages,
        capsules: stats.capsules,
        inferred: stats.inferred,
        errors: stats.errors,
        inserted: stats.inserted,
        rejected: stats.rejected,
        schemaErrors: stats.schemaErrors,
      };

      const node = { nodeId, nodeCategory: stats.nodeCategory || null };

      const written = await writeRunManifest({
        runId,
        startedAt,
        finishedAt,
        seed,
        settings,
        node,
        summary,
        capsules: capsuleReceipts,
        errors,
      });

      console.log(`🏁 ${stats.pages} pages / ${stats.capsules} capsules (${stats.inferred} inferred) for ${url}`);
      console.log(`🧾 Run manifest written: ${written}`);

      return { ok: true, runId, manifestPath: written };
    } catch (e) {
      await browser.close();
      console.error(`💥 Fatal error on ${url}: ${e.message}`);

      errors.push({ site: url, error: e.message, time: new Date().toISOString() });

      await appendLog({ site: url, error: e.message, time: new Date().toISOString() });

      throw e;
    }
  },
  { connection, concurrency: CONCURRENCY }
);
