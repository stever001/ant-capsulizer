// src/queue.js
const { Queue, QueueEvents } = require('bullmq');
const IORedis = require('ioredis');

// Redis connection
const connection = new IORedis({
  host: process.env.REDIS_HOST,
  port: Number(process.env.REDIS_PORT),

  // BullMQ compatibility settings
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

const queueName = 'capsuleQueue';
const q = new Queue(queueName, { connection });

// Optional: event hooks
const queueEvents = new QueueEvents(queueName, { connection });
queueEvents.on('completed', ({ jobId }) => {
  console.log(`✅ Job ${jobId} completed`);
});
queueEvents.on('failed', ({ jobId, failedReason }) => {
  console.error(`❌ Job ${jobId} failed: ${failedReason}`);
});

console.log(`🧩 Queue initialized: ${queueName}`);

module.exports = {
  connection,
  queueName,
  q,
  queueEvents,
};
