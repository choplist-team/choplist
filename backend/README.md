# ChopList backend

The API behind ChopList: sellers publish a weekly menu with quantities and a
cut-off time, customers order without an account and pay the seller directly
using a short reference code, and the seller gets an order list, a prep sheet and
a delivery list. No commission, no platform payments.

Node.js 20.19+, Express 5, TypeScript (strict), MongoDB (Mongoose), zod, Clerk
for seller sign-in, vitest + supertest.

The API contract (every route with example requests, responses and error codes)
is in [../docs/api.md](../docs/api.md).

## Run it locally

You need Node 20.19 or newer, a MongoDB database, and a Clerk application.

1. **Install**

       cd backend
       npm install

2. **Environment.** From the repo root, copy the example and fill it in:

       cp .env.example .env

   | Variable | What to put |
   | --- | --- |
   | `MONGO_URI` | Atlas connection string ending in a database name, e.g. `.../choplist_dev?retryWrites=true&w=majority`. Without a name MongoDB silently uses `test`. |
   | `CLERK_SECRET_KEY` | Clerk dashboard > API keys, starts with `sk_` |
   | `CLERK_PUBLISHABLE_KEY` | Same page, starts with `pk_` |
   | `ALLOWED_ORIGINS` | Frontend origins, comma separated, no trailing slash (`http://localhost:5173`) |
   | `PORT` | Defaults to 5000 |
   | `TRUST_PROXY_HOPS` | Proxies in front of the API, default 1. Leave alone locally. On Render see "Deploying on Render" |
   | `MONGO_URI_TEST` | Only for tests, see below |

   The server checks all of these at startup and refuses to start, naming the
   problem, if one is missing or malformed. In Atlas, allow your IP under Network
   Access or the connection times out after 10 seconds.

3. **Start**

       npm run dev

   You should see `Connected to MongoDB database "choplist_dev"` and
   `ChopList API listening on port 5000`. Check http://localhost:5000/health.

### Try the customer flow without a frontend

    npm run seed:demo

creates a demo seller ("demo-kitchen") with an open menu in the database named by
`MONGO_URI`. It refuses to run unless the database name ends in `_dev` or `_test`,
and rerunning it resets the demo stock. With the server running, in PowerShell:

    powershell -ExecutionPolicy Bypass -File scripts\try-flow.ps1

walks through opening the link, ordering, looking the order up, and the sold-out
and wrong-area errors, printing each response. It places 3 orders each run (the
order limit is 20 per 10 minutes per IP).

Seller routes (profile, menus, paid/cancel, reports) need a real Clerk token, so
they cannot be tried this way until the frontend can sign in. The tests cover them.

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | Server with reload, reads `../.env` |
| `npm run build` | Compiles `src/` to `dist/` |
| `npm start` | Runs `dist/server.js`. Reads no file: variables must already be set (as on Render) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | All tests (see below) |
| `npm run test:coverage` | Tests with a coverage report |
| `npm run seed:demo` | Demo seller and open menu |

## Tests

    npm test

- Tests that need no database always run.
- **Database tests** run against a real MongoDB when `MONGO_URI_TEST` is set
  (the root `.env` is read for it). Without it they are skipped and the run
  prints a banner saying so. **The skipped tests include the ordering, stock,
  cancel, isolation and report tests**, so a run without the variable proves
  little about the core rules.
- Start a throwaway MongoDB:

      docker run -d --name choplist-mongo-test -p 27018:27017 mongo:7

  and set `MONGO_URI_TEST=mongodb://127.0.0.1:27018/choplist_test`.
- **The database tests delete their database.** Each test file uses its own
  `<name>_test` database and refuses to run if the name does not end in `_test`.
  Never point `MONGO_URI_TEST` at real data.
- A standalone MongoDB is enough: nothing here uses transactions.

PowerShell, one-off:

    $env:MONGO_URI_TEST='mongodb://127.0.0.1:27018/choplist_test'; npm test

CI (`.github/workflows/backend.yml`) runs typecheck, build and all tests on
Node 20, 22 and 24 against a `mongo:7` service for every pull request.

## How the key rules are enforced

| Rule | How | Where | Tested in |
| --- | --- | --- | --- |
| Never oversell | One conditional `updateOne` takes stock for every line, or none: it only matches if the menu is open, before its cut-off, and each line has an element with `_id` and `qtyRemaining >= qty` (`$elemMatch`), then `$inc`s all lines together with `arrayFilters`. MongoDB applies a single-document update atomically. | `src/orders/stock.ts` | `orders.db`, `e2e.db` (40 concurrent orders for 5 portions: exactly 5 succeed, stock 0) |
| Price comes from the menu | Name and price are copied from the menu document; the request schema has no price field | `src/orders/place-order.ts`, `src/public/schema.ts` | `public.db`, `orders.db` |
| Order lines keep their price | Each order line stores `name` and `unitPrice` at order time, so editing a menu never changes what a customer owes | `src/models/order.ts` | `orders.db` |
| Reference codes are unique | `CL-` + 5 characters from an alphabet without 0/O/1/I; a unique index decides, and only the insert is retried on a collision | `src/orders/reference.ts`, `place-order.ts` | `reference`, `orders.db` |
| Failed order gives stock back | If the order insert fails, stock is returned before the error is rethrown | `place-order.ts` | `orders.db`, `failure-paths.db` |
| Cut-off and closed menus | The status and cut-off checks are part of the stock update's filter, so closing or the cut-off passing between the read and the write is still caught | `stock.ts` | `orders.db` (both clauses), `e2e.db` |
| Only drafts are editable; a closed menu never reopens | Every state change is one conditional write with the current status in the filter | `src/menus/router.ts` | `menus.db` |
| One open menu per seller | Partial unique index on `sellerId` where `status = open` | `src/models/menu.ts` | `models.db`, `menus.db` (two opened at once: one wins) |
| Sellers only see their own data | The seller is identified from the verified Clerk token only; every seller query filters by `sellerId`, and another seller's menu or order is a 404 | `src/auth/middleware.ts`, routers | `menus.db`, `seller-orders.db`, `sellers.db`, `reports.db` |
| Body cannot name another seller | zod strips unknown fields, so a smuggled `clerkUserId` or `sellerId` is ignored | `src/sellers/router.ts` | `sellers.db` |
| Mark paid and cancel are safe to repeat | Status changes are conditional writes; only the request that changes the status returns stock, so it comes back exactly once | `src/orders/router.ts` | `seller-orders.db` (10 simultaneous cancels) |
| Order lookup needs the phone digits | Reference plus last 4 digits; a wrong reference and wrong digits give the same 404; no address or full phone is returned | `src/public/router.ts` | `public.db` |
| Spam protection on the public routes | Per-IP rate limits (20 orders, 30 lookups per 10 minutes) with a JSON 429 | `src/middleware/rate-limit.ts` | `public` |
| Reports are always current | Prep sheet and delivery list are aggregations run on each request; nothing is stored, so they cannot disagree with the orders | `src/reports/` | `reports.db` |
| Bad configuration fails at startup | zod validates the environment once, before anything starts | `src/config.ts` | `config` |
| Unique indexes exist before traffic | Indexes are built after connecting and before listening | `src/db.ts` | `db.db` |

