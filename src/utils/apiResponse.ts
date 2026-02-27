// backend/src/utils/apiResponse.ts

import { Response } from 'express';

export interface ApiSuccessResponse<T = any> {
  success: true;
  data: T;
  message?: string;
  pagination?: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
}

export interface ApiErrorResponse {
  success: false;
  error: string;
  details?: string;
  code?: string;
}

export type ApiResponse<T = any> = ApiSuccessResponse<T> | ApiErrorResponse;

export class StandardResponse {
  static success<T>(res: Response, data: T, message?: string, pagination?: any): Response {
    const response: ApiSuccessResponse<T> = {
      success: true,
      data,
      ...(message && { message }),
      ...(pagination && { pagination })
    };
    return res.json(response);
  }

  static created<T>(res: Response, data: T, message?: string): Response {
    const response: ApiSuccessResponse<T> = {
      success: true,
      data,
      ...(message && { message })
    };
    return res.status(201).json(response);
  }

  static error(res: Response, error: string, statusCode = 500, details?: string, code?: string): Response {
    const response: ApiErrorResponse = {
      success: false,
      error,
      ...(details && { details }),
      ...(code && { code })
    };
    return res.status(statusCode).json(response);
  }

  static badRequest(res: Response, error: string, details?: string): Response {
    return this.error(res, error, 400, details, 'BAD_REQUEST');
  }

  static unauthorized(res: Response, error = 'User not authenticated'): Response {
    return this.error(res, error, 401, undefined, 'UNAUTHORIZED');
  }

  static forbidden(res: Response, error = 'Access forbidden'): Response {
    return this.error(res, error, 403, undefined, 'FORBIDDEN');
  }

  static notFound(res: Response, error = 'Resource not found'): Response {
    return this.error(res, error, 404, undefined, 'NOT_FOUND');
  }

  static conflict(res: Response, error: string, details?: string): Response {
    return this.error(res, error, 409, details, 'CONFLICT');
  }

  static internalError(res: Response, error = 'Internal server error', details?: string): Response {
    return this.error(res, error, 500, details, 'INTERNAL_ERROR');
  }
}
