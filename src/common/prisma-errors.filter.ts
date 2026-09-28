import {
  ArgumentsHost,
  Catch,
  ConflictException,
  ExceptionFilter,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { Prisma } from '../generated/prisma/client';

/** Maps Prisma constraint errors to HTTP errors so handlers don't need try/catch around every write. */
@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaErrorsFilter
  extends BaseExceptionFilter
  implements ExceptionFilter
{
  catch(error: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    const mapped: Record<string, () => HttpException> = {
      P2002: () =>
        new ConflictException(
          `That ${String((error.meta?.target as string[] | undefined)?.join(', ') ?? 'value')} is already in use.`,
        ),
      P2003: () =>
        new ConflictException(
          'This record is still used elsewhere (for example by orders). Archive it instead.',
        ),
      P2025: () => new NotFoundException('Not found'),
    };
    super.catch(mapped[error.code]?.() ?? error, host);
  }
}
