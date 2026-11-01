# ChopList API contract

Backend owns this file. Every route gets an example request and response here
before or alongside the code, so frontend can build against it.

Base path: /api (the one exception is `GET /health`, which is at the root).

Building the frontend? [frontend-guide.md](frontend-guide.md) shows how to call these
routes from React (a fixed API client, the customer order flow, Clerk sign-in). Online
payments (Paystack) are not in that guide yet: see "Online payments" and "For the
frontend team" below. Setting Paystack up and testing it: [paystack-setup.md](paystack-setup.md).

All request and response bodies are JSON. Successful responses always have a
JSON body (no empty 204s), so `response.json()` is always safe to call.

## Conventions

- **Money** is whole naira, as integers: `3500` means ₦3,500. There are no kobo
  and no decimals in any request or in any seller or customer response. The one
  exception is ChopList's own `revenue` on the admin overview, which can have two
  decimals (a 3% fee on ₦1,111 is ₦33.33). Kobo (1/100 naira) exists only inside
  the server and in its calls to Paystack.
- **Timestamps** (`cutoffAt`, `createdAt`, `paidAt`, ...) are UTC instants in ISO
  format, e.g. `2026-10-16T17:00:00.000Z`. Show them in Africa/Lagos on the client.
  When *sending* one (`cutoffAt`), include a time zone: `...Z` or `...+01:00`.
- **Delivery days** are calendar dates as `YYYY-MM-DD` strings, in Lagos time
  (`2026-10-17`). They are not instants, so they never shift a day.
- **Phone numbers and account numbers** are strings. Send them as typed
  (`0803 123 4567`); phones are stored as `+234XXXXXXXXXX`. A JSON number loses
  the leading `0` and is rejected.
- **Ids** are 24-character strings, e.g. `6710b2d3e4b0a1b2c3d4e5f7`.
- **CORS:** only the origins listed in the server's `ALLOWED_ORIGINS` can call the
  API from a browser. Requests may carry `Authorization`, `X-Order-Key` and
  `Content-Type`. An origin is the exact scheme, host and port, so
  `https://choplistafrica.com` and `https://www.choplistafrica.com` are separate
  entries. The same list decides which sites sign-in tokens are accepted from.
- **Bodies** over 20 KB are refused (`PAYLOAD_TOO_LARGE`).

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
| 401 | `INVALID_SIGNATURE` | `POST /api/webhooks/paystack` only: the signature is missing or wrong. Nothing was read or changed |
| 403 | `FORBIDDEN` | Signed in, but not an administrator, on an `/api/admin` route |
| 403 | `ACCOUNT_SUSPENDED` | The seller's account was suspended or deactivated by an admin; every seller route refuses until it is reinstated. Show the message and a support contact |
| 403 | `PROFILE_REQUIRED` | Signed in, but no seller profile yet: show onboarding, then `PUT /api/sellers/me` |
| 404 | `NOT_FOUND` | No route matches the method and path |
| 404 | `MENU_NOT_FOUND` | No such menu for this seller (also for another seller's menu, and malformed ids) |
| 404 | `SELLER_NOT_FOUND` | No seller has this public link |
| 404 | `ORDER_NOT_FOUND` | No order matches that reference and phone digits (same error for both). On `/pay` and `/payment-status`: no order matches that reference and `X-Order-Key` (a wrong key, a missing key and an unknown reference all look the same) |
| 404 | `REPORT_NOT_FOUND` | No "my order is missing" report has that id (admin) |
| 409 | `SLUG_TAKEN` | The chosen link is used by another seller |
| 409 | `MENU_NOT_DRAFT` | Editing a menu that is open or closed |
| 409 | `MENU_CLOSED` | Opening a closed menu (create a new one instead) |
| 409 | `MENU_NOT_OPEN` | Closing a draft |
| 409 | `ANOTHER_MENU_OPEN` | Opening a menu while another of yours is open |
| 409 | `CUTOFF_PASSED` | Opening a draft whose cut-off is in the past (edit it first) |
| 409 | `ORDERING_CLOSED` | The menu is closed, not yet open, or past its cut-off |
| 409 | `SOLD_OUT` | Not enough stock for at least one item; nothing was taken. The message names it, e.g. `Not enough left: only 2 Jollof rice left` |
| 409 | `ORDER_CANCELLED` | Paying (by hand or online), sending out or confirming a cancelled order |
| 409 | `ORDER_ALREADY_PAID` | Starting an online payment for an order that is already paid (or further along) |
| 409 | `PAYMENTS_NOT_READY` | Starting an online payment for a seller who does not take them yet (not set up, suspended or deactivated). The message tells the customer to use bank transfer. Offer transfer instead |
| 409 | `ORDER_NOT_PAID` | Sending an order out for delivery before it is paid |
| 409 | `ORDER_DELIVERED` | Cancelling or sending out an order that is already delivered |
| 409 | `ORDER_NOT_OUT_FOR_DELIVERY` | Confirming or resetting the code of an order that is not out for delivery |
| 400 | `INVALID_DELIVERY_CODE` | Wrong delivery code; the message says how many attempts are left |
| 409 | `DELIVERY_CODE_LOCKED` | 5 wrong codes: even the right code is refused until the seller resets it |
| 409 | `DELIVERY_RESET_LIMIT` | The code was already reset twice for this order |
| 413 | `PAYLOAD_TOO_LARGE` | Request body is over 20 KB |
| 429 | `RATE_LIMITED` | Too many orders or lookups from one network; wait (see the `RateLimit` header) |
| 500 | `INTERNAL_ERROR` | Server bug or outage; details are logged, never returned |
| 503 | `PAYMENTS_UNAVAILABLE` | Online payment cannot be used right now: the server has no Paystack key, or Paystack could not be reached. The message tells the customer to pay by bank transfer. Also the bank list when it cannot be loaded. Safe to retry |

Every code the API can return is in this table. A route's own "Errors" line lists
the ones that route can produce; any route can also return `INVALID_JSON`,
`PAYLOAD_TOO_LARGE` and `INTERNAL_ERROR`.

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
  "email": "titi@example.com",
  "status": "active",
  "payment": {
    "bankName": "GTBank",
    "accountNumber": "0123456789",
    "accountName": "Titilayo Adebayo",
    "bankCode": "058"
  },
  "feeMode": "customer",
  "paymentsReady": true,
  "paymentsIssue": null,
  "createdAt": "2026-10-09T20:15:00.000Z",
  "updatedAt": "2026-10-09T20:15:00.000Z"
}
```

`email` is `null` when the seller gave none. `status` is `active` (the only value a
seller can see in a normal response; the others are described below).

The payment fields are new (see [Online payments](#online-payments-paystack)):

- `payment.bankCode` is Paystack's code for the bank (`"058"`), or `null` for a
  seller who has not picked their bank from the list yet.
- `feeMode` is `"customer"` or `"seller"`: who pays the card fees.
- `paymentsReady` is `true` when customers can pay this seller online. When it is
  `false`, `paymentsIssue` says why (see the table under
  [Seller payments](#seller-payments)); when it is `true`, `paymentsIssue` is `null`.
- Nothing Paystack-internal (the seller's payout-account code) is ever returned.

Errors: `401 UNAUTHENTICATED`, `403 PROFILE_REQUIRED` (no profile yet),
`403 ACCOUNT_SUSPENDED`.

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
- `payment.bankCode` is optional: 2 to 6 digits, **taken from `GET /api/sellers/banks`**
  (never typed by hand). It is what lets Paystack pay the seller directly. If it is
  left out, the stored one is **kept** while `bankName` and `accountNumber` are
  unchanged, and **cleared** if either changed (an old code would point at the wrong
  bank). Without a bank code the profile saves normally and the seller stays on bank
  transfer (`paymentsIssue: "NO_BANK_CODE"`).
- Saving also sets up the seller's Paystack payout account when needed. This can
  take a few seconds (up to two calls to Paystack), so show a spinner. If Paystack
  fails, **the profile still saves** and the response says `paymentsReady: false`
  with a `paymentsIssue`; saving again, or `POST /api/sellers/me/payments/retry`,
  tries again. Changing the bank or account number switches online payments **off**
  until the new account is confirmed, so money never goes to the old account.
- `feeMode` and `paidOrderCount` cannot be set here (they are ignored).
- `email` is optional: a valid address (stored lower-case). Leave it out to keep
  the current one; send `""` to remove it. Admins see it next to the phone.

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
    "accountName": "Titilayo Adebayo",
    "bankCode": "058"
  }
}
```

Response `201` (profile created) or `200` (profile updated), same body as
`GET /api/sellers/me`.

Errors: `400 VALIDATION_ERROR`, `401 UNAUTHENTICATED`, `409 SLUG_TAKEN`.

### Seller payments

Online payments are set up from the profile above; these routes cover the rest. All
need `Authorization: Bearer <token>`. A suspended or deactivated seller gets
`403 ACCOUNT_SUSPENDED` from the three that need a profile.

