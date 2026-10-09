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
| 400 | `ITEM_NOT_FOUND` | An ordered item is not on this menu |
| 400 | `INVALID_AREA` | Delivery area is not one the menu lists (the message lists them) |
| 400 | `INVALID_DELIVERY_DAY` | Delivery day is not one the menu lists (the message lists them) |
| 401 | `UNAUTHENTICATED` | No valid Clerk token on a seller route |
| 403 | `PROFILE_REQUIRED` | Signed in, but no seller profile yet: show onboarding, then `PUT /api/sellers/me` |
| 404 | `NOT_FOUND` | No route matches the method and path |
| 404 | `MENU_NOT_FOUND` | No such menu for this seller (also for another seller's menu, and malformed ids) |
| 404 | `SELLER_NOT_FOUND` | No seller has this public link |
| 404 | `ORDER_NOT_FOUND` | No order matches that reference and phone digits (same error for both) |
| 409 | `SLUG_TAKEN` | The chosen link is used by another seller |
| 409 | `MENU_NOT_DRAFT` | Editing a menu that is open or closed |
| 409 | `MENU_CLOSED` | Opening a closed menu (create a new one instead) |
| 409 | `MENU_NOT_OPEN` | Closing a draft |
| 409 | `ANOTHER_MENU_OPEN` | Opening a menu while another of yours is open |
| 409 | `CUTOFF_PASSED` | Opening a draft whose cut-off is in the past (edit it first) |
| 409 | `ORDERING_CLOSED` | The menu is closed, not yet open, or past its cut-off |
| 409 | `SOLD_OUT` | Not enough stock for at least one item; nothing was taken. The message names it, e.g. `Not enough left: only 2 Jollof rice left` |
| 409 | `ORDER_CANCELLED` | Marking a cancelled order paid |
| 413 | `PAYLOAD_TOO_LARGE` | Request body is over 20 KB |
| 429 | `RATE_LIMITED` | Too many orders or lookups from one network; wait (see the `RateLimit` header) |
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

## Menus (seller)

All routes need `Authorization: Bearer <token>` and a seller profile
(`401 UNAUTHENTICATED`, `403 PROFILE_REQUIRED` otherwise).

A menu goes **draft -> open -> closed**, one way only:

- **draft**: editable, invisible to customers.
- **open**: customers can order until `cutoffAt`. Cannot be edited. A seller can
  have only one open menu (their public link shows it).
- **closed**: final. Cannot be edited or reopened; create a new menu for the next week.

Field rules:

- `cutoffAt` must include a time zone (`2026-10-16T18:00:00+01:00` or
  `...Z`; `new Date().toISOString()` is fine) and be in the future.
- `deliveryDays` are `YYYY-MM-DD` Lagos dates, none before the cut-off's date.
  Returned sorted.
- `items`: 1 to 30. `price` is whole naira (at least 1); `qty` is portions
  available (1 to 1000). The response shows `qtyTotal` and `qtyRemaining`;
  only orders change `qtyRemaining`.
- `areas`: 1 to 30 delivery areas, each listed once.

The menu object returned by every route:

```json
{
  "id": "6710b2d3e4b0a1b2c3d4e5f7",
  "title": "Week of 13 Oct",
  "status": "draft",
  "cutoffAt": "2026-10-16T17:00:00.000Z",
  "items": [
    {
      "id": "6710b2d3e4b0a1b2c3d4e5f8",
      "name": "Jollof rice",
      "description": "With fried plantain",
      "price": 3500,
      "qtyTotal": 20,
      "qtyRemaining": 20
    }
  ],
  "areas": ["Yaba", "Surulere"],
  "deliveryDays": ["2026-10-17", "2026-10-18"],
  "openedAt": null,
  "closedAt": null,
  "createdAt": "2026-10-09T20:30:00.000Z",
  "updatedAt": "2026-10-09T20:30:00.000Z"
}
```

### POST /api/menus

Creates a draft.

```
POST /api/menus
Authorization: Bearer <token>
Content-Type: application/json
```

```json
{
  "title": "Week of 13 Oct",
  "cutoffAt": "2026-10-16T18:00:00+01:00",
  "items": [
    { "name": "Jollof rice", "description": "With fried plantain", "price": 3500, "qty": 20 }
  ],
  "areas": ["Yaba", "Surulere"],
  "deliveryDays": ["2026-10-17", "2026-10-18"]
}
```

Response `201`: the menu object, `status: "draft"`.

Errors: `400 VALIDATION_ERROR`.

### GET /api/menus

The seller's menus, newest first (up to 100).

```
GET /api/menus
Authorization: Bearer <token>
```

Response `200`:

```json
{ "menus": [ { "id": "6710b2d3e4b0a1b2c3d4e5f7", "title": "Week of 13 Oct", "status": "open", "...": "menu object" } ] }
```

### GET /api/menus/:id

```
GET /api/menus/6710b2d3e4b0a1b2c3d4e5f7
Authorization: Bearer <token>
```

Response `200`: the menu object.

Errors: `404 MENU_NOT_FOUND`.

### PUT /api/menus/:id

Replaces a **draft**. Same body as `POST /api/menus`; send every field. Stock
resets to the new `qty` values.

```
PUT /api/menus/6710b2d3e4b0a1b2c3d4e5f7
Authorization: Bearer <token>
Content-Type: application/json
```

Response `200`: the updated menu object.

Errors: `400 VALIDATION_ERROR`, `404 MENU_NOT_FOUND`, `409 MENU_NOT_DRAFT`.

### POST /api/menus/:id/open

Draft -> open. No body. Opening a menu that is already open returns it
unchanged (`200`).

```
POST /api/menus/6710b2d3e4b0a1b2c3d4e5f7/open
Authorization: Bearer <token>
```

Response `200`: the menu object, `status: "open"`, `openedAt` set.

Errors: `404 MENU_NOT_FOUND`, `409 ANOTHER_MENU_OPEN`, `409 MENU_CLOSED`,
`409 CUTOFF_PASSED`.

### POST /api/menus/:id/close

Open -> closed. No body. Closing a menu that is already closed returns it
unchanged (`200`).

```
POST /api/menus/6710b2d3e4b0a1b2c3d4e5f7/close
Authorization: Bearer <token>
```

Response `200`: the menu object, `status: "closed"`, `closedAt` set.

Errors: `404 MENU_NOT_FOUND`, `409 MENU_NOT_OPEN` (it is still a draft).

Note: a menu stays `open` after its cut-off until the seller closes it, but
orders are refused once `cutoffAt` has passed.

## Seller orders

All routes need `Authorization: Bearer <token>` and a seller profile. Orders are
addressed by their reference (what the seller sees in the bank transfer
description), not case-sensitive. Another seller's order or menu is a `404`.

Order status: **pending -> paid**, and **pending or paid -> cancelled**.
Cancelling puts the order's portions back on sale. Payment is matched by hand;
ChopList never moves money.

The seller's order object (includes the customer's phone and address):

