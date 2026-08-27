import { BadRequestException } from '@nestjs/common';
import type { ZodType } from 'zod';

export function parseWith<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BadRequestException({ message: 'Validation failed', issues: result.error.issues });
  }
  return result.data;
}

export function serializeDates<T>(value: T): T {
  return value;
}
