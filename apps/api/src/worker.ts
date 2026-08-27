import 'reflect-metadata';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { Collector } from './collector.js';
import { Database } from './database.js';
import { COLLECTION_QUEUE } from './queue.service.js';

const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
const database = new Database();
const collector = new Collector(database, connection);

const worker = new Worker<{ jobId: string }>(COLLECTION_QUEUE, async (job) => collector.run(job.data.jobId), {
  connection,
  concurrency: 1,
  lockDuration: 120_000
});

worker.on('failed', (job, error) => {
  process.stderr.write(`Collection job ${job?.id ?? 'unknown'} failed: ${error.message}\n`);
});

async function shutdown() {
  await worker.close();
  await database.onModuleDestroy();
  await connection.quit();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