```json
{
  "id": "6710c3e4e4b0a1b2c3d4e5f9",
  "ref": "CL-7KQ2M",
  "status": "pending",
  "customer": { "name": "Ada Obi", "phone": "+2348091112222" },
  "delivery": { "area": "Yaba", "address": "12 Herbert Macaulay Way, Yaba", "day": "2026-10-17" },
  "note": "Extra pepper",
  "lines": [{ "itemId": "6710b2d3e4b0a1b2c3d4e5f8", "name": "Jollof rice", "unitPrice": 3500, "qty": 2 }],
  "total": 7000,
  "paidAt": null,
  "cancelledAt": null,
  "createdAt": "2026-10-09T21:25:46.870Z"
}
```

### GET /api/menus/:id/orders

All orders for one of the seller's menus, newest first. Optional
`?status=pending|paid|cancelled`.

```
GET /api/menus/6710b2d3e4b0a1b2c3d4e5f7/orders?status=pending
Authorization: Bearer <token>
```

Response `200`:

```json
{ "orders": [ { "ref": "CL-7KQ2M", "status": "pending", "...": "seller order object" } ] }
```

Errors: `400 VALIDATION_ERROR` (unknown status), `404 MENU_NOT_FOUND`.

### PATCH /api/orders/:ref/paid

