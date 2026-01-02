// src/worker.js
require("dotenv").config();

const { Worker } = require("bullmq");
const { chromium } = require("playwright");
const fs = require("fs-extra");
const crypto = require("crypto");
const path = require("path");

const { checkProtocol } = require("./utils/checkProtocol");
const { connection, queueName } = require("./queue");
const { upsertNode, insertCapsule, pool } = require("./db");
const { fp } = require("./normalize");
const { inferCapsule } = require("./inferencer");
const { classifyNodeType } = require("./utils/classifyNodeType");

// ✅ JSON-LD extractor (must export { extractJsonLd })
const { extractJsonLd } = require("./extractor/jsonld");

const CONCURRENCY = parseInt(process.env.CONCURRENCY || 4, 10);
const UA = process.env.USER_AGENT || "AgentNet-Capsulizer/1.0";
const PER_HOST_DELAY = parseInt(process.env.PER_HOST_DELAY_MS || 500, 10);
const MAX_DEPTH = parseInt(process.env.MAX_DEPTH || 10, 10);
const MAX_PAGES_PER_SITE = parseInt(process.env.MAX_PAGES_PER_SITE || 10, 10);

const LOG_PATH = "./crawler.log";
const SNAPSHOT_DIR = "./snapshots";
const RUNS_DIR = "./runs";

// Optional flags (safe defaults)
const ENABLE_LLM = (process.env.ENABLE_LLM ?? "true").toLowerCase() === "true";
const WRITE_SNAPSHOTS =
  (process.env.WRITE_SNAPSHOTS ?? "true").toLowerCase() === "true";

// ✅ Demo-friendly flag
// Guardrail: default FALSE so prod isn't silently single-page
const SINGLE_PAGE =
  (process.env.SINGLE_PAGE ?? "false").toLowerCase() === "true";

// ✅ CG version marker
const CG_VERSION = process.env.CG_VERSION || "cg-0.3-run-manifest";

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
    if (
      dropPrefixes.some((p) => key === p || key.startsWith(p)) ||
      key.startsWith("a_ajs_")
    ) {
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
  const hash = crypto
    .createHash("sha256")
    .update(url)
    .digest("hex")
    .slice(0, 16);
  const safeBase = base.replace(/\//g, "_").slice(0, 120);
  return `${safeBase}__${hash}.html`;
}

// ------------------------------
// Run ID + manifest utilities
// ------------------------------
function makeRunId() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = crypto.randomBytes(6).toString("hex");
  return `run_${ts}__${rand}`;
}

function runManifestPathFor(runId) {
  return path.join(RUNS_DIR, `${runId}.json`);
}

async function writeRunManifestAt(filePath, manifest) {
  await fs.ensureDir(RUNS_DIR);
  await fs.writeJson(filePath, manifest, { spaces: 2 });
  return filePath;
}

// ------------------------------
// Build Capsule envelope
// ------------------------------
function buildEnvelope({
  url,
  harvestedAt,
  assertedJsonLdArray, // array | null
  assertedProvenanceArray, // array | null
  jsonldRawScriptCount,
  jsonldParseErrors,
  enrichedContent,
  inferredMeta,
  structuredMarkup,
  assertedPrimaryIndex,
  assertedPrimaryType,
  runId,
}) {
  return {
    "@context": "https://agentnet.ai/context",
    "@type": "agentnet:Capsule",

    "agentnet:cgVersion": CG_VERSION,
    "agentnet:cgRunId": runId,

    "agentnet:source": url,
    "agentnet:captureDate": harvestedAt,

    // ✅ Asserted is an ARRAY of JSON-LD objects when present
    "agentnet:asserted": assertedJsonLdArray?.length
      ? {
          json: assertedJsonLdArray,
          provenance: assertedProvenanceArray?.length
            ? assertedProvenanceArray
            : null,
        }
      : null,

    "agentnet:content": enrichedContent || {},

    ...(inferredMeta && Object.keys(inferredMeta).length
      ? { "agentnet:inferred": inferredMeta }
      : {}),

    "agentnet:report": {
      structuredMarkup,
      jsonldRawScriptCount: jsonldRawScriptCount || 0,
      jsonldParseErrors: jsonldParseErrors || 0,
      singlePageMode: SINGLE_PAGE,
      assertedMode: "array-per-page",
      assertedPrimaryIndex,
      assertedPrimaryType,
    },
  };
}

