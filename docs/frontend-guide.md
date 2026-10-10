# Connecting the frontend to the API

For the frontend team. The API is built, deployed and documented; this page is
the shortest path to connecting a React page to it. Every route, field and error
code is in [api.md](api.md); this guide shows how to use them.

The customer path needs no sign-in, so it can be built first, while Clerk is
being set up.

## 1. Setup

**Environment.** Vite reads `frontend/.env`, not the `.env` at the repo root.
Create `frontend/.env` (it is git-ignored):

```
VITE_API_BASE_URL=http://localhost:5000/api
VITE_CLERK_PUBLISHABLE_KEY=pk_test_...
```

The deployed frontend needs the same two names in its Render settings, with
`VITE_API_BASE_URL=https://choplist-api.onrender.com/api`. Vite bakes these in at
build time, so **redeploy the frontend after changing them**.

**CORS.** The API only answers browsers on origins listed in its
`ALLOWED_ORIGINS`. Locally that is `http://localhost:5173` (Vite's default port).
If Vite starts on another port, calls fail with a CORS error until that origin is
added.

**Something to try against.** A demo shop with an open menu exists in the
development database: the shop link is `demo-kitchen`. To run the API yourself,
see `backend/README.md` (`npm run dev`, `npm run seed:demo`).

## 2. Fix the API client first

`src/api/api-client.js` currently throws `API request failed with status 409` and
discards the response body, so none of the API's readable messages ("only 2 Jollof
rice left") ever reach a user. Every error from the API has the shape
`{ "error": { "code", "message" } }`. Replace the file with:

```js
// file: api-client.js
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

// Thrown for every non-2xx answer. `code` is stable (check it in code),
// `message` is written for people (show it).
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

// apiRequest('/public/menu/demo-kitchen')
// apiRequest('/public/orders', { method: 'POST', body: { ... } })
// apiRequest('/sellers/me', { requiresAuth: true }, getToken)
export const apiRequest = async (endpoint, options = {}, getToken) => {
  const { requiresAuth, body, headers: extraHeaders, ...rest } = options;
  const headers = { ...extraHeaders };

  if (body !== undefined) headers['Content-Type'] = 'application/json';

  if (requiresAuth) {
    const token = await getToken();
    if (!token) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    headers.Authorization = `Bearer ${token}`;
  }

  let response;
  try {
    response = await fetch(`${API_BASE_URL}${endpoint}`, {
      ...rest,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // The request never got an answer: offline, or the server is waking up.
    throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the server. Check your connection and try again.');
  }

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = data?.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'UNKNOWN',
      error?.message ?? `Request failed (${response.status})`,
    );
  }
  return data;
};
```

Pass a plain object as `body`; the client turns it into JSON.

**Waking up:** the free hosting tier sleeps after idle time, so the first request
can take 30 to 60 seconds. Show a loading state rather than an error.

## 3. The customer path (no sign-in)

Three calls. These wrappers use the client above (use React Query's `useQuery` for
the first and third, `useMutation` for the second):

```js
// file: customer-api.js
import { apiRequest } from './api-client.js';

export const getShop = (slug) => apiRequest(`/public/menu/${encodeURIComponent(slug)}`);

export const placeOrder = (order) => apiRequest('/public/orders', { method: 'POST', body: order });

export const lookupOrder = (ref, phoneLast4) =>
  apiRequest(`/public/orders/${encodeURIComponent(ref)}?phoneLast4=${encodeURIComponent(phoneLast4)}`);
```

### The menu page

`getShop('demo-kitchen')` returns:

```json
{
  "seller": { "businessName": "Demo Kitchen", "slug": "demo-kitchen", "phone": "+2348031234567" },
  "menu": {
    "id": "...", "title": "Demo week", "cutoffAt": "2026-10-12T13:21:44.332Z",
    "acceptingOrders": true,
    "items": [
      { "id": "...", "name": "Jollof rice", "description": "With fried plantain",
        "price": 3500, "qtyRemaining": 5, "soldOut": false }
    ],
    "areas": ["Yaba", "Surulere"],
    "deliveryDays": ["2026-10-13"]
  }
}
```

What to do with it:

| Situation | Show |
|---|---|
| `404` with code `SELLER_NOT_FOUND` | "This shop link doesn't exist" |
| `menu` is `null` | "`seller.businessName` has no menu open right now" |
| `menu.acceptingOrders` is `false` | The menu, with ordering turned off ("ordering has closed") |
| An item has `soldOut: true` | That item greyed out, with no quantity picker |
| Otherwise | Items with prices (whole naira, e.g. `3500` is ₦3,500) and a quantity picker. Cap the picker at `qtyRemaining`. |

Format money with `new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 0 })`.
Show `cutoffAt` in Lagos time: `new Date(cutoffAt).toLocaleString('en-NG', { timeZone: 'Africa/Lagos' })`.
`deliveryDays` are plain `YYYY-MM-DD` dates, not timestamps: show them as dates and
send them back unchanged.

### The order form

Fields, and what the API accepts:

| Field | Notes |
|---|---|
| Name | Required, up to 80 characters |
| Phone | **`<input type="tel">`** and send a **string**. Any Nigerian format works (`0803 123 4567`, `+234 803 123 4567`). Never `type="number"`: it drops the leading `0`. |
| Area | One of `menu.areas` (a `<select>`) |
| Delivery day | One of `menu.deliveryDays` |
| Address | Required, at least 5 characters |
| Note | Optional, up to 300 characters |
| Items | At least one, `qty` a whole number from 1 to 100 |

Submit:

```js
placeOrder({
  menuId: menu.id,
  customer: { name, phone },
  delivery: { area, address, day },
  note,                                   // optional
  lines: [{ itemId: item.id, qty: 2 }],   // only items with qty > 0
});
```

Do **not** send prices or a total: the server ignores them and uses the menu's
prices. If the form shows a total, work it out for display only.

### Errors on submit

Catch `ApiError` and look at `error.code`. The `message` is always safe to show.

| `code` | Meaning | Do this |
|---|---|---|
| `SOLD_OUT` (409) | Someone took the last portions. **Nothing was ordered.** The message says what is left, e.g. "Not enough left: only 2 Jollof rice left". | Show the message, reload the menu, let the customer adjust |
| `ORDERING_CLOSED` (409) | Cut-off passed or the seller closed the menu | Show the message, reload the menu |
| `VALIDATION_ERROR` (400) | A field is wrong. The message names each one, e.g. `phone: Enter a Nigerian mobile number...` | Show the message (or split it on `; ` and mark the fields) |
| `INVALID_AREA`, `INVALID_DELIVERY_DAY` (400) | Not one of the menu's choices (the page was stale) | Show the message, reload the menu |
| `ITEM_NOT_FOUND` (400) | An item is no longer on the menu | Reload the menu |
| `RATE_LIMITED` (429) | Too many orders from this network | Show the message and ask them to wait a few minutes |
| `NETWORK_ERROR` (0) | No answer from the server | "Check your connection and try again" |

`SOLD_OUT` is normal: stock is only guaranteed at the moment of submitting, so a
page can be out of date. Handle it as a message, not a crash.

### The confirmation screen

`placeOrder` returns (`201`):

```json
{
  "order": {
    "ref": "CL-7KQ2M", "status": "pending", "customerName": "Ada",
    "lines": [{ "name": "Jollof rice", "unitPrice": 3500, "qty": 2 }],
    "total": 7000,
    "delivery": { "area": "Yaba", "day": "2026-10-13" },
    "createdAt": "2026-10-10T21:25:46.870Z"
  },
  "payment": {
    "amount": 7000, "reference": "CL-7KQ2M",
    "bankName": "GTBank", "accountNumber": "0123456789", "accountName": "Demo Owner",
    "instructions": "Transfer ₦7,000 to Demo Owner, GTBank 0123456789, and write CL-7KQ2M as the transfer description so Demo Kitchen can match your payment."
  },
  "seller": { "businessName": "Demo Kitchen", "slug": "demo-kitchen", "phone": "+2348031234567" }
}
```

Show: the order summary (`order.lines`, `order.total`), the reference
(`order.ref`), the bank details (`payment.bankName`, `.accountNumber`,
`.accountName`) and `payment.instructions`. The reference is what the seller uses
to match the payment, so make it prominent.

**Copy in one tap:** `order.ref` and `payment.accountNumber` are plain strings
with no spaces or formatting, so they can be copied directly:

```js
// file: copy.js
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false; // clipboard blocked (e.g. insecure page): show the text so it can be selected
  }
}
```

`navigator.clipboard` only works on `https` pages and on `localhost`, and only
from a click or tap. After a successful copy, show "Copied" on the button.

Keep the reference where the customer can find it again: they can check the order
later with `lookupOrder(ref, phoneLast4)` (the last 4 digits of the phone they
used). Wrong digits and an unknown reference give the same `404 ORDER_NOT_FOUND`
on purpose. The response has the same shape as above; `order.status` is
`pending`, `paid` or `cancelled`. Any lookup needs both parts, so keep the last 4
digits as well (for example in the confirmation page's URL or in local storage).

## 4. Signing sellers in with Clerk

**Use `@clerk/react`, not `@clerk/react-router`.** The commented-out code in
`main.jsx` imports `ClerkProvider` from `@clerk/react-router`. That package is for
React Router v7's *framework mode* (its setup is `rootAuthLoader` and `ClerkApp`,
which run on a server). This app is a Vite single-page app using
`createBrowserRouter`, which is what `@clerk/react` is for. This is based on
reading the two packages' READMEs; check Clerk's "React (Vite)" quickstart when
you set it up.

```
npm install @clerk/react
```

```jsx
// main.jsx
import { ClerkProvider } from '@clerk/react';

<ClerkProvider publishableKey={import.meta.env.VITE_CLERK_PUBLISHABLE_KEY}>
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>
</ClerkProvider>
```

Clerk handles sign-up, login, wrong-password messages and password reset. Email
and password never go to our API. Use Clerk's `<SignIn />` and `<SignUp />`, or the
`useSignIn` / `useSignUp` hooks behind the existing forms.

**Calling the API as a seller.** `useAuth()` gives `getToken`, which the API
client already knows how to use:

```jsx
import { useAuth } from '@clerk/react';
import { apiRequest } from '@/api/api-client';

const { isLoaded, isSignedIn, getToken } = useAuth();
const profile = () => apiRequest('/sellers/me', { requiresAuth: true }, getToken);
```

Tokens last about a minute; call `getToken()` for each request (the client does)
instead of storing one.

**The first screen after login.** Call `GET /sellers/me`:

| Answer | Go to |
|---|---|
| `200` | The dashboard |
| `403` with code `PROFILE_REQUIRED` | Onboarding (the shop details form), which submits `PUT /sellers/me` |
| `401` | Back to login |

The onboarding form needs: shop name, WhatsApp phone, bank name, account number
(exactly 10 digits, as a string, `type="tel"`) and account holder name. The shop
link (`slug`) is optional: leave it out and the API makes one from the shop name,
for example `mama-ts-kitchen`. Offer it as an editable field, prefilled if you
like. A taken link returns `409 SLUG_TAKEN`.

## 5. Seller screens and the calls behind them

All need `requiresAuth: true`. Full request and response examples are in
[api.md](api.md).

| Screen | Call |
|---|---|
| Shop profile | `GET /sellers/me`, `PUT /sellers/me` |
| My menus | `GET /menus` |
| New or edit menu (drafts only) | `POST /menus`, `PUT /menus/:id` |
| Publish / close | `POST /menus/:id/open`, `POST /menus/:id/close` |
| Orders for a menu | `GET /menus/:id/orders` (optional `?status=pending`) |
| Mark paid / cancel | `PATCH /orders/:ref/paid`, `PATCH /orders/:ref/cancel` |
| What to cook | `GET /menus/:id/prep-sheet` (optional `?paidOnly=true`) |
| Who to deliver to | `GET /menus/:id/delivery-list` (optional `?day=`, `?paidOnly=`) |

Things the screens must respect:

- A menu moves **draft, open, closed** and only forwards. Only drafts can be
  edited; a closed menu cannot be reopened (start a new one). A seller can have
  one open menu at a time (`ANOTHER_MENU_OPEN`).
- `cutoffAt` is sent as a timestamp **with a time zone**:
  `new Date(...).toISOString()`.
- The orders list includes cancelled orders unless you filter. Use
  `?status=pending` for "waiting for payment".
- "Mark paid" and "cancel" are safe to tap twice. Cancelling puts the portions back
  on sale. A cancelled order cannot be marked paid (`ORDER_CANCELLED`).
- The seller finds an order by the reference in the bank alert. The list has no
  search, so filter it in the browser.

## 6. Checking your work

- **Customer path:** build against `demo-kitchen`. Placing orders there is fine;
  it is the development database.
- **Seller routes before the login works:** `backend/README.md` describes a local
  page (`npm run clerk:login-test`) that signs in with Clerk and calls the API
  with a real token. It is a good way to see real responses.
- **Any error:** the response body says why. Read `error.code` and `error.message`.
