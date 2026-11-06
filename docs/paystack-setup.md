# Setting up and testing Paystack payments

For the person running the backend. The API itself (routes, fields, fees) is in
[api.md](api.md); this file is what to do outside the code.

Two rules first:

- **Test mode only** until Paystack has verified the business. A test secret key
  starts with `sk_test_`. The server accepts any `sk_…` key, so nothing stops a live
  key being used by mistake: do not put one in until Section 5 is done.
- **Never paste a key into a chat, a ticket, an issue, a commit or a test.** It goes
  only into Render's environment settings. If one is ever exposed, rotate it in the
  Paystack dashboard, update Render, and redeploy.

## 1. Settings on Render

Set these on the backend service, then redeploy (a changed variable is not picked up
until the service restarts). All are described in `.env.example`.

| Variable | Value |
| -------- | ----- |
| `PAYSTACK_SECRET_KEY` | The **test** secret key from Paystack dashboard > Settings > API Keys & Webhooks. Leave it empty to keep online payments off (bank transfer keeps working) |
| `PAYSTACK_CALLBACK_URL` | The frontend page Paystack sends the customer back to after paying, `https://choplistafrica.com/paystack-return` (the customer return page that exists in the frontend). Refused at startup if it is under `/api` or on a webhook path |
| `ORDER_EXPIRY_HOURS` | `48` (optional). Unpaid orders older than this are cancelled and their portions put back on sale; `0` switches it off. See api.md, Expiry. **Agree the number with the team before relying on it** |
| `PLATFORM_FEE_BPS` | `0` (ChopList takes no cut of each order; it earns from subscriptions). The default is 0, so leaving it unset is the same. Setting it above 0 switches the old tiers back on (`FREE_ORDERS` free orders, then this many basis points) |
| `SUBSCRIPTION_CALLBACK_URL` | The frontend page Paystack sends a vendor back to after paying a subscription: `https://choplistafrica.com/seller/billing/done` (this page exists in the frontend now). It is not the customer's page |
| `SHARE_URL_BASE` | Start of a shop link without the slug, e.g. `https://choplistafrica.com/shop` (optional) |
| `TRIAL_DAYS` | `7` (optional) |
| `SUBSCRIPTION_MONTHLY_NAIRA` | `3000` (optional) |
| `SUBSCRIPTION_QUARTERLY_NAIRA` | `8000` (optional; this is the default) |

**After every deploy, open `GET /api/admin/system`** (as an admin). It says whether Paystack is in test or live mode, whether the return pages are set, and warns
about anything that looks wrong, without ever showing a key.

The startup log does not print any of these. If `PAYSTACK_SECRET_KEY` is set but does
not start with `sk_`, the server refuses to start and says so (without printing the
value).

## 2. The webhook address

In the Paystack dashboard, under Settings > API Keys & Webhooks, set the **test**
webhook URL to:

```
https://api.choplistafrica.com/api/webhooks/paystack
```

(Until the new domain is live, use the Render address with the same path.) Paystack
keeps separate test and live webhook URLs: the live one is set again in Section 5.

Quick check that the address is reachable and rejects strangers. This sends no secret
and must answer `401`:

```
curl.exe -i -X POST https://api.choplistafrica.com/api/webhooks/paystack -H "Content-Type: application/json" -d "{}"
```

Expected: `HTTP/1.1 401` and `{"error":{"code":"INVALID_SIGNATURE",...}}`. A `503` means
the Paystack key is not set on the server.

## 3. The manual test-mode run

The automated tests use a fake Paystack, so they cannot prove ChopList agrees with the
real one. Do this once in test mode before anyone relies on it, and write down anything
that differs. Use a throwaway seller and order.

1. **Seller setup.** Onboard a test seller choosing a bank from `GET /api/sellers/banks`.
   Expect `paymentsReady: true`. If it is `ACCOUNT_NOT_FOUND`, Paystack's test mode
   probably only accepts specific test bank details for account lookups: use the ones in
   Paystack's documentation. If it is `SETUP_REJECTED` or `PAYSTACK_UNAVAILABLE`, look
   at the event log (`payment_setup_failed`) for Paystack's message.
2. **A payment.** Place an order, call `/pay`, open `authorizationUrl` and pay with a test
   card from Paystack's documentation. Then check, in order:
   - Paystack's dashboard shows the webhook was sent and got `200`.
   - The order is `paid` with `paymentMethod: "paystack"`, the seller's
     `paidOrderCount` is 1, and `payment-status` says `paid`.
   - The admin overview shows it in `paidOnPlatform` and `gmv`.
   - **This is the first proof that the signature check agrees with Paystack's real
     signing.** If the webhook is rejected with `401`, stop and tell the backend owner.
