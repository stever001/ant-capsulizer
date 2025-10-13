// src/worker.js
require("dotenv").config();

const { Worker } = require("bullmq");
const { chromium } = require("playwright");
const fs = require("fs-extra");
const cheerio = require("cheerio");
const { connection, queueName } = require("./queue");
const { upsertNode, insertCapsule } = require("./db");
const { fp } = require("./normalize");
const { inferCapsule } = require("./inferencer"); // ✅ new import for inference

const CONCURRENCY = parseInt(process.env.CONCURRENCY || 4);
const UA = process.env.USER_AGENT || "AgentNet-Capsulizer/1.0";
const PER_HOST_DELAY = parseInt(process.env.PER_HOST_DELAY_MS || 500);
const MAX_DEPTH = 10;
const MAX_PAGES_PER_SITE = 10;
const LOG_PATH = "./crawler.log";
const lastHit = new Map();

// ------------------------------
// Polite throttle per host
// ------------------------------
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
// Extract JSON-LD capsules
// ------------------------------
function extractCapsules(html, url) {
  const $ = cheerio.load(html);
  const ldBlocks = [];
  $("script[type='application/ld+json']").each((_, el) => {
    try {
      const raw = $(el).html().trim();
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) ldBlocks.push(...parsed);
      else ldBlocks.push(parsed);
    } catch (err) {
      console.warn(`⚠️ Invalid JSON-LD on ${url}: ${err.message}`);
    }
  });

  const now = new Date().toISOString();
  if (!ldBlocks.length) {
    return [
      {
        "@context": "https://agentnet.ai/context",
        "@type": "agentnet:Capsule",
        "agentnet:source": url,
        "agentnet:captureDate": now,
        "agentnet:content": {
          "@type": "agentnet:Error",
          "message": "No JSON-LD data found.",
        },
      },
    ];
  }

  return ldBlocks.map((block) => ({
    "@context": "https://agentnet.ai/context",
    "@type": "agentnet:Capsule",
    "agentnet:source": url,
    "agentnet:captureDate": now,
    "agentnet:content": block,
  }));
}

// ------------------------------
// Recursive site crawl
// ------------------------------
async function crawlSite(baseUrl, ctx, owner_slug, nodeId) {
  const origin = new URL(baseUrl).origin;
  const visited = new Set();
  const queue = [{ url: baseUrl, depth: 0 }];
  const siteStats = {
    site: origin,
    pages: 0,
    capsules: 0,
    inferred: 0,
    errors: 0,
    start: new Date().toISOString(),
  };

  while (queue.length && visited.size < MAX_PAGES_PER_SITE) {
    const { url, depth } = queue.shift();
    if (visited.has(url) || depth > MAX_DEPTH) continue;
    visited.add(url);
    await hostThrottle(url);

    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(800);
      const html = await page.content();
      const text = await page.evaluate(() => document.body.innerText || "");

      // --- Step 1: Extract explicit JSON-LD metadata
      const capsules = extractCapsules(html, url);
      const harvested_at = new Date().toISOString();

      // --- Step 2: Inference + enrichment for each capsule
      for (const capsule of capsules) {
        try {
          const extractedCapsule = capsule.agentnet?.content || capsule["agentnet:content"];
          const { capsule: enrichedCapsule, inferred } = await inferCapsule({
            url,
            html,
            text,
            extractedCapsule,
            options: { enableLLM: true },
          });

          // --- Step 3: Save to DB
          const fingerprint = fp(enrichedCapsule);
          await insertCapsule(nodeId, enrichedCapsule, fingerprint, harvested_at, "ok");

          if (inferred && Object.keys(inferred).length) {
            siteStats.inferred += 1;
          }
        } catch (infErr) {
          console.warn(`⚠️ Inference failed on ${url}: ${infErr.message}`);
          siteStats.errors += 1;
        }
      }

      // --- Save snapshot locally
      await fs.ensureDir("./snapshots");
      await fs.writeFile(`./snapshots/${encodeURIComponent(url)}.html`, html);

      console.log(`✅ ${capsules.length} capsule(s) processed for ${url}`);
      siteStats.pages += 1;
      siteStats.capsules += capsules.length;

      // --- Step 4: Enqueue internal links for shallow recursion
      if (depth < MAX_DEPTH) {
        const links = await page.$$eval("a[href]", (as) =>
          as.map((a) => a.href).filter((h) => h && h.startsWith(location.origin))
        );
        for (const link of links) {
          if (!visited.has(link)) queue.push({ url: link, depth: depth + 1 });
        }
      }
    } catch (e) {
      console.error(`❌ Error crawling ${url}: ${e.message}`);
      siteStats.errors += 1;
    } finally {
      await page.close();
    }
  }

  siteStats.end = new Date().toISOString();
  await appendLog(siteStats);
  console.log(`🌐 Crawl complete for ${origin}: ${visited.size} pages processed.`);
  return siteStats;
}

// ------------------------------
// BullMQ Worker
// ------------------------------
new Worker(
  queueName,
  async (job) => {
    const { url, owner_slug } = job.data;
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ userAgent: UA });

    try {
      const nodeId = await upsertNode(owner_slug, url);
      const stats = await crawlSite(url, ctx, owner_slug, nodeId);
      await browser.close();

      console.log(
        `🏁 ${stats.pages} pages / ${stats.capsules} capsules (${stats.inferred} inferred) for ${url}`
      );
      return { ok: true };
    } catch (e) {
      await browser.close();
      console.error(`💥 Fatal error on ${url}: ${e.message}`);
      await appendLog({ site: url, error: e.message, time: new Date().toISOString() });
      throw e;
    }
  },
  { connection, concurrency: CONCURRENCY }
);
