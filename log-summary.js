// log-summary.js
// Summarizes crawl statistics from crawler.log, with optional --csv export.

const fs = require('fs');
const path = require('path');

const LOG_PATH = './crawler.log';
const CSV_PATH = './crawl-summary.csv';
const args = process.argv.slice(2);
const exportCSV = args.includes('--csv');

if (!fs.existsSync(LOG_PATH)) {
  console.error('❌ No crawler.log found.');
  process.exit(1);
}

const lines = fs
  .readFileSync(LOG_PATH, 'utf8')
  .split('\n')
  .filter(line => line.trim().startsWith('['));

let totalSites = 0;
let totalPages = 0;
let totalCapsules = 0;
let totalErrors = 0;
let totalTime = 0;
const entries = [];

for (const line of lines) {
  try {
    const jsonStart = line.indexOf('{');
    const entry = JSON.parse(line.slice(jsonStart));
    totalSites++;
    totalPages += entry.pages || 0;
    totalCapsules += entry.capsules || 0;
    totalErrors += entry.errors || 0;

    const t1 = new Date(entry.start).getTime();
    const t2 = new Date(entry.end).getTime();
    const duration = (t2 - t1) / 1000; // seconds
    totalTime += duration;

    entries.push({
      site: entry.site,
      pages: entry.pages,
      capsules: entry.capsules,
      errors: entry.errors,
      duration: duration.toFixed(2),
      start: entry.start,
      end: entry.end,
    });
  } catch (err) {
    console.warn(`⚠️ Skipping bad line: ${line}`);
  }
}

if (!totalSites) {
  console.log('No completed sites found.');
  process.exit(0);
}

const avgPages = (totalPages / totalSites).toFixed(1);
const avgCapsules = (totalCapsules / totalSites).toFixed(1);
const avgTime = (totalTime / totalSites).toFixed(1);
const errorRate = ((totalErrors / totalSites) * 100).toFixed(1);

console.log('\n📊 ANT-CAPSULIZER SUMMARY');
console.log('──────────────────────────');
console.log(`Sites crawled:      ${totalSites}`);
console.log(`Total pages:        ${totalPages}`);
console.log(`Total capsules:     ${totalCapsules}`);
console.log(`Average pages/site: ${avgPages}`);
console.log(`Average capsules/site: ${avgCapsules}`);
console.log(`Average crawl time: ${avgTime}s`);
console.log(`Error rate:         ${errorRate}%`);
console.log('──────────────────────────\n');

// --- CSV Export ---
if (exportCSV) {
  const header = 'site,pages,capsules,errors,duration(start->end)\n';
  const csvRows = entries.map(
    e =>
      `${e.site},${e.pages},${e.capsules},${e.errors},${e.duration} (${e.start}→${e.end})`
  );
  fs.writeFileSync(CSV_PATH, header + csvRows.join('\n'));
  console.log(`🧾 Exported crawl summary to ${path.resolve(CSV_PATH)}\n`);
}
