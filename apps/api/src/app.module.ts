import { Module } from '@nestjs/common';
import { Database } from './database.js';
import { FiltersController, FiltersService } from './filters.js';
import { QueueService } from './queue.service.js';
import { JobsController, JobsService } from './jobs.js';
import { RecordsController, RecordsService } from './records.js';
import { SystemController } from './system.js';
import { EmailTemplatesController, EmailTemplatesService } from './email-templates.js';
import { GmailController, GmailService } from './gmail.js';
import { EmailCampaignsController, EmailCampaignsService } from './email-campaigns.js';

@Module({
  controllers: [FiltersController, JobsController, RecordsController, SystemController, EmailTemplatesController, GmailController, EmailCampaignsController],
  providers: [Database, FiltersService, QueueService, JobsService, RecordsService, EmailTemplatesService, GmailService, EmailCampaignsService]
})
export class AppModule {}
