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
| 404 | `NOT_FOUND` | No route matches the method and path |
| 413 | `PAYLOAD_TOO_LARGE` | Request body is over 20 KB |
| 500 | `INTERNAL_ERROR` | Server bug or outage; details are logged, never returned |

More codes are added as routes are built.

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
