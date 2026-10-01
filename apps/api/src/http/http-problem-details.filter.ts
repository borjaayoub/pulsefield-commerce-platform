import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { STATUS_CODES } from 'node:http';
import { InvalidEmailVerificationTokenError } from '../identity/email-verification-token.service';
import { InvalidPasswordResetTokenError } from '../identity/password-reset-token.service';
import {
  CrossSiteRequestError,
  ForbiddenError,
  InvalidCredentialsError,
  InvalidCsrfTokenError,
  MfaAuthenticationFailedError,
  MfaServiceUnavailableError,
  NotificationDeliveryReplayUnavailableError,
  RecentAuthenticationRequiredError,
  SessionStoreUnavailableError,
  StaffAccountNotFoundError,
  UnauthenticatedError,
} from '../identity/authentication.errors';
import { PasswordPolicyError } from '../identity/password-policy';
import { RateLimitStorageUnavailableError } from '../rate-limit/rate-limit.errors';
import {
  CartItemUnavailableError,
  CartRequestValidationError,
  CartRevisionConflictError,
  CartRevisionRequiredError,
  CartCheckoutPendingError,
} from '../cart/cart.errors';
import {
  CheckoutConflictError,
  CheckoutPaymentUnavailableError,
  CheckoutRequestError,
} from '../checkout/checkout.errors';
import {
  FulfillmentConflictError,
  FulfillmentRequestError,
} from '../fulfillment/fulfillment.errors';
import {
  IdempotencyConflictError,
  InvalidIdempotencyInputError,
} from '../idempotency/idempotency.errors';
import {
  StripeWebhookPersistenceUnavailableError,
  StripeWebhookRequestError,
} from '../payments/payment-webhook.errors';
import {
  InventoryOperationConflict,
  InventoryOperationInvalid,
} from '../inventory/inventory-operations.errors';

interface ProblemDefinition {
  status: number;
  code: string;
  detail: string;
  errors?: string[];
  availableQuantity?: number;
  currentRevision?: number;
  currentVersion?: number;
}

function validationMessages(exception: HttpException): string[] | undefined {
  const response = exception.getResponse();

  if (typeof response !== 'object' || response === null || !('message' in response)) {
    return undefined;
  }

  const { message } = response;
  if (!Array.isArray(message) || !message.every((entry) => typeof entry === 'string')) {
    return undefined;
  }

  return message;
}

function safeHttpDetail(status: number): string {
  switch (status) {
    case HttpStatus.NOT_FOUND:
      return 'The requested resource was not found.';
    case HttpStatus.METHOD_NOT_ALLOWED:
      return 'The request method is not allowed for this resource.';
    default:
      return 'The request could not be completed.';
  }
}

