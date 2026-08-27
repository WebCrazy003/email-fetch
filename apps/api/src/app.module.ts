import { Module } from '@nestjs/common';
import { Database } from './database.js';
import { FiltersController, FiltersService } from './filters.js';
import { QueueService } from './queue.service.js';
import { JobsController, JobsService } from './jobs.js';
import { RecordsController, RecordsService } from './records.js';
import { SystemController } from './system.js';

@Module({
  controllers: [FiltersController, JobsController, RecordsController, SystemController],
  providers: [Database, FiltersService, QueueService, JobsService, RecordsService]
})
export class AppModule {}
