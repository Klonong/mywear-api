import { ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { PrismaErrorsFilter } from './common/prisma-errors.filter';
import { env } from './config';

try {
  process.loadEnvFile();
} catch {
  // no .env file: use the real environment
}

export async function createApp() {
  // rawBody: the payment webhook signature is checked against the exact bytes received
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    logger: process.env.NODE_ENV === 'test' ? ['error', 'warn'] : undefined,
  });
  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.useBodyParser('text', { type: 'text/csv', limit: '5mb' });
  app.enableCors({ origin: env.webOrigin, credentials: true });
  app.set('trust proxy', 1); // real client IP behind a proxy, for rate limiting
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(
    new PrismaErrorsFilter(app.get(HttpAdapterHost).httpAdapter),
  );
  app.enableShutdownHooks();

  const docs = new DocumentBuilder()
    .setTitle('MyWear API')
    .setDescription(
      'Storefront and admin API for the MyWear store. Money is integer IDR.',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, docs));
  return app;
}

if (require.main === module) {
  void createApp().then(async (app) => {
    await app.listen(env.port);
    console.log(
      `MyWear API on http://localhost:${env.port}/api (docs at /api/docs)`,
    );
  });
}
