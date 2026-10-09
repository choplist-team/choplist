# ChopList API contract

Backend owns this file. Every route gets an example request and response here
before or alongside the code, so frontend can build against it.

Base path: /api

All request and response bodies are JSON. Successful responses always have a
JSON body (no empty 204s), so `response.json()` is always safe to call.

## Errors

Every error, on every route, has this shape:

```json
{ "error": { "code": "NOT_FOUND", "message": "Route GET /api/nope not found" } }
```

- `code` is stable and meant for code to check (`if (body.error.code === 'SOLD_OUT')`).
- `message` is for people and may change wording.

| Status | Code | When |
| ------ | ---- | ---- |
| 400 | `INVALID_JSON` | Request body is not valid JSON |
| 400 | `BAD_REQUEST` | Request could not be read |
| 400 | `VALIDATION_ERROR` | A field is missing or wrong; `message` names each field, e.g. `phone: Enter a Nigerian mobile number, e.g. 0803 123 4567` |
| 401 | `UNAUTHENTICATED` | No valid Clerk token on a seller route |
| 403 | `PROFILE_REQUIRED` | Signed in, but no seller profile yet: show onboarding, then `PUT /api/sellers/me` |
| 404 | `NOT_FOUND` | No route matches the method and path |
| 409 | `SLUG_TAKEN` | The chosen link is used by another seller |
| 413 | `PAYLOAD_TOO_LARGE` | Request body is over 20 KB |
| 500 | `INTERNAL_ERROR` | Server bug or outage; details are logged, never returned |

More codes are added as routes are built.

## Seller authentication

Seller routes need the Clerk session token:

```
Authorization: Bearer <token from Clerk's getToken()>
```

The seller is always identified from the token, never from the request body or
URL. Customer (public) routes need no token.

## Health

### GET /health

Not under `/api`. Used by UptimeRobot to keep the server awake. Does not touch
the database, so it answers even if MongoDB is unreachable.

Request:

```
GET /health
```

Response `200`:

```json
{ "status": "ok" }
```

## Seller profile

Phone numbers and account numbers must be sent as **strings**. A JSON number
loses the leading `0` (`0123456789` becomes `123456789`), so numbers are rejected
with `VALIDATION_ERROR`. Use `<input type="tel" inputMode="numeric">`, not
`type="number"`.

### GET /api/sellers/me

The signed-in seller's profile.

Request:

```
GET /api/sellers/me
Authorization: Bearer <token>
```

Response `200`:

```json
{
  "id": "6710a1c2e4b0a1b2c3d4e5f6",
  "businessName": "Mama T's Kitchen",
  "slug": "mama-ts-kitchen",
  "phone": "+2348031234567",
  "payment": {
    "bankName": "GTBank",
    "accountNumber": "0123456789",
    "accountName": "Titilayo Adebayo"
  },
  "createdAt": "2026-10-09T20:15:00.000Z",
  "updatedAt": "2026-10-09T20:15:00.000Z"
}
```

Errors: `401 UNAUTHENTICATED`, `403 PROFILE_REQUIRED` (no profile yet).

### PUT /api/sellers/me

Creates the profile (onboarding) or replaces it. Send every field each time;
only `slug` is optional.

- `slug` is the seller's public link (`/menu/<slug>`). If left out on the first
  call it is made from `businessName` (`Mama T's Kitchen` -> `mama-ts-kitchen`,
  or `mama-ts-kitchen-2` if taken). If left out later, the current slug is kept.
  Changing it breaks the old link already shared with customers.
- `phone` accepts `0803 123 4567`, `+234 803 123 4567` or `2348031234567` and is
  stored as `+2348031234567`.
- `payment.accountNumber` is exactly 10 digits (NUBAN), as a string.

Request:

```
PUT /api/sellers/me
Authorization: Bearer <token>
Content-Type: application/json
```

```json
{
  "businessName": "Mama T's Kitchen",
  "phone": "0803 123 4567",
  "payment": {
    "bankName": "GTBank",
    "accountNumber": "0123456789",
    "accountName": "Titilayo Adebayo"
  }
}
```

Response `201` (profile created) or `200` (profile updated), same body as
`GET /api/sellers/me`.

Errors: `400 VALIDATION_ERROR`, `401 UNAUTHENTICATED`, `409 SLUG_TAKEN`.