Marks a pending order paid. No body. Safe to repeat: a paid order is returned
unchanged, with the same `paidAt`.

```
PATCH /api/orders/CL-7KQ2M/paid
Authorization: Bearer <token>
```

Response `200`: the seller order object, `status: "paid"`, `paidAt` set.

Errors: `404 ORDER_NOT_FOUND`, `409 ORDER_CANCELLED`.

### PATCH /api/orders/:ref/cancel

Cancels a pending or paid order and puts its portions back on sale (also after
the menu has closed). No body. Safe to repeat: the stock comes back exactly
once, even if several cancel requests arrive together. Refunding a paid order is
done by the seller outside ChopList.

```
PATCH /api/orders/CL-7KQ2M/cancel
Authorization: Bearer <token>
```

Response `200`: the seller order object, `status: "cancelled"`, `cancelledAt` set.

Errors: `404 ORDER_NOT_FOUND`.

## Reports (seller)

Both are worked out from the orders on every request, so they are always up to
date (nothing is stored). Cancelled orders never count. `paidOnly=true` counts
only paid orders; the value must be exactly `true` or `false`.

### GET /api/menus/:id/prep-sheet

Portions to cook per item, in menu order. Items nobody ordered show `0`.

```
GET /api/menus/6710b2d3e4b0a1b2c3d4e5f7/prep-sheet?paidOnly=false
Authorization: Bearer <token>
```

Response `200`:

```json
{
  "menuId": "6710b2d3e4b0a1b2c3d4e5f7",
  "title": "Week of 13 Oct",
  "paidOnly": false,
  "items": [
    { "itemId": "6710b2d3e4b0a1b2c3d4e5f8", "name": "Jollof rice", "portions": 7, "orders": 3 },
    { "itemId": "6710b2d3e4b0a1b2c3d4e5fa", "name": "Chapman", "portions": 6, "orders": 3 },
    { "itemId": "6710b2d3e4b0a1b2c3d4e5fb", "name": "Egusi", "portions": 0, "orders": 0 }
  ],
  "totals": { "orders": 4, "portions": 13, "amount": 33500 }
}
```

`totals.amount` is the naira expected from the counted orders.

Errors: `400 VALIDATION_ERROR` (bad `paidOnly`), `404 MENU_NOT_FOUND`.

### GET /api/menus/:id/delivery-list

Orders grouped by delivery area, in the order the menu lists its areas. Within
an area: by delivery day, then in the order they came in. Optional
`?day=YYYY-MM-DD` for one delivery day, and `?paidOnly=true`.

```
GET /api/menus/6710b2d3e4b0a1b2c3d4e5f7/delivery-list?day=2026-10-17
Authorization: Bearer <token>
```

Response `200`:

```json
{
  "menuId": "6710b2d3e4b0a1b2c3d4e5f7",
  "title": "Week of 13 Oct",
  "paidOnly": false,
  "day": "2026-10-17",
  "areas": [
    {
      "area": "Yaba",
      "count": 1,
      "orders": [
        {
          "ref": "CL-7KQ2M",
          "status": "paid",
          "customer": { "name": "Ada Obi", "phone": "+2348091112222" },
          "address": "12 Herbert Macaulay Way, Yaba",
          "day": "2026-10-17",
          "note": "Extra pepper",
          "lines": [{ "name": "Jollof rice", "qty": 2 }],
          "total": 7000
        }
      ]
    }
  ],
  "totalOrders": 1
}
```

Errors: `400 VALIDATION_ERROR` (bad `paidOnly` or `day`), `404 MENU_NOT_FOUND`.

## Public routes (customers, no sign-in)

Rate limits, per IP address (counted on every attempt, valid or not):

| Route | Limit |
| ----- | ----- |
| `POST /api/public/orders` | 20 per 10 minutes |
| `GET /api/public/orders/:ref` | 30 per 10 minutes |

Over the limit: `429 RATE_LIMITED`, with a `RateLimit` header saying when to retry.

### GET /api/public/menu/:slug

A seller's public page: their open menu. `slug` is not case-sensitive.

```
GET /api/public/menu/mama-ts-kitchen
```

