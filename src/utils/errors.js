class AppError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;
  }
}

class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, 404);
  }
}

class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 401);
  }
}

class BadRequestError extends AppError {
  constructor(message = 'Bad request') {
    super(message, 400);
  }
}

class ConflictError extends AppError {
  constructor(message = 'Conflict') {
    super(message, 409);
  }
}

class GoneError extends AppError {
  constructor(message = 'Resource is no longer available') {
    super(message, 410);
  }
}

module.exports = {
  AppError,
  NotFoundError,
  UnauthorizedError,
  BadRequestError,
  ConflictError,
  GoneError,
};
