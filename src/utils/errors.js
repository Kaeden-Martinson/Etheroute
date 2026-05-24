class ApiError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
  }
}

class ValidationError extends ApiError {
  constructor(message) {
    super(400, message);
    this.name = 'ValidationError';
  }
}

class NotFoundError extends ApiError {
  constructor(message) {
    super(404, message);
    this.name = 'NotFoundError';
  }
}

class UnauthorizedError extends ApiError {
  constructor(message = 'Unauthorized') {
    super(401, message);
    this.name = 'UnauthorizedError';
  }
}

module.exports = { ApiError, ValidationError, NotFoundError, UnauthorizedError };