// ------------------------------
// Choose best asserted object for inferencer seed + record index/type
// ------------------------------
function pickBestAssertedWithIndex(assertedArray) {
  if (!Array.isArray(assertedArray) || !assertedArray.length) {
    return { primary: {}, primaryIndex: null, primaryType: null };
  }

  const isProduct = (o) => {
    const t = o?.["@type"];
    if (Array.isArray(t)) return t.some((x) => String(x).includes("Product"));
    return String(t || "").includes("Product");
  };

  const idx = assertedArray.findIndex(isProduct);
  const primaryIndex = idx >= 0 ? idx : 0;
  const primary = assertedArray[primaryIndex] || {};
  const primaryType = primary?.["@type"] || null;

  return { primary, primaryIndex, primaryType };
}

// ------------------------------
// Crawl site (single capsule per page)
// ------------------------------
async function crawlSite(baseUrl, ctx, owner_slug, nodeId, runId, runMeta) {
  const origin = new URL(baseUrl).origin;

  const visited = new Set();
  const q = [{ url: normalizeUrl(baseUrl), depth: 0 }];

  const siteStats = {
    runId,
    site: origin,
    pages: 0,
    capsules: 0,
    inferred: 0,
    errors: 0,
    start: new Date().toISOString(),
    singlePageMode: SINGLE_PAGE,
  };

  const allCapsulesForClassifier = [];

  if (WRITE_SNAPSHOTS) {
    await fs.ensureDir(SNAPSHOT_DIR);
  }

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

      const jsonld = extractJsonLd(html, url, { capturedAt: harvestedAt });

      if (jsonld.rawCount > 0 && !jsonld.found) {
        console.warn(
          `⚠️ JSON-LD scripts present but unparsable on ${url}:`,
          jsonld.parseErrors
        );
      }

      // ✅ Normalize asserted blocks to array of JSON objects
      const assertedJsonLdArray = jsonld.found
        ? jsonld.blocks
            .map((b) => (b && typeof b.json === "object" ? b.json : null))
            .filter(Boolean)
        : [];

      const assertedProvenanceArray = jsonld.found
        ? jsonld.blocks.map((b) => b.provenance || null).filter(Boolean)
        : [];

      const pick = pickBestAssertedWithIndex(assertedJsonLdArray);

      // ✅ IMPORTANT: never pass null into inferencer
      const extractedCapsule =
        pick.primary && typeof pick.primary === "object" ? pick.primary : {};

      const { capsule: enrichedContent, inferred } = await inferCapsule({
        url,
        html,
        text,
        extractedCapsule,
        options: { enableLLM: ENABLE_LLM },
      });

      const envelope = buildEnvelope({
        url,
        harvestedAt,
        assertedJsonLdArray: assertedJsonLdArray.length
          ? assertedJsonLdArray
          : null,
        assertedProvenanceArray: assertedProvenanceArray.length
          ? assertedProvenanceArray
          : null,
        jsonldRawScriptCount: jsonld.rawCount,
        jsonldParseErrors: jsonld.parseErrors.length,
        enrichedContent,
        inferredMeta: inferred,
        structuredMarkup: jsonld.found ? "jsonld" : "none",
        assertedPrimaryIndex: pick.primaryIndex,
        assertedPrimaryType: pick.primaryType,
        runId,
      });

      const fingerprint = fp(envelope);
      await insertCapsule(nodeId, envelope, fingerprint, harvestedAt, "ok");

      allCapsulesForClassifier.push({
        "agentnet:content": envelope["agentnet:content"],
      });

      if (inferred && Object.keys(inferred).length) {
        siteStats.inferred += 1;
      }

      siteStats.pages += 1;
      siteStats.capsules += 1;

      // Add to run manifest capsule list
      runMeta.capsules.push({
        url,
        harvestedAt,
        fingerprint,
        insertedStatus: "ok",
        asserted: {
          structuredMarkup: jsonld.found ? "jsonld" : "none",
          rawScriptCount: jsonld.rawCount,
          parsedObjectCount: assertedJsonLdArray.length,
          primaryIndex: pick.primaryIndex,
          primaryType: pick.primaryType,
        },
      });

      if (WRITE_SNAPSHOTS) {
        const name = snapshotName(url);
        await fs.writeFile(`${SNAPSHOT_DIR}/${name}`, html);
      }

      console.log(
        `✅ 1 capsule processed for ${url} ` +
          `(JSON-LD scripts: ${jsonld.rawCount}, parsed objects: ${assertedJsonLdArray.length})`
      );

      // Link discovery disabled in SINGLE_PAGE
      if (!SINGLE_PAGE && depth < MAX_DEPTH) {
        const links = await page.$$eval("a[href]", (as) =>
          as.map((a) => a.href).filter(Boolean)
        );

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

          if (!visited.has(normLink)) {
            q.push({ url: normLink, depth: depth + 1 });
          }
        }
      }
    } catch (e) {
      console.error(`❌ Error crawling ${url}: ${e.message}`);
      siteStats.errors += 1;

      runMeta.errors.push({
        url,
        message: e.message,
        time: new Date().toISOString(),
      });
    } finally {
      await page.close();
    }
  }

  // Classify node type after crawl
  try {
    const category = classifyNodeType(allCapsulesForClassifier);
    await pool.query(`UPDATE nodes SET node_category=? WHERE id=?`, [
      category,
      nodeId,
    ]);
    console.log(`🏷️  Node ${origin} classified as '${category}'`);
    runMeta.node.nodeCategory = category;
  } catch (err) {
    console.warn(`⚠️ Node classification failed for ${origin}: ${err.message}`);
    runMeta.node.nodeCategory = null;
  }

  siteStats.end = new Date().toISOString();
  await appendLog(siteStats);
  console.log(`🌐 Crawl complete for ${origin}: ${visited.size} pages processed.`);

  return siteStats;
}

