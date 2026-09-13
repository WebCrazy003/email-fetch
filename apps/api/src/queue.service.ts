import { ConflictException, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

export const COLLECTION_QUEUE = 'collection';
export const EMAIL_SEND_QUEUE = 'email-send';

@Injectable()
export class QueueService implements OnModuleDestroy {
  readonly connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
  readonly collection = new Queue(COLLECTION_QUEUE, { connection: this.connection });
  readonly emailSend = new Queue(EMAIL_SEND_QUEUE, { connection: this.connection });

  enqueue(jobId: string) {
    return this.collection.add('collect', { jobId }, {
      jobId,
      attempts: 1,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 100,
      removeOnFail: 100
    });
  }

  async continueCollection(jobId: string) {
    const job = await this.collection.getJob(jobId);
    // Old failed entries can be removed by BullMQ's retention policy.
    if (!job) return this.enqueue(jobId);
    if (await job.getState() !== 'failed') {
      throw new ConflictException('The worker is still finishing this job. Try Continue again shortly.');
    }
    await job.retry('failed');
  }

  enqueueEmail(recipientId: string, campaignId: string, delay: number) {
    return this.emailSend.add('send-email', { recipientId, campaignId }, {
      jobId: recipientId,
      delay,
      attempts: 4,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 500,
      removeOnFail: 500
    });
  }

  async onModuleDestroy() {
    await this.collection.close();
    await this.emailSend.close();
    await this.connection.quit();
  }
}
