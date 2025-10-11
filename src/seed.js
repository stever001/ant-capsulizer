const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { Queue } = require('bullmq');
const IORedis = require('ioredis');
const dotenv = require('dotenv');
dotenv.config();

// identical connection config as worker
const connection = new IORedis({
  host: process.env.REDIS_HOST,
  port: Number(process.env.REDIS_PORT),
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

const queueName = 'capsuleQueue';
const q = new Queue(queueName, { connection });

// Path to the seed CSV file
const seedPath = path.resolve(__dirname, '../seeds/instabuild-seed.csv');
const csvData = fs.readFileSync(seedPath, 'utf-8');
const records = parse(csvData, { columns: false, skip_empty_lines: true });

(async () => {
  console.log(`📥 Seeding ${records.length} jobs from ${seedPath} ...`);

  for (const row of records) {
    // since your CSV has only a URL column
    const url = row[0]?.trim();
    if (!url) continue;

    const owner_slug = new URL(url).hostname.replace(/^www\./, '').replace(/\./g, '-');
    await q.add('capsule', { owner_slug, url });
    console.log(`➕ Enqueued ${url}`);
  }

  console.log('✅ Seeding complete.');
  await connection.quit();
  process.exit(0);
})();
