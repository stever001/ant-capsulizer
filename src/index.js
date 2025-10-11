// src/index.js
require('dotenv').config();
const { Queue } = require('bullmq');
const { Worker } = require('bullmq');
const { connection } = require('./queue');
const { upsertNode, insertCapsule } = require('./db');
const { chromium } = require('playwright');

console.log('🚀 ANT-CAPSULIZER starting up...');

// Just a sanity check that environment vars are loaded
console.log('Redis:', process.env.REDIS_HOST, process.env.REDIS_PORT);
console.log('MySQL:', process.env.DB_NAME);

// For now, this just starts the worker or scheduler entrypoint
require('./worker');  // Load the worker file (CommonJS)
