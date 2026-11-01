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
| `PAYSTACK_CALLBACK_URL` | The frontend page Paystack sends the customer back to after paying, e.g. `https://choplistafrica.com/pay/done`. **Agree the page with the frontend team first** |
| `FREE_ORDERS` | `50` (a seller's first 50 online-paid orders carry no ChopList fee) |
| `PLATFORM_FEE_BPS` | `300` (3%, in basis points) |

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

Every `needs_review` payment (counted on the admin overview) is the customer's money
sitting with Paystack. **Nothing refunds it automatically.** Refund it in Paystack's
dashboard and tell the seller and customer.

If online payments must be switched off quickly, clear `PAYSTACK_SECRET_KEY` on Render
and redeploy: every seller falls back to bank transfer and nothing else changes.

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
