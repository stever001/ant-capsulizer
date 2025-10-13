// src/queue.js
require("dotenv").config();
const { Queue } = require("bullmq");
const Redis = require("ioredis");

const REDIS_PORT = parseInt(process.env.REDIS_PORT, 10) || 6379;
const REDIS_HOST = process.env.REDIS_HOST || "127.0.0.1";

const connection = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  maxRetriesPerRequest: null, // ✅ required for BullMQ v5
  enableReadyCheck: false,    // ✅ recommended with BullMQ v5
});

const queueName = "capsuleQueue";
const queue = new Queue(queueName, { connection });

console.log("🧩 Queue initialized:", queueName);

module.exports = { connection, queueName, queue };
