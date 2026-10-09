// Every error code the API can return. Kept in one list so routes can't invent
// near-duplicates ("NOT_FOUND" vs "NOTFOUND") and docs/api.md can list them all.
// Later steps add codes here as they need them.
export const ERROR_CODES = [
  'NOT_FOUND',
  'INVALID_JSON',
  'PAYLOAD_TOO_LARGE',
  'BAD_REQUEST',
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'PROFILE_REQUIRED',
  'SLUG_TAKEN',
  'MENU_NOT_FOUND',
  'MENU_NOT_DRAFT',
  'MENU_CLOSED',
  'MENU_NOT_OPEN',
  'ANOTHER_MENU_OPEN',
  'CUTOFF_PASSED',
  'ORDERING_CLOSED',
  'ITEM_NOT_FOUND',
  'INVALID_AREA',
  'INVALID_DELIVERY_DAY',
  'SOLD_OUT',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

// The one error type routes throw on purpose. The central error handler turns it
// into { error: { code, message } } with this HTTP status.
export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;

  constructor(status: number, code: ErrorCode, message: string) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
  }
}