3. **The split, free tier, seller pays fees.** Switch the seller to `seller` mode, pay a
   fresh order, and open the transaction in Paystack's dashboard. **ChopList's share must
   be 0** and the seller's share must be the amount minus Paystack's charge. This
   confirms that leaving out `transaction_charge` on the free tier really means "no cut"
   and that the subaccount's default is not taking anything.
4. **The split, customer pays fees.** Switch back to `customer` mode and pay another.
   The seller's share must be **exactly the order total**. Compare Paystack's actual
   charge with the estimate stored on the payment (`paystackFeeKobo`); a small
   difference is normal, a large one means the constants in `backend/src/config.ts`
   (`PAYSTACK_PRICING`) are out of date.
5. **Replay.** Use "resend" on that event in Paystack's dashboard. Nothing should change;
   `paidOrderCount` must not go up.
6. **A mistake.** Pay the same order twice (two `/pay` calls, both completed). The first
   counts; the second must show in `paymentsNeedingReview` and as a
   `DUPLICATE_PAYMENT` event. Refund the second in Paystack's dashboard.
7. **The 50th and 51st.** Set a test seller's `paidOrderCount` to 49 in the database,
   pay, and check the next quote carries the 3% fee.

### Subscriptions (vendor billing)

Do this after the order run above, with a throwaway seller whose trial you have ended (set
`billing.trialEndsAt` to a past date in the database) so the share button is refused.

1. `GET /api/sellers/me/share` answers `403 SHARING_NOT_ALLOWED`.
2. `POST /api/sellers/me/billing/subscribe` with `{ "plan": "monthly" }`, open
   `authorizationUrl` and pay with a test card.
3. Check in order: Paystack's dashboard shows the webhook got `200`; the transaction is in
   **ChopList's own balance** (not split to any seller); `GET /api/sellers/me/billing` says
   `state: "active"` with `expiresAt` one calendar month after `startsAt`; and
   `GET /api/sellers/me/share` works again.
4. **Replay** the event from Paystack's dashboard: nothing changes.
5. Subscribe again **before** it expires: the new `startsAt` must equal the first one's
   `expiresAt`.
6. **Nobody has confirmed yet** that Paystack accepts a payment with no subaccount in test
   mode, or what it reports when you verify one. If step 2 fails, send the `payment_*`
   event, not the key.

### Refunds and the lost-webhook fallback

Do these in test mode too, since they have never met real Paystack:

1. **A refund of a split payment.** Pay an order with a test card, have the seller cancel it, and check it appears under
   `GET /api/admin/refunds` as `due`. Refund it in the Paystack dashboard and note **where Paystack takes the money from** (the
   seller's subaccount or ChopList's balance). Then mark it refunded in ChopList.
2. **The fallback.** Pay an order, but temporarily point the Paystack test webhook URL somewhere that does not exist so the
   webhook cannot arrive. Poll the order's `payment-status`: after about 20 seconds it should turn `paid` on its own. Put the
   webhook URL back.

### Notifications, the background re-check and admin tools

Quick checks once the main run passes:

1. As the test seller, open the notifications list after step 4: you should see "Order … was paid online". As an admin, the inbox should show a
   "refund due" after step 9.
2. **Background re-check:** repeat the lost-message test (step 11) but do **not** open the order page. About 2 to 17 minutes later the order should
   still turn paid on its own.
3. **Free grant:** as an admin, grant a monthly subscription to a vendor whose trial has ended, with a reason. The share button should work and the
   admin income figures should **not** change. Then cancel it and the share button should stop.
4. **Fee preview:** before pressing Pay, the preview total should equal the amount shown on the Paystack page.

## 4. When something is wrong

Problems are written to the event log, with order references and amounts but never
customer, bank or key details. Read them in the admin console (`GET /api/admin/events`).

