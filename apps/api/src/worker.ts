import 'reflect-metadata';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { Collector } from './collector.js';
import { Database } from './database.js';
import { EmailCampaignSender } from './email-campaigns.js';
import { EmailTemplatesService } from './email-templates.js';
import { GmailProviderError, GmailService } from './gmail.js';
import { COLLECTION_QUEUE, EMAIL_SEND_QUEUE, QueueService } from './queue.service.js';

const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
const database = new Database();
await database.onModuleInit();
const collector = new Collector(database, connection);
const queues = new QueueService();
const templates = new EmailTemplatesService(database);
const gmail = new GmailService(database, queues, templates);
const sender = new EmailCampaignSender(database, gmail);
const abandoned = await database.query<{ id: string }>(
  `SELECT id FROM campaign_recipients WHERE state = 'sending' AND provider_message_id IS NULL`
);
for (const recipient of abandoned.rows) {
  await sender.failure(recipient.id, new Error('Worker restarted during Gmail submission; manual review required to avoid a duplicate send'), false);
}

const collectionWorker = new Worker<{ jobId: string }>(COLLECTION_QUEUE, async (job) => collector.run(job.data.jobId), {
  connection,
  concurrency: 1,
  lockDuration: 120_000
});

const emailWorker = new Worker<{ recipientId: string; campaignId: string }>(EMAIL_SEND_QUEUE, async (job) => {
  try {
    await sender.process(job.data.recipientId);
  } catch (error) {
    const transient = error instanceof GmailProviderError ? error.transient : true;
    const attempts = job.opts.attempts ?? 1;
    const willRetry = transient && job.attemptsMade + 1 < attempts;
    await sender.failure(job.data.recipientId, error, willRetry);
    if (willRetry) throw error;
  }
}, {
  connection,
  concurrency: 1,
  lockDuration: 120_000,
  limiter: { max: 1, duration: Math.max(1, Number(process.env.EMAIL_SEND_DELAY_SECONDS ?? 5)) * 1_000 }
});

collectionWorker.on('failed', (job, error) => {
  process.stderr.write(`Job ${job?.id ?? 'unknown'} failed: ${error.message}\n`);
});

emailWorker.on('failed', (job, error) => {
  process.stderr.write(`Email recipient ${job?.id ?? 'unknown'} failed: ${error.message}\n`);
});

async function shutdown() {
  await collectionWorker.close();
  await emailWorker.close();
  await queues.onModuleDestroy();
  await database.onModuleDestroy();
  await connection.quit();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