## Layout

    src/
      app.ts            createApp(): middleware and routers, no listening (tests use it)
      server.ts         config, database, listen, shutdown
      config.ts         environment validation
      db.ts             connect and build indexes
      errors.ts         AppError and the list of error codes
      auth/             AuthProvider interface, Clerk implementation, requireUser/requireSeller
      models/           Seller, Menu (items embedded), Order
      sellers/          GET/PUT /api/sellers/me
      menus/            menu lifecycle, plus order list and reports under /api/menus/:id
      orders/           placeOrder, stock, reference codes, paid/cancel routes
      public/           customer routes
      reports/          prep sheet and delivery list
      middleware/       error handler, rate limits
      validation/       Nigerian phone numbers, Lagos calendar days
    scripts/            seed-demo.ts, try-flow.ps1
    test/               unit, no-database and database tests; helpers/ has the fake auth

## Known limits

Be upfront about these when presenting.

- **Unpaid orders hold stock until the seller cancels them.** There is no
  automatic expiry. A person who orders and never pays keeps those portions off
  sale until the seller cancels. (Rate limits stop one network doing this in bulk.)
- **Payment matching is manual, by design.** ChopList never sees or moves money.
  The seller matches the reference in their bank app and marks the order paid.
- **Cancel is two writes** (status, then stock). If the server crashes between
  them, the order is cancelled but its portions stay held. This is logged as
  `STOCK NOT RETURNED` with the menu and lines, to fix by hand. Status is changed
  first on purpose: holding a portion too long is safer than selling it twice.
  Placing an order has the same shape (stock, then insert) and a similar log line.
- **Rate-limit counts are in memory.** They reset on restart and are not shared
  between server instances; several instances would need a shared store.
  Customers behind one mobile-network IP share a limit.
- **The proxy hop count must match the host.** The rate limits count requests per
  customer address, which comes from `X-Forwarded-For`. `TRUST_PROXY_HOPS` says how
  many proxies to skip. On Render the default of 1 was tested and is **wrong**: it
  gave one customer several counters (it read a Cloudflare address), so customers
  could share counters. The value for Render is set and checked as described below.
- **A menu stays `open` after its cut-off** until the seller closes it. Orders are
  refused after `cutoffAt` regardless, and the public menu reports
  `acceptingOrders: false`.
- **Changing a shop link breaks the old one**, including any already posted in a
  bio.
- **Customers cannot cancel or change an order**; they ask the seller.
- **No notifications.** Nothing is sent to sellers or customers.
- **`GET /api/menus/:id/orders` is not paginated.** Fine for a home kitchen's
  week; a very large menu would return everything.
- **`phoneLast4` is 10,000 combinations.** The lookup limit makes guessing slow
  (about 55 hours from one IP) and a lookup reveals little, but it is not secret.
- **Not yet verified:**
  - a real, signed Clerk token end to end (tests use a fake provider; the real
    middleware is only checked with no token and a junk token);
  - a deployed instance on Render;
  - behaviour under real network failures between the two writes above (simulated
    in `failure-paths.db.test.ts`, not provoked for real).

## Deploying on Render (suggested settings, not yet tried)

- Root directory `backend`; build `npm ci && npm run build`; start `npm start`.
- `TRUST_PROXY_HOPS`: Render sits behind Cloudflare, so the default of 1 reads a
  proxy address instead of the customer's. Set it to `2`, then check from your
  machine (the count is right when every request has the same `pk=` key, a
  faked `X-Forwarded-For` does not change it, and a second network shows a
  different key):

      1..10 | % { curl.exe -s -i https://<name>.onrender.com/api/public/orders/CL-AAAAA?phoneLast4=1234 | Select-String 'ratelimit-policy' }

  If the keys still vary, try 3 and repeat; if a faked header changes the key, the
  number is too high.
- Environment (dashboard): `MONGO_URI`, `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`,
  `ALLOWED_ORIGINS=https://choplist.onrender.com` (add `http://localhost:5173` if
  local frontends should work), and a Node version of 20.19 or newer.
- Health check path `/health`. It does not touch the database, so UptimeRobot can
  ping it every few minutes to keep the free instance awake.
- Render's free tier has no fixed outbound IP, so Atlas Network Access needs
  `0.0.0.0/0`; use a strong database password.
