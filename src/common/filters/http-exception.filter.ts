import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

// Global exception filter. Returns a consistent JSON envelope so client tests
// can assert against a stable shape.
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const payload = this.extractPayload(exception);

    response.status(status).json({
      statusCode: status,
      message: payload.message,
      error: payload.error,
      path: request.url,
      timestamp: new Date().toISOString(),
    });

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} -> ${status} ${payload.error}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }
  }

  private extractPayload(exception: unknown): {
    message: unknown;
    error: string;
  } {
    if (exception instanceof HttpException) {
      const response = exception.getResponse();
      if (typeof response === 'string') {
        return { message: response, error: exception.name };
      }
      const obj = response as { message?: unknown; error?: string };
      return {
        message: obj.message ?? exception.message,
        error: obj.error ?? exception.name,
      };
    }
    if (exception instanceof Error) {
      return { message: exception.message, error: exception.name };
    }
    return { message: String(exception), error: 'InternalServerError' };
  }
}
