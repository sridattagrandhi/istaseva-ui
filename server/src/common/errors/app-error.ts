export class AppError extends Error {
  public details?: unknown;
  constructor(
    public statusCode: number,
    message: string,
    public code?: string,
    details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    this.details = details;
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    super(404, id ? `${resource} '${id}' not found` : `${resource} not found`, 'NOT_FOUND');
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(400, message, 'VALIDATION_ERROR');
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(401, message, 'UNAUTHORIZED');
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(403, message, 'FORBIDDEN');
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, message, 'CONFLICT');
  }
}

/**
 * Thrown by listing activation paths when readiness checks fail. The
 * `details.missing` array carries structured reasons so the client can
 * render specific fix-it prompts instead of parsing the message string.
 */
export class ListingNotReadyError extends AppError {
  constructor(missing: Array<{ code: string; label: string; message: string }>) {
    super(
      400,
      "This listing can't go live yet.",
      'LISTING_NOT_READY',
      { missing },
    );
  }
}