function defineProblem(exception: unknown): ProblemDefinition {
  if (
    exception !== null &&
    typeof exception === 'object' &&
    Reflect.get(exception, 'status') === HttpStatus.PAYLOAD_TOO_LARGE &&
    Reflect.get(exception, 'type') === 'entity.too.large'
  ) {
    return {
      status: HttpStatus.PAYLOAD_TOO_LARGE,
      code: 'REQUEST_BODY_TOO_LARGE',
      detail: 'The request body is too large.',
    };
  }
  if (exception instanceof StripeWebhookRequestError) {
    return {
      status: HttpStatus.BAD_REQUEST,
      code: exception.code,
      detail: exception.message,
    };
  }
  if (exception instanceof StripeWebhookPersistenceUnavailableError) {
    return {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: exception.code,
      detail: exception.message,
    };
  }
  if (exception instanceof CheckoutPaymentUnavailableError) {
    return {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: exception.code,
      detail: exception.message,
    };
  }
  if (exception instanceof CheckoutConflictError) {
    return {
      status:
        exception.code === 'CART_REVISION_REQUIRED' || exception.code === 'IDEMPOTENCY_KEY_REQUIRED'
          ? HttpStatus.PRECONDITION_REQUIRED
          : HttpStatus.CONFLICT,
      code: exception.code,
      detail: exception.message,
      ...(exception.currentRevision !== undefined
        ? { currentRevision: exception.currentRevision }
        : {}),
    };
  }
  if (
    exception instanceof CheckoutRequestError ||
    exception instanceof InvalidIdempotencyInputError
  ) {
    return {
      status: HttpStatus.BAD_REQUEST,
      code: 'REQUEST_VALIDATION_FAILED',
      detail: 'Request validation failed.',
    };
  }
  if (exception instanceof FulfillmentConflictError) {
    return {
      status:
        exception.code === 'FULFILLMENT_REVISION_REQUIRED' ||
        exception.code === 'IDEMPOTENCY_KEY_REQUIRED'
          ? HttpStatus.PRECONDITION_REQUIRED
          : exception.code === 'FULFILLMENT_NOT_FOUND'
            ? HttpStatus.NOT_FOUND
            : HttpStatus.CONFLICT,
      code: exception.code,
      detail: exception.message,
      ...(exception.currentVersion !== undefined
        ? { currentVersion: exception.currentVersion }
        : {}),
    };
  }
  if (exception instanceof FulfillmentRequestError) {
    return {
      status: HttpStatus.BAD_REQUEST,
      code: exception.code,
      detail: exception.message,
    };
  }
  if (exception instanceof IdempotencyConflictError) {
    return {
      status: HttpStatus.CONFLICT,
      code: 'IDEMPOTENCY_KEY_CONFLICT',
      detail: exception.message,
    };
  }
  if (exception instanceof InventoryOperationConflict) {
    return {
      status: HttpStatus.CONFLICT,
      code: exception.code,
      detail: exception.message,
      ...(exception.currentVersion !== undefined
        ? { currentVersion: exception.currentVersion }
        : {}),
    };
  }
  if (exception instanceof InventoryOperationInvalid) {
    return { status: HttpStatus.BAD_REQUEST, code: exception.code, detail: exception.message };
  }
  if (exception instanceof CartCheckoutPendingError) {
    return { status: HttpStatus.CONFLICT, code: exception.code, detail: exception.message };
  }
  if (exception instanceof CartRevisionRequiredError) {
    return {
      status: HttpStatus.PRECONDITION_REQUIRED,
      code: exception.code,
      detail: exception.message,
    };
  }

  if (exception instanceof CartRevisionConflictError) {
    return {
      status: HttpStatus.CONFLICT,
      code: exception.code,
      detail: exception.message,
      ...(exception.currentRevision !== undefined
        ? { currentRevision: exception.currentRevision }
        : {}),
    };
  }

  if (exception instanceof CartItemUnavailableError) {
    return {
      status: HttpStatus.CONFLICT,
      code: exception.code,
      detail: exception.message,
      availableQuantity: exception.availableQuantity,
    };
  }

  if (exception instanceof CartRequestValidationError) {
    return { status: HttpStatus.BAD_REQUEST, code: exception.code, detail: exception.message };
  }

  if (exception instanceof InvalidCredentialsError) {
    return {
      status: HttpStatus.UNAUTHORIZED,
      code: exception.code,
      detail: exception.message,
    };
  }

  if (exception instanceof MfaAuthenticationFailedError) {
    return { status: HttpStatus.UNAUTHORIZED, code: exception.code, detail: exception.message };
  }

  if (exception instanceof MfaServiceUnavailableError) {
    return {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: exception.code,
      detail: exception.message,
    };
  }

  if (exception instanceof UnauthenticatedError) {
    return {
      status: HttpStatus.UNAUTHORIZED,
      code: exception.code,
      detail: exception.message,
    };
  }

  if (exception instanceof ForbiddenError) {
    return {
      status: HttpStatus.FORBIDDEN,
      code: exception.code,
      detail: exception.message,
    };
  }

  if (exception instanceof RecentAuthenticationRequiredError) {
    return {
      status: HttpStatus.FORBIDDEN,
      code: exception.code,
      detail: exception.message,
    };
  }

  if (exception instanceof StaffAccountNotFoundError) {
    return {
      status: HttpStatus.NOT_FOUND,
      code: exception.code,
      detail: exception.message,
    };
  }

  if (exception instanceof NotificationDeliveryReplayUnavailableError) {
    return {
      status: HttpStatus.CONFLICT,
      code: exception.code,
      detail: exception.message,
    };
  }

  if (exception instanceof InvalidCsrfTokenError || exception instanceof CrossSiteRequestError) {
    return {
      status: HttpStatus.FORBIDDEN,
      code: exception.code,
      detail: exception.message,
    };
  }

  if (exception instanceof SessionStoreUnavailableError) {
    return {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: exception.code,
      detail: 'Session handling is temporarily unavailable. Try again later.',
    };
  }

  if (exception instanceof PasswordPolicyError) {
    return {
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      code: exception.code,
      detail: exception.message,
    };
  }

  if (exception instanceof InvalidEmailVerificationTokenError) {
    return {
      status: HttpStatus.BAD_REQUEST,
      code: exception.code,
      detail: exception.message,
    };
  }

  if (exception instanceof InvalidPasswordResetTokenError) {
    return {
      status: HttpStatus.BAD_REQUEST,
      code: exception.code,
      detail: exception.message,
    };
  }

  if (exception instanceof RateLimitStorageUnavailableError) {
    return {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: exception.code,
      detail: 'Request protection is temporarily unavailable. Try again later.',
    };
  }

  if (exception instanceof ThrottlerException) {
    return {
      status: HttpStatus.TOO_MANY_REQUESTS,
      code: 'RATE_LIMIT_EXCEEDED',
      detail: 'Too many requests. Try again later.',
    };
  }

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const messages = validationMessages(exception);

    if (status === HttpStatus.BAD_REQUEST && messages?.length) {
      if (messages.every((message) => message === 'INVALID_EMAIL_VERIFICATION_TOKEN')) {
        return {
          status,
          code: 'INVALID_EMAIL_VERIFICATION_TOKEN',
          detail: 'Email verification token is invalid or unavailable.',
        };
      }

      if (messages.every((message) => message === 'INVALID_PASSWORD_RESET_TOKEN')) {
        return {
          status,
          code: 'INVALID_PASSWORD_RESET_TOKEN',
          detail: 'Password reset token is invalid or unavailable.',
        };
      }

      return {
        status,
        code: 'REQUEST_VALIDATION_FAILED',
        detail: 'Request validation failed.',
        errors: messages,
      };
    }

    return {
      status,
      code: `HTTP_${status}`,
      detail: safeHttpDetail(status),
    };
  }

  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    code: 'INTERNAL_SERVER_ERROR',
    detail: 'An unexpected error occurred.',
  };
}

function problemType(code: string): string {
  return `urn:pulse-field:problem:${code.toLowerCase().replaceAll('_', '-')}`;
}

@Catch()
export class HttpProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const requestId = request.header('x-request-id') ?? 'unavailable';
    const problem = defineProblem(exception);

    if (problem.status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      const errorName = exception instanceof Error ? exception.name : 'UnknownError';
      this.logger.error(`Request failed [${requestId}] (${errorName}).`);
    }

    response
      .status(problem.status)
      .setHeader('Cache-Control', 'no-store')
      .type('application/problem+json')
      .json({
        type: problemType(problem.code),
        title: STATUS_CODES[problem.status] ?? 'Error',
        status: problem.status,
        detail: problem.detail,
        instance: request.path,
        code: problem.code,
        requestId,
        ...(problem.errors ? { errors: problem.errors } : {}),
        ...(problem.availableQuantity !== undefined
          ? { availableQuantity: problem.availableQuantity }
          : {}),
        ...(problem.currentRevision !== undefined
          ? { currentRevision: problem.currentRevision }
          : {}),
        ...(problem.currentVersion !== undefined ? { currentVersion: problem.currentVersion } : {}),
      });
  }
}
