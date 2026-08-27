import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { HistoryService } from './history.service.js';
import { parseWith } from './http.js';

const renameSchema = z.object({ label: z.string().trim().max(120).nullable() });

@Controller('search-history')
export class HistoryController {
  constructor(private readonly history: HistoryService) {}

  @Get()
  list(@Query('context') context?: string) { return this.history.list(context); }

  @Get(':id')
  get(@Param('id') id: string) { return this.history.get(id); }

  @Post(':id/run')
  run(@Param('id') id: string) { return this.history.get(id); }

  @Patch(':id')
  rename(@Param('id') id: string, @Body() body: unknown) {
    return this.history.rename(id, parseWith(renameSchema, body).label);
  }

  @Delete()
  async clear() {
    return { deleted: await this.history.clear() };
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.history.remove(id);
    return { deleted: true };
  }
}
