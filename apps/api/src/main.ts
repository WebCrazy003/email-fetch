import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import helmet from '@fastify/helmet';
import { AppModule } from './app.module.js';

function isAllowedLocalOrigin(origin: string) {
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

async function bootstrap() {
  const adapter = new FastifyAdapter({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, trustProxy: false });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter);
  app.enableCors({
    origin: (origin, callback) => callback(null, !origin || isAllowedLocalOrigin(origin)),
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'],
    credentials: false
  });
  await app.register(helmet, { contentSecurityPolicy: false });
  app.setGlobalPrefix('api');
  app.getHttpAdapter().getInstance().addHook('onRequest', async (request: { method: string; headers: Record<string, unknown> }, reply: {
    header(name: string, value: string): void;
    code(status: number): { send(body: unknown): void };
  }) => {
    const correlationId = typeof request.headers['x-request-id'] === 'string' ? request.headers['x-request-id'] : randomUUID();
    reply.header('x-request-id', correlationId);
    const hostHeader = typeof request.headers.host === 'string' ? request.headers.host : '';
    const hostname = hostHeader.replace(/^\[/, '').split(hostHeader.startsWith('[') ? ']' : ':')[0];
    if (!['127.0.0.1', 'localhost', '::1'].includes(hostname ?? '')) {
      reply.code(403).send({ message: 'Non-loopback host headers are blocked in local mode' });
      return;
    }
    const origin = request.headers.origin;
    if (typeof origin === 'string' && !isAllowedLocalOrigin(origin)) {
      reply.code(403).send({ message: 'Request origin is not allowed' });
    }
  });
  const port = Number(process.env.API_PORT ?? 3000);
  await app.listen(port, process.env.API_HOST ?? '127.0.0.1');
}

void bootstrap();