**`GET /api/sellers/banks`**: the banks to choose from. Needs sign-in but **not** a
profile, because onboarding picks the bank first. Cached by the server for 6 hours.

```json
{ "banks": [ { "name": "Access Bank", "code": "044" }, { "name": "GTBank", "code": "058" } ] }
```

Errors: `401 UNAUTHENTICATED`, `503 PAYMENTS_UNAVAILABLE` (payments are off, or the
list cannot be loaded and none is saved). If it is unavailable, let the seller finish
onboarding without a bank code.

**`GET /api/sellers/me/payments`**: where this seller stands.

```json
{
  "paymentsReady": true,
  "paymentsIssue": null,
  "feeMode": "customer",
  "paidOrderCount": 49,
  "freeOrders": 50,
  "freeOrdersRemaining": 1,
  "tier": "free",
  "platformFeeBps": 300
}
```

- `paidOrderCount` counts orders paid **through Paystack** (not bank transfers).
- `freeOrdersRemaining` is how many are left before ChopList's fee starts.
  `tier` is what the **next** payment will be charged under: `"free"` or `"standard"`.
- `platformFeeBps` is ChopList's fee in basis points (`300` = 3%), charged on the
  order amount once the free orders are used.

**`PUT /api/sellers/me/fee-mode`**: who pays the card fees from now on.

```json
{ "feeMode": "seller" }
```