// ------------------------------
// Worker
// ------------------------------
new Worker(
  queueName,
  async (job) => {
    const { url, owner_slug } = job.data;

    const runId = makeRunId();
    const runStartedAt = new Date().toISOString();

    const manifestPath = runManifestPathFor(runId);

    // Run manifest object
    const runMeta = {
      runId,
      startedAt: runStartedAt,
      finishedAt: null,
      cgVersion: CG_VERSION,
      queueName,
      seed: {
        owner_slug,
        url,
      },
      settings: {
        SINGLE_PAGE,
        MAX_DEPTH,
        MAX_PAGES_PER_SITE,
        PER_HOST_DELAY,
        ENABLE_LLM,
        WRITE_SNAPSHOTS,
        USER_AGENT: UA,
        CONCURRENCY,
      },
      node: {
        nodeId: null,
        nodeCategory: null,
      },
      summary: {
        pages: 0,
        capsules: 0,
        inferred: 0,
        errors: 0,
      },
      capsules: [],
      errors: [],
      manifestPath, // ✅ now always populated in-file
    };

    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ userAgent: UA });

    try {
      const nodeId = await upsertNode(owner_slug, url);
      runMeta.node.nodeId = nodeId;

      const stats = await crawlSite(url, ctx, owner_slug, nodeId, runId, runMeta);

      await browser.close();

      runMeta.finishedAt = new Date().toISOString();
      runMeta.summary.pages = stats.pages;
      runMeta.summary.capsules = stats.capsules;
      runMeta.summary.inferred = stats.inferred;
      runMeta.summary.errors = stats.errors;

      await writeRunManifestAt(manifestPath, runMeta);

      console.log(
        `🏁 ${stats.pages} pages / ${stats.capsules} capsules (${stats.inferred} inferred) for ${url}`
      );
      console.log(`🧾 Run manifest written: ${manifestPath}`);

      return { ok: true, runId, manifestPath };
    } catch (e) {
      await browser.close();

      runMeta.finishedAt = new Date().toISOString();
      runMeta.errors.push({
        url,
        message: e.message,
        time: new Date().toISOString(),
        fatal: true,
      });

      try {
        await writeRunManifestAt(manifestPath, runMeta);
        console.log(`🧾 Run manifest written (fatal): ${manifestPath}`);
      } catch (writeErr) {
        console.warn(`⚠️ Failed to write run manifest: ${writeErr.message}`);
      }

      console.error(`💥 Fatal error on ${url}: ${e.message}`);
      await appendLog({
        runId,
        site: url,
        error: e.message,
        time: new Date().toISOString(),
      });

      throw e;
    }
  },
  { connection, concurrency: CONCURRENCY }
);