Response `200`:

```json
{
  "seller": { "businessName": "Mama T's Kitchen", "slug": "mama-ts-kitchen", "phone": "+2348031234567" },
  "menu": {
    "id": "6710b2d3e4b0a1b2c3d4e5f7",
    "title": "Week of 13 Oct",
    "cutoffAt": "2026-10-16T17:00:00.000Z",
    "acceptingOrders": true,
    "items": [
      {
        "id": "6710b2d3e4b0a1b2c3d4e5f8",
        "name": "Jollof rice",
        "description": "With fried plantain",
        "price": 3500,
        "qtyRemaining": 3,
        "soldOut": false
      }
    ],
    "areas": ["Yaba", "Surulere"],
    "deliveryDays": ["2026-10-17", "2026-10-18"]
  }
}
```

- `menu` is `null` when the seller has no open menu: show "no menu open right now".
- `acceptingOrders` is `false` once the cut-off has passed, even if the seller has
  not closed the menu yet. Hide the order button when it is `false`.

Errors: `404 SELLER_NOT_FOUND`.

### POST /api/public/orders

Places an order. Prices come from the menu; any price or total in the body is ignored.

- `customer.phone`: any Nigerian mobile format (`0809 111 2222`, `+234...`), as a string.
- `delivery.area` and `delivery.day` must be one of the menu's `areas` and
  `deliveryDays` (area is not case-sensitive).
- `lines`: 1 to 30, `qty` a whole number from 1 to 100. The same item twice is added together.
- `note` is optional (up to 300 characters).

```
POST /api/public/orders
Content-Type: application/json
```

```json
{
  "menuId": "6710b2d3e4b0a1b2c3d4e5f7",
  "customer": { "name": "Ada Obi", "phone": "0809 111 2222" },
  "delivery": { "area": "Yaba", "address": "12 Herbert Macaulay Way, Yaba", "day": "2026-10-17" },
  "note": "Extra pepper",
  "lines": [
    { "itemId": "6710b2d3e4b0a1b2c3d4e5f8", "qty": 2 }
  ]
}
```

Response `201`:

```json
{
  "order": {
    "ref": "CL-7KQ2M",
    "status": "pending",
    "customerName": "Ada Obi",
    "lines": [{ "name": "Jollof rice", "unitPrice": 3500, "qty": 2 }],
    "total": 7000,
    "delivery": { "area": "Yaba", "day": "2026-10-17" },
    "createdAt": "2026-10-09T21:25:46.870Z"
  },
  "payment": {
    "amount": 7000,
    "reference": "CL-7KQ2M",
    "bankName": "GTBank",
    "accountNumber": "0123456789",
    "accountName": "Titilayo Adebayo",
    "instructions": "Transfer ₦7,000 to Titilayo Adebayo, GTBank 0123456789, and write CL-7KQ2M as the transfer description so Mama T's Kitchen can match your payment."
  },
  "seller": { "businessName": "Mama T's Kitchen", "slug": "mama-ts-kitchen", "phone": "+2348031234567" }
}
```

Show the customer `payment.instructions` and the reference prominently. The order
stays `pending` until the seller marks it paid.

Errors: `400 VALIDATION_ERROR`, `400 ITEM_NOT_FOUND`, `400 INVALID_AREA`,
`400 INVALID_DELIVERY_DAY`, `404 MENU_NOT_FOUND`, `409 ORDERING_CLOSED`,
`409 SOLD_OUT` (nothing was taken; the message says what is left),
`429 RATE_LIMITED`.

### GET /api/public/orders/:ref?phoneLast4=1234

Lets a customer check their order. Needs the reference **and** the last 4 digits
of the phone number used to order. The reference is not case-sensitive.

```
GET /api/public/orders/CL-7KQ2M?phoneLast4=2222
```

Response `200`: same body as `POST /api/public/orders` (`order`, `payment`,
`seller`). The delivery address and full phone number are never returned.

Errors: `400 VALIDATION_ERROR` (`phoneLast4` missing or not 4 digits),
`404 ORDER_NOT_FOUND` (wrong reference or wrong digits, same error for both),
`429 RATE_LIMITED`.