Response `200`: same body as `GET /api/sellers/me/payments`. `feeMode` is `"customer"`
(a service fee is added to the customer's total, the seller receives the full order
amount) or `"seller"` (the customer pays only the order amount; ChopList's fee and
Paystack's charge come out of what the seller receives). Orders whose payment was
already started keep the fee they were quoted. This is a **seller setting**: the
customer is never asked to choose. Errors: `400 VALIDATION_ERROR`.

**`POST /api/sellers/me/payments/retry`**: tries the Paystack setup again without
re-saving the profile (for example after Paystack was down). No body. Response `200`:
same body as `GET /api/sellers/me/payments`, with `paymentsIssue` set if it failed
again. A failed retry never switches off payments that already work.

`paymentsIssue` is one of:

| `paymentsIssue` | Meaning | What to show |
| --------------- | ------- | ------------ |
| `null` | Ready | Online payments are on |
| `NO_BANK_CODE` | The seller has not picked their bank from the list | Ask them to choose their bank |
| `ACCOUNT_NOT_FOUND` | Paystack could not find that account at that bank | Ask them to check the bank and account number |
| `SETUP_REJECTED` | Paystack refused to create the payout account | Ask them to check their details; contact support if it repeats |
| `PAYSTACK_UNAVAILABLE` | Paystack (or ChopList's connection to it) failed; not the seller's fault | "Try again in a few minutes", with a retry button |
| `NOT_CONFIGURED` | ChopList has online payments switched off | Nothing to do; bank transfer only |
| `NOT_SET_UP` | Not set up yet and nothing has failed (for example an old profile) | Offer to retry |

## Suspended and deactivated sellers

An admin can set a seller's account to `suspended` or `deactivated` (nothing is
deleted, and an admin can reinstate it). While it is not `active`:

- Every seller route (`/api/sellers/*`, `/api/menus/*`, `/api/orders/*`) answers
  `403 ACCOUNT_SUSPENDED`, including `PUT /api/sellers/me`. The frontend should show
  the message and a support contact instead of the dashboard.
- The seller's public link, `GET /api/public/menu/:slug`, is a `404 SELLER_NOT_FOUND`,
  the same as a link that does not exist.
- A new order on one of their menus is refused with `409 ORDERING_CLOSED`. The
  answer does not say the account is suspended. (There is a window of a few
  milliseconds around a suspension in which an order already in progress can
  still be saved.)
- Orders already placed stay. Customers can still look them up. The seller cannot
  mark them paid or delivered until the account is reinstated.

Sellers created before account status existed have no `status` stored; they are
treated as `active`. `npm run backfill:admin` writes it.

## Admin console

Everything under `/api/admin` is for ChopList administrators only. This section is
the contract the admin endpoints follow; each endpoint is documented below as it is
built.

**Who is an admin.** The Clerk user ids listed in the `ADMIN_CLERK_USER_IDS`
environment variable (comma separated; see `.env.example`). An admin is a person, not
a seller: they need no shop. Changing the list needs a restart (a redeploy on
Render). With the variable empty or unset nobody is an admin.

- No token: `401 UNAUTHENTICATED`.
- Signed in but not listed: `403 FORBIDDEN`.

**Lists** (every list endpoint) take `?page=` (from 1) and `?limit=` (default 20,
at most 100), are sorted newest first, and return the total so the page can show
"page 2 of 7".

**Customer privacy.** Admin order lists show phone numbers masked (`0803****567`).
The full number comes only from the single-order endpoint with `?reveal=true`, and
every reveal is written to an audit trail (who, which order, when) that admins can
read at `GET /api/admin/audit`. Delivery codes
and order access keys are never returned by any admin endpoint.

**Payment status** (`paid`, `pending`) is confirmed one of two ways, and the order's
`paymentMethod` says which. For `transfer` it is **confirmed by the seller** after they
see the bank transfer; ChopList cannot see the seller's bank, so it cannot verify
that. For `paystack` it is confirmed by **Paystack**, and ChopList re-checks the
amount with Paystack before marking the order paid. ChopList never holds the money in
either case.

**Possible duplicates.** When an order is placed, ChopList stores a fingerprint of
the customer's phone number, the menu and the items and quantities. If another
order with the same fingerprint (not cancelled) exists within 10 minutes of it,
the order is marked `possibleDuplicate`. It only says "possible": a customer may
really order twice. If two identical orders arrive at the same moment, both may be
marked.

**Phone numbers** are stored in one form (`+2348031234567`), whichever way the
customer typed them (`0803 123 4567`, `+234 803 123 4567`). Orders saved before
this was enforced are fixed by `npm run backfill:admin`.

**Event log.** Failed order attempts and server errors are recorded with an error
code, the menu and the seller, and never the customer's phone, name, address or any
delivery code. Events are deleted automatically after 60 days.

### GET /api/admin/me

Answers "am I an admin?" for the frontend's admin guard. `200 { "admin": true }` for
an admin, `401 UNAUTHENTICATED` when not signed in, `403 FORBIDDEN` for a signed-in
user who is not an admin. Nothing else is returned.

```
GET /api/admin/me
Authorization: Bearer <token>
```

### GET /api/admin/overview

Platform numbers for the dashboard. Each definition is returned as text so the
page can show it next to the figure.

```
GET /api/admin/overview
Authorization: Bearer <admin token>
```

Response `200`:

```json
{
  "generatedAt": "2026-10-29T14:40:00.000Z",
  "totalSellers": 5,
  "activeSellers": 2,
  "publishedMenus": 3,
  "openMenus": 1,
  "totalOrders": 8,
  "ordersLast7Days": 4,
  "ordersLast30Days": 7,
  "successRate": 0.6667,
  "fulfilmentRate": 0.3333,
  "ordersCounted": 6,
  "definitions": {
    "activeSellers": "Sellers whose account status is active (not suspended or deactivated) AND who used the seller app or received an order in the last 30 days.",
    "successRate": "Of the orders whose menu cut-off has already passed, the share that reached paid, out for delivery or delivered. Payment is confirmed by the seller (bank transfer) or by Paystack. ChopList itself never holds the money.",
    "...": "one entry per figure"
  },
  "payments": {
    "gmv": { "allTime": 32000, "last30Days": 18500 },
    "revenue": { "allTime": 555, "last30Days": 225 },
    "paidOnPlatform": {
      "allTime": { "orders": 3, "gmv": 22500 },
      "last30Days": { "orders": 2, "gmv": 11500 }
    },
    "paidByTransfer": {
      "allTime": { "orders": 3, "gmv": 9500 },
      "last30Days": { "orders": 2, "gmv": 7000 }
    },
    "platformShare": 0.5,
    "payingSellers": { "allTime": 1, "last30Days": 1 },
    "sellersOnPlatform": { "allTime": 2, "last30Days": 2 },
    "onlinePaymentsReady": 2,
    "paymentsNeedingReview": 2,
    "definitions": { "gmv": "...", "revenue": "...", "...": "one entry per figure above" }
  },
  "funnel": [
    { "key": "registered", "label": "Registered", "count": 7, "fromPrevious": null, "definition": "..." },
    { "key": "profileComplete", "label": "Profile complete", "count": 6, "fromPrevious": 0.8571, "definition": "..." },
    { "key": "menuPublished", "label": "Menu published", "count": 5, "fromPrevious": 0.8333, "definition": "..." },
    { "key": "firstOrder", "label": "First order", "count": 4, "fromPrevious": 0.8, "definition": "..." },
    { "key": "firstPaidOrder", "label": "First paid order", "count": 3, "fromPrevious": 0.75, "definition": "..." }
  ]
}
```

- `successRate` and `fulfilmentRate` are fractions from 0 to 1 (show 0.6667 as 66.7%).
  `ordersCounted` is how many orders they are out of: orders whose menu cut-off has
  passed. Orders on a menu that is still taking orders are not counted either way.
- The rates are `null` when `ordersCounted` is 0 ("no data yet", not "0%").
- `activeSellers` excludes suspended and deactivated sellers even if they were
  recently active. "Published" means a menu that has been opened at least once.
- Success rate counts what was **confirmed**: by the seller (bank transfer) or by
  Paystack. An order paid by bank transfer but never marked paid by the seller
  counts as not succeeded.

The `payments` block (all show their own `definitions`; show them beside the figures):

- **`gmv`** is the food value of orders that reached paid or beyond, by either
  method, **not** including any service fee. **`revenue`** is ChopList's own earnings:
  the platform fee on Paystack-confirmed payments (0 during a seller's free orders),
  in naira with up to two decimals. Revenue is **not** reduced by refunds (there is
  no refund tracking yet), so a payment on an order later cancelled counts until a
  person removes it. Both are given `allTime` and `last30Days` (by the day paid).
- **`paidOnPlatform`** and **`paidByTransfer`** split paid orders by method, with
  their GMV. Orders from before Paystack count as transfers. **`platformShare`** is
  the Paystack share of all paid orders (`null` when none are paid yet).
- **`payingSellers`** are sellers who have paid ChopList at least once (a confirmed
  payment with a fee above 0). **`sellersOnPlatform`** are sellers with any confirmed
  Paystack payment, including during their free orders.
- **`onlinePaymentsReady`** is how many sellers can take online payments right now.
- **`paymentsNeedingReview`** is payments where the customer's money arrived but the
  order could not be completed (cancelled first, wrong amount, paid twice). **Each
  one needs a person to refund or reinstate it**; `GET /api/admin/events` (type
  `payment_webhook_issue`) says which order. Show this number prominently when it is
  above 0.

The `funnel` is a cohort funnel: each stage only counts sellers who also passed every
earlier stage, so counts only shrink and `fromPrevious` never passes 1. "Registered"
counts seller records, which exist only after the onboarding form is submitted; people
who signed up with Clerk but never finished are not in ChopList's database (Clerk's
dashboard shows them). Today "profile complete" equals "registered" because onboarding
already requires every profile field.

### GET /api/admin/sellers

Sellers, newest registered first. Optional `?q=` (searches business name, link,
email and phone, which can be typed as `0803 123`, `+234 803 123` or `803123`;
the text is matched literally), `?status=active|suspended|deactivated`, `?page=`,
`?limit=` (default 20, at most 100).

```
GET /api/admin/sellers?q=mama&status=active&page=1&limit=20
Authorization: Bearer <admin token>
```

Response `200`:

```json
{
  "sellers": [
    {
      "id": "6710a1c2e4b0a1b2c3d4e5f6",
      "businessName": "Mama T Kitchen",
      "slug": "mama-t",
      "publicMenuPath": "/api/public/menu/mama-t",
      "phone": "+2348031234567",
      "email": "mama@example.com",
      "status": "active",
      "statusReason": null,
      "statusChangedAt": null,
      "lastActiveAt": "2026-10-29T14:30:00.000Z",
      "registeredAt": "2026-08-30T10:00:00.000Z",
      "openMenu": { "id": "6710b2d3e4b0a1b2c3d4e5f7", "title": "This week", "cutoffAt": "2026-10-31T17:00:00.000Z" },
      "totalOrders": 7
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

`openMenu` is `null` when the seller has no menu open. Bank details are never
returned to admins. `lastActiveAt` is when the seller last used the seller app (at
most one update per 10 minutes); a seller who only receives orders may show an old
date. Errors: `400 VALIDATION_ERROR` (bad `status`, `page` or `limit`).

### GET /api/admin/sellers/:id

One seller: the same fields plus their menus (newest 50) and order counts.

Response `200` (abridged):

```json
{
  "id": "6710a1c2e4b0a1b2c3d4e5f6",
  "businessName": "Mama T Kitchen",
  "status": "active",
  "lastActiveAt": "2026-10-29T14:30:00.000Z",
  "orders": { "total": 7, "pending": 2, "paid": 2, "out_for_delivery": 1, "delivered": 1, "cancelled": 1, "lastOrderAt": "2026-10-29T13:40:00.000Z" },
  "menus": [
    { "id": "6710b2d3e4b0a1b2c3d4e5f7", "title": "This week", "status": "open", "itemCount": 6, "cutoffAt": "2026-10-31T17:00:00.000Z", "openedAt": "2026-10-28T08:00:00.000Z", "closedAt": null, "createdAt": "2026-10-27T20:00:00.000Z" }
  ]
}
```

Errors: `404 SELLER_NOT_FOUND` (unknown or malformed id).

### PATCH /api/admin/sellers/:id/suspend, /deactivate, /reinstate

Changes the account status. **Nothing is deleted**: menus, orders and the profile
stay, and reinstating restores everything. What a blocked seller experiences is in
"Suspended and deactivated sellers" above. Suspend and deactivate need a reason
(3 to 300 characters); reinstate takes an optional one.

```
PATCH /api/admin/sellers/6710a1c2e4b0a1b2c3d4e5f6/suspend
Authorization: Bearer <admin token>
Content-Type: application/json
```

```json
{ "reason": "Repeated fake orders" }
```

Response `200`: the seller object, e.g. `"status": "suspended"`,
`"statusReason": "Repeated fake orders"`, `statusChangedAt` set. Reinstating
returns `"status": "active"` and clears the reason (or stores the new one).

- Safe to repeat: asking for the status the seller already has returns the seller
  unchanged and adds no audit entry.
- Every change is recorded in the audit trail (admin, action, seller, reason)
  **before** it is applied. If the record cannot be saved the seller is left
  unchanged and the request fails with `500`.

Errors: `400 VALIDATION_ERROR` (missing or too short reason), `404 SELLER_NOT_FOUND`.

### GET /api/admin/orders

Orders across all sellers, newest first. Filters (all optional, combine freely):

| Query | Meaning |
|---|---|
| `ref` | Exact reference or its first characters (`CL-7K`), any case |
| `sellerId` | One seller's id |
| `from`, `to` | Calendar days `YYYY-MM-DD` in Lagos time, both included |
| `status` | One or more of `pending,paid,out_for_delivery,delivered,cancelled` (comma list or repeated). Not `all` |
| `flag` | `duplicate` (possible duplicate), `cancelled`, or `failed` |
| `page`, `limit` | Default 20, at most 100 |

`flag=failed` means **placed but never paid, and the menu's cut-off has passed**.
An order that could not be placed at all (sold out, closed...) never becomes an
order; those are in the event log (`GET /api/admin/events`) and counted by `GET /api/admin/health`.

```
GET /api/admin/orders?sellerId=6710a1c2e4b0a1b2c3d4e5f6&flag=failed&from=2026-10-01
Authorization: Bearer <admin token>
```

Response `200`:

```json
{
  "orders": [
    {
      "ref": "CL-7KQ2M",
      "status": "paid",
      "total": 7000,
      "portions": 2,
      "paymentStatus": "paid",
      "paymentConfirmedBy": "seller",
      "createdAt": "2026-10-28T19:00:00.000Z",
      "paidAt": "2026-10-28T20:10:00.000Z",
      "seller": { "id": "6710a1c2e4b0a1b2c3d4e5f6", "businessName": "Mama T Kitchen", "slug": "mama-t" },
      "menu": { "id": "6710b2d3e4b0a1b2c3d4e5f7", "title": "This week", "cutoffAt": "2026-10-31T17:00:00.000Z" },
      "customer": { "name": "Ada Obi", "phone": "0803****567" },
      "delivery": { "area": "Yaba", "day": "2026-10-31" },
      "flags": { "possibleDuplicate": false, "cancelled": false, "failed": false }
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

- `paymentStatus` is `unpaid`, `paid` or `paid_then_cancelled` (a refund may be
  owed). It is **confirmed by the seller** (`paymentConfirmedBy`); ChopList does not
  see the bank transfer.
- Phone numbers are masked. The delivery address, notes, delivery codes and access
  keys are never in a list.

Errors: `400 VALIDATION_ERROR` (bad filter, `from` after `to`, `limit` over 100).

### GET /api/admin/orders/:ref

One order. By default the phone is masked and the address and note are left out.

```
GET /api/admin/orders/CL-7KQ2M?reveal=true
Authorization: Bearer <admin token>
```

`reveal=true` adds the full phone number, the delivery address and the note.
**Every reveal is written to the audit trail first**; if that fails nothing private
is returned. `reveal` must be exactly `true` or `false`.

Response `200` (abridged):

```json
{
  "ref": "CL-7KQ2M",
  "status": "out_for_delivery",
  "total": 7000,
  "paymentStatus": "paid",
  "paymentConfirmedBy": "seller",
  "lines": [{ "name": "Jollof rice", "unitPrice": 3500, "qty": 2 }],
  "customer": { "name": "Ada Obi", "phone": "+2348031234567" },
  "delivery": { "area": "Yaba", "day": "2026-10-31", "address": "12 Herbert Macaulay Way, Yaba" },
  "note": "Extra pepper",
  "revealed": true,
  "timeline": { "createdAt": "2026-10-28T19:00:00.000Z", "paidAt": "2026-10-28T20:10:00.000Z", "outForDeliveryAt": "2026-10-31T09:00:00.000Z", "deliveredAt": null, "cancelledAt": null },
  "flags": { "possibleDuplicate": false, "cancelled": false, "failed": false },
  "similarOrders": [{ "ref": "CL-7KQ2N", "status": "pending", "createdAt": "2026-10-28T19:02:00.000Z" }]
}
```

`similarOrders` lists (by reference only) other orders with the same customer,
menu and items within 10 minutes. Without `reveal=true`, `customer.phone` is
masked and `delivery.address` and `note` are absent. The delivery code is never
included.

Errors: `400 VALIDATION_ERROR` (bad `reveal`), `404 ORDER_NOT_FOUND`.

### GET /api/admin/analytics/menus

Menu views, orders and conversion, grouped by seller. Optional `?from=` and `?to=`
(calendar days `YYYY-MM-DD` in Lagos time, both included), `?page=`, `?limit=`
(sellers per page, default 20, at most 100). Without dates it covers all time.

```
GET /api/admin/analytics/menus?from=2026-10-01&to=2026-10-31
Authorization: Bearer <admin token>
```

Response `200`:

```json
{
  "range": { "from": "2026-10-01", "to": "2026-10-31" },
  "totals": { "views": 75, "orders": 17, "conversion": 0.2267 },
  "sellers": [
    {
      "seller": { "id": "6710a1c2e4b0a1b2c3d4e5f6", "businessName": "Mama T Kitchen", "slug": "mama-t" },
      "views": 65,
      "orders": 11,
      "conversion": 0.1692,
      "menus": [
        { "id": "6710b2d3e4b0a1b2c3d4e5f7", "title": "This week", "status": "open", "views": 60, "orders": 10, "conversion": 0.1667 }
      ]
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 },
  "definitions": { "views": "...", "orders": "...", "conversion": "..." }
}
```

- Sellers are listed busiest first (most orders); a seller's menus likewise. Menus
  with no views and no orders in the period are left out. `totals` cover every
  seller, not only the page.
- `orders` counts every order **placed** on the menu in the period, including ones
  later cancelled.
- `conversion` is `orders / views` as a fraction (0.1667 = 16.7%). **It is an
  indicator, not an exact rate**: views are page loads, not unique visitors, and
  can be inflated, so it can exceed 1. It is `null` when there were no views.

Errors: `400 VALIDATION_ERROR` (bad date, `from` after `to`, bad `page`/`limit`).

### GET /api/admin/analytics/items

The most frequently ordered items, by portions. Optional `?from=`, `?to=`,
`?sellerId=`, `?page=`, `?limit=`.

```
GET /api/admin/analytics/items?from=2026-10-01&limit=10
Authorization: Bearer <admin token>
```

Response `200`:

```json
{
  "range": { "from": "2026-10-01", "to": null },
  "sellerId": null,
  "items": [
    { "name": "Jollof rice", "portions": 9, "orders": 3, "revenue": 29500, "sellers": 2 }
  ],
  "pagination": { "page": 1, "limit": 10, "total": 3, "totalPages": 1 },
  "definitions": { "items": "..." }
}
```

- Items are matched on the **lower-cased, trimmed name**, so `Jollof rice` and
  `  jollof RICE ` are one item, including across different sellers' menus.
  `sellers` says how many sellers sold it. The name shown is the first spelling met.
- Cancelled orders are not counted (their portions went back on sale). Pending and
  paid orders are.
- `revenue` is the sum of price times portions as ordered, in naira. The seller
  confirms payment, so this is value ordered, not money received.

Errors: `400 VALIDATION_ERROR` (bad date, `sellerId`, `page`/`limit`).

### GET /api/admin/analytics/customers

New versus returning customers. Optional `?from=`, `?to=`.

```
GET /api/admin/analytics/customers?from=2026-10-12&to=2026-10-31
Authorization: Bearer <admin token>
```

Response `200`:

```json
{
  "range": { "from": "2026-10-12", "to": "2026-10-31" },
  "customers": { "total": 3, "new": 1, "returning": 2, "returningRate": 0.6667 },
  "orders": { "total": 3, "firstOrders": 1, "repeatOrders": 2, "repeatRate": 0.6667 },
  "definitions": { "customers": "...", "newCustomer": "...", "returningCustomer": "...", "repeatOrder": "..." }
}
```

**This is approximate.** A customer is identified only by their phone number, in
its normalised form (`0803 123 4567` and `+234 803 123 4567` are the same
customer).

- One person with two phone numbers counts as two customers; two people sharing a
  phone count as one.
- A customer is **new** in the period if their very first order is in it, and
  **returning** if they ordered in the period and also had an earlier order. Over
  all time (no dates) nobody can be returning, so read `repeatOrders` instead: an
  order from someone who had already ordered before.
- Cancelled orders are ignored everywhere, so cancelling does not make someone
  "returning".
- No phone numbers or names are returned, only counts.

Errors: `400 VALIDATION_ERROR` (bad date, `from` after `to`).

### GET /api/admin/health

Counts for the last 24 hours, for the "is anything wrong?" panel.

```
GET /api/admin/health
Authorization: Bearer <admin token>
```

Response `200`:

```json
{
  "generatedAt": "2026-10-29T15:30:00.000Z",
  "window": { "hours": 24, "since": "2026-10-28T15:30:00.000Z" },
  "database": "connected",
  "failedSubmissions": { "total": 3, "byCode": { "SOLD_OUT": 2, "ORDERING_CLOSED": 1 } },
  "serverErrors": 2,
  "notificationFailures": 0,
  "openReports": 2,
  "reportsLast24h": 2,
  "definitions": { "failedSubmissions": "...", "serverErrors": "...", "notificationFailures": "...", "openReports": "..." }
}
```

- `failedSubmissions` are orders customers tried to place but that were refused
  (sold out, ordering closed, wrong area or day, invalid form). They never became
  orders, so they are not in the orders list. `byCode` breaks them down by error code.
- `serverErrors` are unexpected `500` responses (menu or checkout errors included).
- **`notificationFailures` is always `0` for now.** Nothing sends notifications yet.
  `0` means "nothing is reporting", not "nothing is failing". It starts counting when
  the notification feature calls the logger.
- `openReports` is every unresolved "my order is missing" report, all time; the other
  counts cover the last 24 hours.

### GET /api/admin/events

The troubleshooting log, newest first. Optional `?type=` (`order_failed`,
`server_error`, `notification_failed`, `missing_order_report`), `?level=`
(`info`, `warn`, `error`), `?sellerId=`, `?from=` and `?to=` (calendar days in Lagos
time, both included), `?page=`, `?limit=` (default 20, at most 100).

```
GET /api/admin/events?type=order_failed&from=2026-10-29
Authorization: Bearer <admin token>
```

Response `200`:

```json
{
  "events": [
    {
      "id": "6720c3e4e4b0a1b2c3d4e5fa",
      "type": "order_failed",
      "level": "warn",
      "code": "SOLD_OUT",
      "message": "An order was refused: SOLD_OUT",
      "sellerId": "6710a1c2e4b0a1b2c3d4e5f6",
      "menuId": "6710b2d3e4b0a1b2c3d4e5f7",
      "orderRef": null,
      "meta": {},
      "createdAt": "2026-10-29T14:02:11.000Z"
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

Events hold an error code, the menu and seller, and small facts (for example the
route of a server error). They never hold a phone number, name, address, message text,
delivery code or key. Events are deleted automatically after 60 days.

Errors: `400 VALIDATION_ERROR` (unknown `type` or `level`, bad id or date, `limit` over 100).

### GET /api/admin/reports

Customers' "my order is missing" reports. Open ones first (newest first), then
resolved ones. Optional `?status=open|resolved`, `?page=`, `?limit=`.

```
GET /api/admin/reports?status=open
Authorization: Bearer <admin token>
```

Response `200`:

```json
{
  "reports": [
    {
      "id": "6720d4f5e4b0a1b2c3d4e5fb",
      "status": "open",
      "createdAt": "2026-10-29T15:01:00.000Z",
      "ref": "CL-7KQ2M",
      "phoneLast4": "4567",
      "menuSlug": "mama-ts-kitchen",
      "message": "I transferred at 3pm and nothing has come.",
      "seller": { "id": "6710a1c2e4b0a1b2c3d4e5f6", "businessName": "Mama T Kitchen", "slug": "mama-ts-kitchen" },
      "orderFound": true,
      "matchedOrderRef": "CL-7KQ2M",
      "resolvedBy": null,
      "resolvedAt": null,
      "resolutionNote": null
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

`orderFound` and `matchedOrderRef` are what the system found when the report arrived
(the customer is never told). `matchedOrderRef` is set only when exactly one order
matched; look it up with `GET /api/admin/orders/:ref`. Only the last 4 digits of a
phone number are ever stored.

Errors: `400 VALIDATION_ERROR` (bad `status`, `page` or `limit`).

### PATCH /api/admin/reports/:id/resolve

Marks a report resolved. Optional body `{ "note": "..." }` (up to 300 characters)
saying what was done.

```
PATCH /api/admin/reports/6720d4f5e4b0a1b2c3d4e5fb/resolve
Authorization: Bearer <admin token>
Content-Type: application/json
```

```json
{ "note": "Seller confirmed it was delivered" }
```

Response `200`: the report, now `"status": "resolved"` with `resolvedBy`, `resolvedAt`
and `resolutionNote` set.

- Safe to repeat: resolving a resolved report returns it unchanged (the first
  resolver and time are kept) and adds no audit entry.
- The action is written to the audit trail **before** it is applied; if that fails,
  the report stays open and the request fails with `500`.

Errors: `400 VALIDATION_ERROR` (note too long), `404 REPORT_NOT_FOUND`.

### GET /api/admin/audit

The audit trail: who did what to what, and why. An entry is written for every admin
action that changes data or reveals private data: suspending, deactivating or
reinstating a seller, revealing an order's phone number and address, and resolving a
report. Newest first. Optional filters `?adminId=`, `?action=`, `?targetId=`,
`?from=` and `?to=` (calendar days in Lagos time, both included), `?page=`,
`?limit=` (default 20, at most 100).

```
GET /api/admin/audit?action=order.reveal_phone&from=2026-10-29
Authorization: Bearer <admin token>
```

Response `200`:

```json
{
  "entries": [
    {
      "id": "6720e5a6e4b0a1b2c3d4e5fc",
      "at": "2026-10-29T15:40:12.000Z",
      "adminId": "user_2abcDEF",
      "action": "seller.suspend",
      "targetType": "seller",
      "targetId": "6710a1c2e4b0a1b2c3d4e5f6",
      "targetLabel": "Mama T Kitchen",
      "reason": "Repeated fake orders"
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

- `action` is one of `seller.suspend`, `seller.deactivate`, `seller.reinstate`,
  `order.reveal_phone`, `report.resolve`.
- `targetType` is `seller`, `order` or `report`. `targetId` is a seller id, an order
  reference or a report id. `targetLabel` is the seller's business name for seller
  actions (`null` if that seller no longer exists), the reference for orders, and
  `null` for reports.
- `adminId` is the admin's Clerk user id. Names are not looked up.
- `reason` is what the admin typed (the suspension reason, or the note on a report);
  `null` for a reveal.
- The trail never holds the phone number, address or note that was revealed, only
  the fact that it was.
- It is read-only: there is no way to add, edit or delete entries through the API,
  and reading it is not itself recorded. Entries are never deleted automatically.

Errors: `400 VALIDATION_ERROR` (unknown `action`, bad date, `from` after `to`,
`limit` over 100).

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

Order status: **pending -> paid -> out_for_delivery -> delivered**, and
**cancelled** from any of them except `delivered`. The five values are exactly
`pending`, `paid`, `out_for_delivery`, `delivered`, `cancelled` (underscores).
Cancelling puts the order's portions back on sale. An order is paid in one of two
ways, shown by `paymentMethod`: **`transfer`** (the customer pays the seller's bank
and the seller marks it paid by hand) or **`paystack`** (the customer paid online and
the order was marked paid automatically when Paystack confirmed; Paystack settles the
money straight to the seller's bank). ChopList never holds the money in either case.

Delivery confirmation: when the order goes out for delivery the server makes a
6-digit code that only the customer can see (on their order page). The rider
asks for it at the door and the seller enters it to mark the order delivered.

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
  "paymentMethod": "transfer",
  "paidAt": null,
  "cancelledAt": null,
  "outForDeliveryAt": null,
  "deliveredAt": null,
  "createdAt": "2026-10-09T21:25:46.870Z"
}
```

The delivery code is never part of this object, in any seller route. Nor is anything
about fees, the customer's service fee, or Paystack: the seller sees `total` and
`paymentMethod`. `paymentMethod` is new; orders from before Paystack are `"transfer"`.

### GET /api/menus/:id/orders

All orders for one of the seller's menus, newest first. Optional `?status=`
with any of `pending`, `paid`, `out_for_delivery`, `delivered`, `cancelled`:

- several at once, comma separated (`?status=paid,out_for_delivery`) or repeated
  (`?status=paid&status=delivered`);
- empty or missing means no filter. There is no `all` value: leave `status` out;
- statuses use **underscores**. `out-for-delivery` and `all` are a
  `400 VALIDATION_ERROR` that lists the valid ones.

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

Marks a pending order paid. No body. Safe to repeat: an order that is already
paid, out for delivery or delivered is returned unchanged (same `paidAt`; its
status is never moved back).

```
PATCH /api/orders/CL-7KQ2M/paid
Authorization: Bearer <token>
```

Response `200`: the seller order object, `status: "paid"`, `paidAt` set.

Errors: `404 ORDER_NOT_FOUND`, `409 ORDER_CANCELLED`.

### PATCH /api/orders/:ref/cancel

Cancels a pending, paid or out-for-delivery order and puts its portions back on
sale (also after the menu has closed). Cancelling in transit also destroys the
delivery code. No body. Safe to repeat: the stock comes back exactly once, even
if several cancel requests arrive together. Refunding a paid order is done by the
seller outside ChopList. A **delivered** order cannot be cancelled and its stock
is not returned.

```
PATCH /api/orders/CL-7KQ2M/cancel
Authorization: Bearer <token>
```

Response `200`: the seller order object, `status: "cancelled"`, `cancelledAt` set.

Errors: `404 ORDER_NOT_FOUND`, `409 ORDER_DELIVERED`.

### PATCH /api/orders/:ref/out-for-delivery

The rider is leaving: `paid` -> `out_for_delivery`. No body. This creates the
6-digit delivery code, which only the customer can see. Safe to repeat: an order
already out for delivery is returned unchanged and keeps its code.

```
PATCH /api/orders/CL-7KQ2M/out-for-delivery
Authorization: Bearer <token>
```

Response `200`: the seller order object, `status: "out_for_delivery"`,
`outForDeliveryAt` set. There is no code in it.

Errors: `404 ORDER_NOT_FOUND`, `409 ORDER_NOT_PAID` (pay it first),
`409 ORDER_DELIVERED`, `409 ORDER_CANCELLED`.

### PATCH /api/orders/:ref/confirm-delivery

At the door the customer reads out their code; the seller sends it here.

```
PATCH /api/orders/CL-7KQ2M/confirm-delivery
Authorization: Bearer <token>
Content-Type: application/json
```

```json
{ "code": "482915" }
```

`code` must be a **string of exactly 6 digits** (leading zeros matter:
`"012345"`). Anything else is a `400 VALIDATION_ERROR` and is not counted as a
guess.

Response `200`: the seller order object, `status: "delivered"`, `deliveredAt`
set; the code is gone. Safe to repeat: confirming an already delivered order
returns it unchanged.

A wrong code is `400 INVALID_DELIVERY_CODE`, and the message says how many
attempts are left (`"That code is not correct. 3 attempts left."`). After **5**
wrong codes the order is locked: even the correct code is refused with
`409 DELIVERY_CODE_LOCKED` until the seller resets it.

Errors: `400 VALIDATION_ERROR`, `400 INVALID_DELIVERY_CODE`, `404 ORDER_NOT_FOUND`,
`409 DELIVERY_CODE_LOCKED`, `409 ORDER_NOT_OUT_FOR_DELIVERY` (pending or paid),
`409 ORDER_CANCELLED`.

### PATCH /api/orders/:ref/reset-delivery-code

Makes a new code (always different from the old one) and gives 5 fresh attempts.
For a lost code or a locked order. No body. Only while the order is out for
delivery, and **at most 2 times per order**.

```
PATCH /api/orders/CL-7KQ2M/reset-delivery-code
Authorization: Bearer <token>
```

Response `200`: the seller order object (still `out_for_delivery`, no code in
it). The customer's page shows the new code.

Errors: `404 ORDER_NOT_FOUND`, `409 ORDER_NOT_OUT_FOR_DELIVERY`,
`409 DELIVERY_RESET_LIMIT` (a third reset; the seller should contact support).

## Reports (seller)

Both are worked out from the orders on every request, so they are always up to
date (nothing is stored). Cancelled orders never count. `paidOnly=true` leaves
out unpaid orders (it keeps `paid`, `out_for_delivery` and, on the prep sheet,
`delivered`); the value must be exactly `true` or `false`.

- **Prep sheet:** counts every order that is not cancelled, delivered ones
  included (the food was still cooked).
- **Delivery list:** only orders still to deliver: `pending`, `paid` and
  `out_for_delivery`. Delivered orders drop off the list.

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
| `POST /api/public/menu/:slug/view` | 120 per 10 minutes |
| `POST /api/public/orders/report-missing` | 5 per 10 minutes |

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

### POST /api/public/menu/:slug/view

Tells the server that a customer opened this shop's menu, so admins can see how
many people look at a menu compared with how many order. Call it once per visit,
**after** the menu loaded (the shop page does this once per browser session per
shop, so a refresh does not count again). No body.

```
POST /api/public/menu/mama-ts-kitchen/view
```

Response `204 No Content`, with nothing in the body. The page should not wait for
it or show anything if it fails.

- Only an **open** menu is counted. A shop with no open menu still answers `204`
  and counts nothing.
- It is a `POST` on purpose: link previews, crawlers and browsers that prefetch
  only `GET`, so they do not inflate the numbers.
- A counter per menu per day is kept (Lagos days). Nothing about the visitor is
  stored: no address, device or phone number.
- These are **page loads, not unique visitors**. A returning visitor or a bot counts
  again, so the numbers are an indicator.
- A failed write is not reported to the page (still `204`), because a counter
  must never break a customer's page.

Errors: `404 SELLER_NOT_FOUND` (unknown or suspended shop), `429 RATE_LIMITED`.

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
    "deliveryCode": null,
    "deliveryCodeHidden": false,
    "outForDeliveryAt": null,
    "deliveredAt": null,
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
  "seller": { "businessName": "Mama T's Kitchen", "slug": "mama-ts-kitchen", "phone": "+2348031234567" },
  "accessKey": "k3J9x0Qm1ZbT7yVd2WnR4uLpA8sCfHeG"
}
```

Show the customer `payment.instructions` and the reference prominently. The order
stays `pending` until the seller marks it paid.

`accessKey` is a secret for this one order, returned **only in this response**.
The server keeps just a hash, so it cannot be shown again. The frontend must
store it (with the reference) and send it as `X-Order-Key` when looking the order
up; it is what lets the customer, and not the seller, see the delivery code.

Errors: `400 VALIDATION_ERROR`, `400 ITEM_NOT_FOUND`, `400 INVALID_AREA`,
`400 INVALID_DELIVERY_DAY`, `404 MENU_NOT_FOUND`, `409 ORDERING_CLOSED`,
`409 SOLD_OUT` (nothing was taken; the message says what is left),
`429 RATE_LIMITED`.

### POST /api/public/orders/report-missing

A customer says their order is missing (they paid and nothing arrived, or the order
never showed up). No sign-in. Send **either** the order reference **or** the last 4
digits of the phone number they ordered with (or both).

```
POST /api/public/orders/report-missing
Content-Type: application/json
```

```json
{
  "ref": "CL-7KQ2M",
  "phoneLast4": "4567",
  "menuSlug": "mama-ts-kitchen",
  "message": "I transferred at 3pm and nothing has come."
}
```

- `ref` (optional if `phoneLast4` is given): any case.
- `phoneLast4` (optional if `ref` is given): **exactly 4 digits**. A whole phone number
  is rejected, so one can never be stored.
- `menuSlug` (optional): the shop link they ordered from. It only narrows the search.
  An unknown link is not an error.
- `message`: 5 to 500 characters. Empty strings for the optional fields count as
  "not given".

Response `201`:

```json
{ "received": true }
```

**The answer is always the same**, whether or not an order was found. Telling the
customer would let anyone test which references exist. The system records the result
privately for the admin (`orderFound`, and the matching reference when exactly one
order matches). With only the last 4 digits it searches orders from the last 7
days (30 days with a shop link). Reports show up on the admin support page and in the
health counts.

Rate limited to 5 per 10 minutes per network.

Errors: `400 VALIDATION_ERROR` (neither reference nor digits, digits not exactly 4,
message too short or long), `429 RATE_LIMITED`.

### GET /api/public/orders/:ref?phoneLast4=1234

Lets a customer check their order. Needs the reference **and** the last 4 digits
of the phone number used to order. The reference is not case-sensitive.

```
GET /api/public/orders/CL-7KQ2M?phoneLast4=2222
X-Order-Key: <the accessKey from POST /api/public/orders>
```

`X-Order-Key` is optional, but without it the customer never sees the delivery
code (see below). Send it as a header, not in the URL.

Response `200`: same body as `POST /api/public/orders` (`order`, `payment`,
`seller`) but without `accessKey`. The delivery address and full phone number are
never returned. While the order is out for delivery:

```json
{
  "order": {
    "ref": "CL-7KQ2M",
    "status": "out_for_delivery",
    "deliveryCode": "482915",
    "deliveryCodeHidden": false,
    "outForDeliveryAt": "2026-10-17T09:12:00.000Z",
    "deliveredAt": null,
    "...": "other order fields as above"
  },
  "payment": { "...": "as above" },
  "seller": { "...": "as above" }
}
```

`deliveryCode` is a 6-digit string and is `null` in every other status. It is
also `null` when `X-Order-Key` is missing or wrong; then, if the order is out for
delivery, `deliveryCodeHidden` is `true` (otherwise `false`). So
`deliveryCodeHidden: true` means "the code exists but this request did not prove
it comes from the customer", **not** that something is broken. The seller cannot
read the code anywhere: it is not in any seller response.

The frontend keeps the key in `localStorage` (`frontend/src/lib/order-keys.js`),
saved from the `POST /api/public/orders` response and sent by `lookupOrder`. So
the code shows on the browser that placed the order. On another device, or after
the browser data is cleared, the key is gone and the page shows
`deliveryCodeHidden`.

**Orders that cannot show a code.** Orders placed before keys existed have no
key, so no browser can ever show their code; the same applies to a customer who
lost their key. There is deliberately no way for a seller to issue a new key (a
seller could use it to read the code). The safe handling is manual: cancel the
order and have the customer reorder, or the seller marks it delivered by phone.
`npm run audit:delivery` (in `backend/`) lists out-for-delivery orders with no
code or no key, by reference only. It is read-only.

Errors: `400 VALIDATION_ERROR` (`phoneLast4` missing or not 4 digits),
`404 ORDER_NOT_FOUND` (wrong reference or wrong digits, same error for both),
`429 RATE_LIMITED`.

### POST /api/public/orders/:ref/pay

Starts paying an order online with Paystack. Needs the order's access key (the
`accessKey` from `POST /api/public/orders`) in the `X-Order-Key` header: the reference
and phone digits are also known to the seller, so they are not enough. No body.

```
POST /api/public/orders/CL-7KQ2M/pay
X-Order-Key: <the accessKey saved when the order was placed>
```

Response `200`:

```json
{
  "authorizationUrl": "https://checkout.paystack.com/abc123xyz",
  "reference": "CLP-9f2c4e8a1b7d3f6054a8c2e1",
  "serviceFee": 216,
  "total": 7716
}
```

- `total` is **everything the customer pays**: the order total plus `serviceFee`.
  `serviceFee` is `0` when the seller pays the fees. Show both before sending the
  customer on ("Order ₦7,500 + service fee ₦216 = ₦7,716"). The quote exists as soon
  as this call returns, so a confirmation screen with a "Continue to Paystack" button
  is fine: nothing is charged until the customer pays on Paystack.
- Send the customer's browser to `authorizationUrl` (`window.location.assign`).
  It is always a `https://…paystack.com` address; the server refuses anything else.
- `reference` identifies this payment attempt. **Save the order reference and this
  `reference` in `localStorage` before redirecting.** Paystack sends the customer back
  to the server's `PAYSTACK_CALLBACK_URL` with `?reference=…&trxref=…` (its reference,
  not the order's), so the page needs the saved order reference to know which order to
  check.
- **Coming back from Paystack proves nothing.** The customer can reach that page without
  paying, or never come back after paying. The order is marked paid only when Paystack
  confirms to the server (the webhook). Always confirm with
  `GET /api/public/orders/:ref/payment-status`.
- Every call starts a **new** attempt with a new `reference`; calling it twice does not
  charge twice, but an earlier attempt can still be completed on Paystack's page. If a
  customer ends up paying two attempts, only the first counts and the second is flagged
  for a refund by hand. So: disable the button once pressed, and do not call this on
  every page load.
- The order is not touched by this call; it stays `pending` until payment is confirmed.
- Rate limit: 15 per network per 10 minutes (`429 RATE_LIMITED`).

Errors: `404 ORDER_NOT_FOUND` (wrong key, missing key, unknown or malformed reference:
all the same answer), `409 ORDER_CANCELLED`, `409 ORDER_ALREADY_PAID`,
`409 PAYMENTS_NOT_READY` (this seller takes bank transfer only; show the transfer
instructions), `503 PAYMENTS_UNAVAILABLE` (Paystack is down or payments are off; show
the transfer instructions and a retry), `429 RATE_LIMITED`.

### GET /api/public/orders/:ref/payment-status

Where an order stands on payment: for the page the customer lands on after Paystack,
which polls it until it says `paid`. Same `X-Order-Key` rule as `/pay`, and the same
`404 ORDER_NOT_FOUND` for every way of being wrong. Read-only: it never calls Paystack
and never changes anything. The response is never cached (`Cache-Control: no-store`).

```
GET /api/public/orders/CL-7KQ2M/payment-status
X-Order-Key: <the accessKey saved when the order was placed>
```

Response `200`:

```json
{
  "ref": "CL-7KQ2M",
  "orderStatus": "paid",
  "paymentMethod": "paystack",
  "state": "paid",
  "paid": true,
  "total": 7500,
  "serviceFee": 216,
  "amountCharged": 7716,
  "reference": "CLP-9f2c4e8a1b7d3f6054a8c2e1",
  "paidAt": "2026-10-16T10:03:21.000Z",
  "onlinePaymentAvailable": true
}
```

| `state` | Meaning | What the page does |
| ------- | ------- | ------------------ |
| `not_started` | No online payment has been started | Show "Pay online" (if `onlinePaymentAvailable`) and the bank transfer instructions |
| `awaiting_payment` | A payment was started and Paystack has not confirmed it | Keep polling. If the customer left Paystack without paying, offer "Try again" |
| `paid` | The order is paid; `paymentMethod` says how | Stop polling. Show the confirmation |
| `under_review` | The customer's money arrived but the order could not be completed (for example the seller cancelled it first) | Stop polling. Say ChopList is sorting it out and to contact the seller. Do not tell them to pay again |
| `cancelled` | Cancelled, and nothing was taken | Stop polling. Say it was cancelled |

- `serviceFee`, `amountCharged` and `reference` come from the attempt being described
  and are `null` before any online attempt, and for orders paid by bank transfer.
  `amountCharged` is the whole amount the customer paid, in naira.
- `onlinePaymentAvailable` is `true` only when the server has payments switched on and
  the seller is active and set up. Use it to decide whether to show the Pay button.
- **Polling:** every 3 seconds for the first 30 seconds, then every 10 seconds, and stop
  after about 5 minutes with "If you have been charged, we will confirm your order
  shortly" (the confirmation can arrive late; the next visit to this page will show it).
  The limit is 300 requests per network per 10 minutes.
- The response never contains fees taken by ChopList or Paystack, the seller's identity,
  or anything about their payout account.

Errors: `404 ORDER_NOT_FOUND`, `429 RATE_LIMITED`.

## Paystack webhook

`POST /api/webhooks/paystack` is called by **Paystack's servers**, never by the
frontend. It is how an online payment becomes a paid order. Set this address as the
webhook URL in the Paystack dashboard (see [paystack-setup.md](paystack-setup.md)):
`https://api.choplistafrica.com/api/webhooks/paystack`.

- **Signature.** Paystack signs every request body with the account's secret key
  (HMAC-SHA512, hex, in the `x-paystack-signature` header). The server checks it
  against the exact bytes received, before reading anything else. A missing or wrong
  signature is `401 INVALID_SIGNATURE` and nothing is changed. This route reads the
  body raw (limit 100 KB); every other route reads JSON normally.
- **Only `charge.success` does anything.** Any other event, a body that is not JSON, or
  a reference that is not ChopList's, is acknowledged with `200 {"received": true}` and
  ignored (an error status would only make Paystack resend the same thing).
- **The webhook only names the payment.** The server then asks Paystack directly for
  that payment and checks that it succeeded, that the reference matches, and that the
  amount and currency are exactly what ChopList asked for. Amounts in the webhook body
  are never used.
- **Then, once:** the payment is recorded as succeeded, the order is marked `paid` with
  `paymentMethod: "paystack"` (and keeps the fee figures of the attempt that was paid),
  and the seller's paid-order count goes up by one. Each of these is a conditional
  write that only one request can win, so repeats, simultaneous deliveries and two
  deliveries racing all count the payment exactly once.

| Situation | Response | Result |
| --------- | -------- | ------ |
| Good payment | `200` | Order paid, counted once |
| Same event again (Paystack retries) | `200` | Nothing changes |
| Wrong signature or none | `401 INVALID_SIGNATURE` | Nothing changes |
| Unknown event, bad body, foreign reference | `200` | Ignored |
| Reference not in ChopList's records | `200` | Logged (`UNKNOWN_REFERENCE`) |
| Paystack does not confirm it succeeded | `200` | Logged (`NOT_CONFIRMED`); can still succeed later |
| Wrong amount or currency | `200` | Payment set aside as `needs_review`; order stays unpaid (`AMOUNT_MISMATCH`) |
| Customer paid the same order twice | `200` | First counts; the second is `needs_review` (`DUPLICATE_PAYMENT`) |
| Order cancelled, or already paid by transfer | `200` | Payment set aside as `needs_review`; order unchanged; count not touched (`ORDER_NOT_PAYABLE`) |
| Paystack cannot be reached to verify | `503` | Nothing changes; Paystack resends later |
| Server bug or database failure | `500` | Nothing is lost; Paystack resends |
| No Paystack key on the server | `503` | Nothing is accepted |

Every row marked `needs_review` means **the customer's money is with Paystack and a
person must refund it (or reinstate the order)**. There is no automated refund. These
show in `paymentsNeedingReview` on the admin overview and as `payment_webhook_issue`
events on `GET /api/admin/events` (codes above, with the order reference and amounts,
never customer or bank details).

## Online payments (Paystack)

**ChopList does not hold customer money.** Each seller has a Paystack "subaccount"
pointing at their bank account. When a customer pays, Paystack splits the payment
itself: ChopList's share (if any) stays with ChopList's Paystack account and the rest
is settled to the seller's bank by Paystack. There is no wallet, no balance and no
payout code in ChopList. Bank transfer keeps working for every order.

### What a payment costs

- **Free orders.** A seller's first **50** orders paid through Paystack carry no
  ChopList fee (setting `FREE_ORDERS`). Orders paid by bank transfer do not count.
- **After that**, ChopList charges **3%** of the order amount (setting
  `PLATFORM_FEE_BPS`, in basis points: 300 = 3%). The fee is on the order, not on the
  service fee.
- **Paystack's own charge** is separate: about **1.5% + ₦100 per payment, capped at
  ₦2,000**. These figures are ChopList's copy of Paystack's published price (see
  `PAYSTACK_PRICING` in `backend/src/config.ts`) and **must be re-checked against
  https://paystack.com/pricing before going live and whenever Paystack changes it.** If
  they are wrong the customer is quoted the wrong service fee, or ChopList covers the
  gap.
- **Who pays the card fees** is the seller's setting (`feeMode`), never the customer's
  choice:
  - `customer` (the default): a **service fee** is added to the customer's total,
    worked out so the seller still receives the **full order amount**. The fee covers
    Paystack's charge and ChopList's fee, so it is larger once the free orders are used.
  - `seller`: the customer pays exactly the order amount. ChopList's fee and Paystack's
    charge come out of what the seller receives.
- The tier is decided when the payment is started, from the seller's paid-order count
  at that moment, and **frozen on the order**. Changing `FREE_ORDERS`,
  `PLATFORM_FEE_BPS` or the seller's `feeMode` later never re-prices a payment already
  started.
- The platform fee shown below is what ChopList keeps. The "Paystack charge" is an
  **estimate** from the constants above; the real charge is Paystack's.

### Worked examples

All amounts are naira. "Free" is a seller's first 50 paid orders; "3%" is from the 51st.
These figures are produced by the same calculator the server uses.

**₦7,500 order**

| Fee mode | Tier | Customer pays | Service fee | ChopList fee | Paystack charge (est.) | Seller receives |
| -------- | ---- | ------------- | ----------- | ------------ | ---------------------- | --------------- |
| customer | free | 7,716 | 216 | 0 | 215.74 | 7,500 |
| customer | 3% | 7,945 | 445 | 225 | 219.18 | 7,500 |
| seller | free | 7,500 | 0 | 0 | 212.50 | 7,287.50 |
| seller | 3% | 7,500 | 0 | 225 | 212.50 | 7,062.50 |

**₦11,000 order**

| Fee mode | Tier | Customer pays | Service fee | ChopList fee | Paystack charge (est.) | Seller receives |
| -------- | ---- | ------------- | ----------- | ------------ | ---------------------- | --------------- |
| customer | free | 11,270 | 270 | 0 | 269.05 | 11,000 |
| customer | 3% | 11,605 | 605 | 330 | 274.08 | 11,000 |
| seller | free | 11,000 | 0 | 0 | 265.00 | 10,735 |
| seller | 3% | 11,000 | 0 | 330 | 265.00 | 10,405 |

In `customer` mode the service fee is rounded **up** to a whole naira so ChopList is
never short, so on the free tier ChopList keeps a few kobo. The ₦100 part of Paystack's
charge applies to every payment, so small orders carry a large percentage (a ₦2,000
order on the free tier has a ₦132 service fee).

### How the split is sent to Paystack

For each payment the server sends Paystack the seller's `subaccount`, a
`transaction_charge` (ChopList's share, in kobo) and a `bearer` (who Paystack takes its
own charge from). `customer` mode: `transaction_charge` is the whole service fee and the
bearer is ChopList's account; `seller` mode: `transaction_charge` is ChopList's fee
(omitted when 0) and the bearer is the seller's subaccount. Money is whole naira
everywhere in the API and database; kobo appears only in the call to Paystack.

## For the frontend team

What the frontend needs to build or change for online payments. The backend does not
touch `frontend/`; this is the list. Everything is optional in the sense that **bank
transfer keeps working unchanged**: until the frontend ships these, nothing breaks.

**Seller onboarding and settings**

1. Load the bank list with `GET /api/sellers/banks` and show a **bank dropdown** (name
   shown, `code` sent). Send the chosen `code` as `payment.bankCode` in
   `PUT /api/sellers/me`, together with `bankName` (the dropdown's name). If the list
   returns `503`, let the seller continue without a bank code.
2. Existing sellers have no bank code: show a prompt in their dashboard to pick their
   bank, and save with `PUT /api/sellers/me`.
3. Show `paymentsReady` and, when false, the `paymentsIssue` message (table under
   "Seller payments") with a **Retry** button calling `POST /api/sellers/me/payments/retry`.
4. A **fee mode setting** ("Who pays card fees?": customer or me) calling
   `PUT /api/sellers/me/fee-mode`, with a plain explanation of both (see "What a payment
   costs"). Show `freeOrdersRemaining` from `GET /api/sellers/me/payments` ("12 of your
   first 50 online orders left free").
5. Seller order cards can show `paymentMethod` ("Paid online" vs "Bank transfer"). An
   online-paid order is already `paid`; the seller should not expect a transfer for it.

**Customer order page**

6. After the order is placed, show the bank transfer instructions as today. If
   `onlinePaymentAvailable` (from `payment-status`) is true, also show **Pay online**.
7. Pay online: `POST /api/public/orders/:ref/pay`, show the breakdown (`total`,
   `serviceFee`), save the order ref and the returned `reference` in `localStorage`,
   then redirect to `authorizationUrl`.
8. A **return page** at the server's `PAYSTACK_CALLBACK_URL` (agree the route with the
   backend; it must be on an allowed origin). It reads the saved order ref and polls
   `payment-status` (see its polling guidance), then shows the right screen for each
   `state`. Do not trust the page being reached as proof of payment.
9. Handle `PAYMENTS_NOT_READY`, `PAYMENTS_UNAVAILABLE`, `ORDER_ALREADY_PAID` and
   `ORDER_CANCELLED` from `/pay` by falling back to the transfer instructions or the
   right message.

**Admin**

10. Show the `payments` and `funnel` blocks of `GET /api/admin/overview` with their
    `definitions`, and make `paymentsNeedingReview` hard to miss when above 0.

## Known limits and follow-ups

Not built, on purpose. Be upfront about these when presenting.

- **Real Paystack behaviour is untested.** All tests use a fake Paystack. The request and
  response shapes were written from Paystack's documented API and have not yet been run
  against Paystack's test mode, nor has the webhook signature been checked against a
  payload Paystack signed. Two behaviours need a manual test-mode check: whether a
  `transaction_charge` of 0 (free tier, `seller` mode) really means "no ChopList cut",
  and how bank lookups behave in test mode. Steps are in
  [paystack-setup.md](paystack-setup.md).
- **Test mode only until Paystack verifies the business** (live keys need it). The
  server accepts any `sk_` key, so use the test key until then.
- **No refunds.** A payment flagged `needs_review` is refunded by hand in the Paystack
  dashboard. `revenue` is not reduced by refunds, and a flagged payment on a cancelled
  order is not counted as revenue but a *succeeded* one is until removed.
- **Unpaid orders still hold stock.** There is no expiry: an order that is started online
  but never paid, like one never paid by transfer, keeps its portions off sale until the
  seller cancels it. An expiry job is the fix.
- **If a webhook is lost, the customer stays on "awaiting payment".** Paystack retries,
  but if it never arrives the order is not marked paid. A fallback (the status route
  asking Paystack itself) is possible and safe, but spends Paystack calls on every poll.
- **No fee preview.** The customer sees the service fee only after pressing Pay. A
  separate quote route would show it first.
- **Fake payer email.** Paystack requires one, customers do not give one, so each
  payment uses `<ref>@orders.choplistafrica.com`. Paystack's receipts go nowhere.
  Collecting a real email needs a frontend change.
- **The "4.5% total" claim is true only for large orders.** The ₦100 flat fee dominates
  small orders. In `customer` mode on the 3% tier the customer's extra is about 5.9% of
  a ₦7,500 order, 5.5% of ₦11,000, and 4.8% of ₦50,000. In `seller` mode the seller
  loses about 5.8% of ₦7,500. Do not promise 4.5%.
- **ChopList carries Paystack's pricing risk in `customer` mode.** The service fee is
  computed from the estimate; if Paystack charges more (for example an international
  card), the difference comes out of ChopList's fee. The estimate and the platform fee
  are stored on every payment, so the gap can be measured.
- **Count can be missed in a rare crash.** If the server dies after marking an order paid
  and before adding to the seller's count, that one order is not counted (the seller
  gets an extra free order). Closing this needs MongoDB transactions (a replica set).
- **Near the free-order boundary**, two payments started at 49 paid orders can both be
  free: the tier is decided when payment starts and counted when it completes.
- **A seller marking an order paid by hand while an online payment is in progress**
  is not blocked. If the customer then pays online, that payment is flagged for refund.
- **The webhook trusts the signature only,** not Paystack's sending addresses.
- **The retry route has no limit of its own.** Each call spends a few Paystack requests.
- **Admin order detail does not yet show Paystack payments** for one order; use the event
  log and the Paystack dashboard.
- **"Profile complete" in the funnel equals "registered"** today (see the admin overview).

## Typical flows

### A seller signs up and sets up a shop

1. Clerk signs the seller in (email and password never reach this API).
2. `GET /api/sellers/me` with the token. `403 PROFILE_REQUIRED` means show the
   onboarding form; `200` means go to the dashboard.
3. `PUT /api/sellers/me` with the shop details: `201` and the profile, including
   the shop link (`slug`).
4. `POST /api/menus` (a draft), `PUT /api/menus/:id` to adjust it, then
   `POST /api/menus/:id/open`.
5. Share the shop link built from the `slug` (the frontend decides the URL shape);
   the page loads it through `GET /api/public/menu/:slug`.

### A customer orders

1. `GET /api/public/menu/:slug`. If `menu` is `null` or `acceptingOrders` is
   `false`, show that ordering is closed.
2. `POST /api/public/orders`. On `201`, show `payment.instructions` and the
   reference. On `409 SOLD_OUT`, show `error.message` (it says what is left) and
   reload the menu.
   **Save `accessKey` from the response** (for example in `localStorage`, next to
   the reference). It is shown only this once.
3. Later: `GET /api/public/orders/:ref?phoneLast4=1234`, sending the saved key in
   the `X-Order-Key` header, to follow the status. While the status is
   `out_for_delivery`, show `order.deliveryCode` big on the page: the customer
   reads it to the rider. If `deliveryCodeHidden` is `true`, say "open this
   order on the device you ordered from".

### A customer pays online

1. The customer has placed an order (above) and saved the `accessKey`.
2. `GET /api/public/orders/:ref/payment-status` with `X-Order-Key`. If
   `onlinePaymentAvailable` is `true`, offer **Pay online** next to the bank transfer
   instructions.
3. `POST /api/public/orders/:ref/pay`: show `serviceFee` and `total`, save the order
   reference and the returned `reference`, then redirect to `authorizationUrl`.
4. The customer pays on Paystack's page. Paystack tells ChopList's server
   (`POST /api/webhooks/paystack`); the server checks the signature, asks Paystack
   to confirm the amount, marks the order paid and counts it for the seller.
5. Paystack sends the customer back to the return page. It polls
   `payment-status` until `state` is `paid` (or one of the other end states).
6. The seller sees the order as `paid` with `paymentMethod: "paystack"` and carries on
   as usual (out for delivery, delivery code, delivered).

### The seller runs the week

1. `GET /api/menus/:id/orders?status=pending` to see new orders.
2. Match payments to references in the bank app, then
   `PATCH /api/orders/:ref/paid` (orders paid online are already `paid`: skip those).
   Cancel unpaid ones with
   `PATCH /api/orders/:ref/cancel`, which puts the portions back on sale.
3. After the cut-off: `GET /api/menus/:id/prep-sheet` (what to cook) and
   `GET /api/menus/:id/delivery-list` (who gets what, by area), then
   `POST /api/menus/:id/close`.
4. On delivery day: `PATCH /api/orders/:ref/out-for-delivery` when the rider
   leaves. At the door the customer reads out their code, and the seller sends it
   with `PATCH /api/orders/:ref/confirm-delivery`. If the code is lost or the
   order is locked, `PATCH /api/orders/:ref/reset-delivery-code`.
