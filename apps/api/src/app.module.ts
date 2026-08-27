import { Module } from '@nestjs/common';
import { Database } from './database.js';
import { HistoryService } from './history.service.js';
import { QueueService } from './queue.service.js';
import { JobsController, JobsService } from './jobs.js';
import { RecordsController, RecordsService } from './records.js';
import { HistoryController } from './search-history.js';
import { SystemController } from './system.js';

@Module({
  controllers: [JobsController, RecordsController, HistoryController, SystemController],
  providers: [Database, HistoryService, QueueService, JobsService, RecordsService]
})
export class AppModule {}
