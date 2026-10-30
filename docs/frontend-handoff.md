# Frontend handoff

For the frontend developers. `docs/api.md` is the source of truth for every endpoint,
with an example request and response for each. This page says what changed, what you
must handle, and what is left to build. `docs/frontend-guide.md` covers setup and the
first customer and seller screens.

## 1. Backend status

The API is deployed on Render (`https://choplist-api.onrender.com`). Everything below
is implemented and tested against a real MongoDB.

| Area | What exists |
|---|---|
| Sellers and menus | Sign-in with Clerk, profile, menus (draft, open, closed), public shop pages |
| Ordering | Atomic stock (no overselling), order lookup by reference and last 4 phone digits |
| Seller order actions | Mark paid, cancel, prep sheet, delivery list |
| Delivery confirmation | Out for delivery, confirm with a 6-digit code, reset the code |
| Admin console | Overview, sellers, orders, analytics, health, event log, missing-order reports, audit trail |

## 2. Changes that affect screens you already have

1. **Suspended sellers.** Any seller call can return `403` with
   `error.code = "ACCOUNT_SUSPENDED"`. Show a "your account is not active, contact
   support" screen instead of the dashboard. This applies to `/sellers/me`, menus and
   orders alike.
2. **Seller profile has two new fields:** `email` (string or `null`) and `status`
   (`active`, `suspended` or `deactivated`). `PUT /api/sellers/me` accepts an optional
   `email`: leave it out to keep the current one, send `""` to remove it.
3. **Order statuses** are exactly `pending`, `paid`, `out_for_delivery`, `delivered`,
   `cancelled`, with underscores. The orders filter takes one or more, comma separated
   or repeated. There is **no `all`**: send no `status` to see everything.
4. **Delivery confirmation (seller).**
   - Routes use the order **reference**:
     `PATCH /api/orders/:ref/out-for-delivery`, `/confirm-delivery`, `/reset-delivery-code`.
   - The code is a **string of exactly 6 digits**, and leading zeros matter.
   - Show `error.message` for a wrong code: it says how many attempts are left.
   - Handle `DELIVERY_CODE_LOCKED` (offer a reset), `DELIVERY_RESET_LIMIT` (tell them to
     contact support) and `ORDER_NOT_PAID`.
   - The seller **never** receives the code.
5. **Customer order page.** The key returned once by `POST /api/public/orders`
   (`accessKey`) is saved in the browser and sent as the `X-Order-Key` header on every
   lookup. `order.deliveryCode` is filled only while the status is `out_for_delivery`.
   If `deliveryCodeHidden` is `true`, tell the customer to open the order on the device
   that placed it. Orders placed before the key was saved can never show a code.
6. **Shop page** sends one view per browser session to
   `POST /api/public/menu/:slug/view`. It is fire-and-forget and must never block or
   fail the page.
7. **Error codes you may see:** `ACCOUNT_SUSPENDED`, `ORDER_DELIVERED`,
   `ORDER_NOT_OUT_FOR_DELIVERY`, `INVALID_DELIVERY_CODE`, `DELIVERY_CODE_LOCKED`,
   `DELIVERY_RESET_LIMIT`, `RATE_LIMITED` (say "try again in a few minutes"). Customers
   of a suspended seller see `ORDERING_CLOSED`.

## 3. New customer screen: "My order is missing"

`POST /api/public/orders/report-missing`, no sign-in.

- Body: `ref` and/or `phoneLast4` (**exactly 4 digits, never the full number**), optional
  `menuSlug`, and `message` (5 to 500 characters). Optional fields may be left out or
  sent as `""`.
- It always answers `201 { "received": true }`, whether or not an order was found.
  **Do not tell the customer we found it.** Say "We've received your report."
- Limited to 5 per 10 minutes per network, so handle `429`.
- Suggested: link to it from the order lookup page.

## 4. New: the admin console

Everything is under `/api/admin`. Sign in with Clerk like sellers and send the token as
`Authorization: Bearer <token>`.

