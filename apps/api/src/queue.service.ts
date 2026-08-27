import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

export const COLLECTION_QUEUE = 'collection';

@Injectable()
export class QueueService implements OnModuleDestroy {
  readonly connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
  readonly collection = new Queue(COLLECTION_QUEUE, { connection: this.connection });

  enqueue(jobId: string) {
    return this.collection.add('collect', { jobId }, {
      jobId,
      attempts: 1,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 100,
      removeOnFail: 100
    });
  }

  async onModuleDestroy() {
    await this.collection.close();
    await this.connection.quit();
  }
}
