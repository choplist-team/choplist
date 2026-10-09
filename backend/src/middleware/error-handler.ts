import type { ErrorRequestHandler, RequestHandler, Response } from 'express';
import { AppError, type ErrorCode } from '../errors.js';

type ErrorBody = { error: { code: ErrorCode; message: string } };

function send(res: Response, status: number, code: ErrorCode, message: string) {
  const body: ErrorBody = { error: { code, message } };
  res.status(status).json(body);
}

// Runs only when no route matched. Registered with app.use() and no path, after
// all routes: Express 5 rejects a bare '*' path.
export const notFound: RequestHandler = (req, res) => {
  send(res, 404, 'NOT_FOUND', `Route ${req.method} ${req.path} not found`);
};

// Errors from Express's own body parser carry a `type`, a `status` and `expose`
// (true when the message is safe to show the client).
type ParserError = { type?: unknown; status?: unknown; expose?: unknown; message: string };

function isParserError(err: unknown): err is ParserError {
  return typeof err === 'object' && err !== null && 'type' in err && 'status' in err;
}

// Express recognises error middleware by its four parameters, so `_next` must
// stay even though only the headersSent branch uses it.
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (res.headersSent) {
    // Too late to send our JSON; let Express close the connection.
    _next(err);
    return;
  }

  if (err instanceof AppError) {
    send(res, err.status, err.code, err.message);
    return;
  }

  if (isParserError(err)) {
    if (err.type === 'entity.parse.failed') {
      send(res, 400, 'INVALID_JSON', 'Request body is not valid JSON');
      return;
    }
    if (err.type === 'entity.too.large') {
      send(res, 413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
      return;
    }
    if (err.expose === true && typeof err.status === 'number' && err.status >= 400 && err.status < 500) {
      send(res, err.status, 'BAD_REQUEST', err.message);
      return;
    }
  }

  // Anything else is a bug or an outage. Log the details for us, and never echo
  // them to the client (they can contain stack traces or connection strings).
  console.error(`Unhandled error on ${req.method} ${req.path}:`, err);
  send(res, 500, 'INTERNAL_ERROR', 'Something went wrong');
};