| Event type | Code | Meaning and what to do |
| ---------- | ---- | ---------------------- |
| `payment_setup_failed` | `ACCOUNT_NOT_FOUND` | The seller's bank details were not found at Paystack. The seller should check them |
| | `SETUP_REJECTED` | Paystack refused to create the payout account. Check the message in the event |
| | `PAYSTACK_UNAVAILABLE` | Paystack or our key failed. If it repeats for every seller, check the key and Paystack's status page |
| `payment_start_failed` | `PAYSTACK_UNAVAILABLE`, `PAYSTACK_REJECTED` | A customer could not start paying; they were told to use bank transfer |
| `payment_webhook_issue` | `AMOUNT_MISMATCH` | The amount Paystack reports is not what was asked. **Refund or investigate**; the order is not paid |
| | `DUPLICATE_PAYMENT` | A customer paid an already-paid order. **Refund the second payment** |
| | `ORDER_NOT_PAYABLE` | Money arrived for an order that was cancelled or already settled. **Refund it** |
| | `NOT_CONFIRMED` | Paystack did not report the payment as successful. Usually harmless |
| | `UNKNOWN_REFERENCE` | A confirmed payment ChopList has no record of. Check the Paystack dashboard |
| | `VERIFY_FAILED` | ChopList could not ask Paystack; Paystack will resend. Repeated failures mean the key or Paystack is down |

Subscription problems are `subscription_webhook_issue` (a confirmation that needs a look)
and `subscription_start_failed` (a vendor could not start paying). Their codes are the
same as above (`AMOUNT_MISMATCH`, `NOT_CONFIRMED`, `UNKNOWN_REFERENCE`,
`PAYSTACK_UNAVAILABLE`, `PAYSTACK_REJECTED`); `VERIFY_FAILED` is still logged as
`payment_webhook_issue`. A subscription marked `needs_review` is the **vendor's** money
sitting with Paystack and is not counted on the admin overview: find it in the event log.

Two more event types: `payment_query_raised` (a customer or seller reported a payment problem; look at the payment queries page) and
`orders_expired` (unpaid orders were cancelled; informational).

Refunds owed to customers are listed at `GET /api/admin/refunds` and counted as `refundsDue` on the overview; once you have refunded
one in the Paystack dashboard, record it there.

Every `needs_review` payment (counted on the admin overview) is the customer's money
sitting with Paystack. **Nothing refunds it automatically.** Refund it in Paystack's
dashboard and tell the seller and customer.

If online payments must be switched off quickly, clear `PAYSTACK_SECRET_KEY` on Render
and redeploy: every seller falls back to bank transfer and nothing else changes.

## 4b. Test and live: webhook, return pages and payout accounts

Paystack keeps **test** and **live** completely separate: keys, webhook and callback
addresses, and every seller's payout account (subaccount).

| Where | Setting | Value (both modes) |
|---|---|---|
| Paystack dashboard, the mode you are using | **Webhook URL** | `https://api.choplistafrica.com/api/webhooks/paystack` (server to server, POST only) |
| Paystack dashboard, the mode you are using | **Callback URL** | Leave empty, or a frontend page. **Never** the webhook address or anything under `/api`. The server sends its own for every payment |
| Render | `PAYSTACK_CALLBACK_URL` | `https://choplistafrica.com/paystack-return` |
| Render | `SUBSCRIPTION_CALLBACK_URL` | `https://choplistafrica.com/seller/billing/done` (a vendor lands here, signed in, and the page asks the API until the subscription is active) |

If a browser ever shows `{"error":{"code":"METHOD_NOT_ALLOWED"...}}` after paying, the
webhook address was used as a return page. The server refuses to start with a return
address under `/api`, on a webhook path or on an `api.` host.

The mode is read from the key (`sk_test_` or `sk_live_`), logged at startup as
`Paystack: test mode` or `Paystack: live mode` (never the key), and shown in the admin
system check (`paystack.mode`).

**Moving to live:** payout accounts made in test do not exist in live. After switching the
key, run the dry run, read it, then apply (take an Atlas snapshot first):

```
cd backend
npm run paystack:resubaccount             # dry run: counts only
npm run paystack:resubaccount -- --apply  # recreates each seller's payout account in the current mode
```

It never runs by itself and never prints the key, codes or account numbers. Sellers
without a stored bank code are listed in the count and must pick their bank again.

## 5. Before real money

None of this is done. Do not use a live key until all of it is.

- Paystack **business verification** is complete (live keys need it).
- `PAYSTACK_PRICING` in `backend/src/config.ts` was checked against
  https://paystack.com/pricing (the rate, the ₦100 fee, the ₦2,000 cap, and whether the
  ₦100 is waived on small payments: it is currently charged on every payment).
- The **live** webhook URL is set in Paystack (Section 2) and the Section 3 run was
  repeated with a small real payment.
- Someone owns refunds: who watches `paymentsNeedingReview`, and how fast they act.
- The customer is told, before paying, what the service fee is for (the frontend shows
  `serviceFee` before redirecting).
- Everything under "Known limits and follow-ups" in [api.md](api.md) has been read, and
  the ones that matter for your launch have an owner.