**Who is an admin?** A Clerk user id listed in the backend's `ADMIN_CLERK_USER_IDS`
setting. Find out with `GET /api/admin/me`: `200` is an admin, `403 FORBIDDEN` is "not an
admin", `401` is not signed in. Do not hard-code ids. To try it locally, put your Clerk
user id in `ADMIN_CLERK_USER_IDS` in the root `.env`. An admin does not need a seller
profile. Admins sign in at `/admin/sign-in` (no sign-up there); `/admin` is guarded by
that check.

### Pages and the calls behind them

| Page | Calls | Notes |
|---|---|---|
| Dashboard | `GET /overview` | Show `definitions.*` as tooltips. Rates are fractions (0.6667 is 66.7%). `null` means "no data yet", not 0%. |
| Sellers | `GET /sellers?q=&status=&page=&limit=`, `GET /sellers/:id` | Search matches name, link, email and phone in any format. Bank details are never returned. |
| Suspend and deactivate | `PATCH /sellers/:id/suspend`, `/deactivate`, `/reinstate` | Suspend and deactivate **need a reason** (3 to 300 characters). Reinstate's reason is optional. Safe to repeat. Use a confirm dialog. |
| Orders | `GET /orders?ref=&sellerId=&from=&to=&status=&flag=&page=&limit=`, `GET /orders/:ref` | Phones are masked (`0803****567`). The full phone, address and note appear only with `?reveal=true`, which the backend records, so put a "Reveal" button behind a confirmation. |
| Analytics | `GET /analytics/menus`, `/analytics/items`, `/analytics/customers` | See "Labels you must show". |
| Health | `GET /health` | Counts for the last 24 hours. |
| Events | `GET /events?type=&level=&sellerId=&from=&to=` | The troubleshooting log. |
| Support | `GET /reports?status=`, `PATCH /reports/:id/resolve` | Open reports come first. Resolve takes an optional `note`. |
| Audit | `GET /audit?adminId=&action=&targetId=&from=&to=` | Read-only: who did what, and why. |

### Rules for every admin endpoint

- **Lists** take `?page=` (from 1) and `?limit=` (default 20, **at most 100**) and return
  `pagination: { page, limit, total, totalPages }`. Newest first. A `limit` of 101 is a
  `400`.
- **Dates** are `YYYY-MM-DD` and mean Lagos calendar days, both ends included.
  Timestamps in responses are UTC ISO strings.
- **Money** is whole naira (integers).
- **Errors** are always `{ "error": { "code", "message" } }`. `401` means not signed in,
  `403 FORBIDDEN` means not an admin, `400 VALIDATION_ERROR` has a readable message you
  can show.
- **Unknown query parameters are ignored**, so a typo in a filter name quietly means "no
  filter". Check names against `docs/api.md`.

### Labels you must show

So nobody misreads a number:

- **Payment status** is "confirmed by the seller". ChopList never sees the bank transfer.
- **Conversion** is orders divided by views. Label it an **indicator**: views are page
  loads, not unique visitors, so it can pass 100% and is `null` with no views.
- **Customers (new and returning)** are approximate: a person with two phone numbers
  counts twice. Over "all time" nobody is returning, so show `repeatOrders` instead.
- **Failed orders** (`flag=failed`) means placed but never paid, with the menu's cut-off
  passed. Orders that could not be placed at all are in `/health` and `/events`, not in
  the orders list.
- **Notification failures** on the health page are **always 0 for now**, because nothing
  sends notifications yet. Show "not tracked yet", not a good result.
- **Possible duplicate** only says "possible".

## 5. Don'ts

- Never show, log or store the delivery code or access key anywhere except the customer's
  own page and its `localStorage`.
- Never ask the customer for their full phone number on the report form.
- Don't call admin endpoints from customer or seller pages.
- Don't expect a body from the `204` response of the view call.

## 6. Setup and questions

- API base URL and Clerk key: `VITE_API_BASE_URL` and `VITE_CLERK_PUBLISHABLE_KEY` in
  `frontend/.env` (see `.env.example`).
- Endpoint details: `docs/api.md` (the admin section starts at "Admin console").
- Anything missing from the API, or the Render admin setting: ask the backend engineer.
