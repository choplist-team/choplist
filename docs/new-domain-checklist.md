# Moving to choplistafrica.com: checklist

Target: frontend on `https://choplistafrica.com` (and `www`), API on
`https://api.choplistafrica.com`. The old addresses
(`choplist.onrender.com`, `choplist-api.onrender.com`) keep working the whole time,
so nothing here breaks the live site until the frontend is deliberately switched.

Steps marked **(you)** are in dashboards the code cannot reach. Steps marked
**(frontend team)** are not backend work. Where a dashboard shows an exact value
(a DNS target, a record), **copy what the dashboard shows**: it is the truth, and
this page only says where to look.

## How the backend decides who may call it

- `ALLOWED_ORIGINS` is an exact-match list of browser origins (scheme + host +
  port). `https://choplistafrica.com` and `https://www.choplistafrica.com` are two
  entries. There are no wildcards.
- The same list is also what Clerk sign-in tokens are checked against. If an origin
  is missing you get CORS errors **and** `401` on sign-in.
- The API never looks at which hostname was used, so one service answers on both
  `choplist-api.onrender.com` and `api.choplistafrica.com`.
- Auth is a bearer header, not cookies. There are no cookie or SameSite settings to
  change.

## A. Put the API on api.choplistafrica.com

1. **(you) Render, API service > Settings > Custom Domains > Add**
   `api.choplistafrica.com`. Render shows the DNS target to point at (expected to be
   `choplist-api.onrender.com`).
2. **(you) Namecheap > Domain List > Manage > Advanced DNS > Add New Record:**
   type `CNAME`, host `api`, value = the target Render showed, TTL Automatic.
3. **(you)** Back in Render, press Verify. The HTTPS certificate is issued by Render
   automatically; it can take several minutes. Check the domain shows as verified.
4. **(you) Render, API service > Environment:** set

   ```
   ALLOWED_ORIGINS=https://choplistafrica.com,https://www.choplistafrica.com,https://choplist.onrender.com
   ```

   (add `,http://localhost:5173` only if you want local frontends to reach the live
   API). Save, and make sure a deploy runs (**redeploy** if Render did not start one).
   The values are read at startup, so nothing changes until the new deploy is live.
   The first log line should now say `(3 allowed origins)`.

   There is no `FRONTEND_URL` setting: nothing in the API reads one. (The Paystack
   work adds `PAYSTACK_CALLBACK_URL`.)

## B. Check it from the command line

Replace nothing; run these as they are (PowerShell: use `curl.exe`).

```
# 1. Health on both hostnames: expect 200 and {"status":"ok"} each time
curl.exe -i https://choplist-api.onrender.com/health
curl.exe -i https://api.choplistafrica.com/health

# 2. The new site is allowed: expect  access-control-allow-origin: https://choplistafrica.com
curl.exe -i -X OPTIONS https://api.choplistafrica.com/api/public/orders/CL-AAAAA ^
  -H "Origin: https://choplistafrica.com" ^
  -H "Access-Control-Request-Method: GET" ^
  -H "Access-Control-Request-Headers: authorization,x-order-key,content-type"

# 3. Same for  https://www.choplistafrica.com  and  https://choplist.onrender.com

# 4. A stranger is refused: expect NO access-control-allow-origin line at all
curl.exe -i -X OPTIONS https://api.choplistafrica.com/api/public/orders/CL-AAAAA ^
  -H "Origin: https://evil.example" ^
  -H "Access-Control-Request-Method: GET"
```

(`^` continues a line in cmd; in PowerShell put it all on one line.)

## C. Re-measure TRUST_PROXY_HOPS on the new hostname

`TRUST_PROXY_HOPS=3` was measured on the `onrender.com` address. A custom domain can
pass through a different number of proxies. Wrong too low: customers share one
rate-limit counter. Wrong too high: a client can fake its address. Repeat the ten-
request test in `backend/README.md` (the `ratelimit-policy` check) against
`https://api.choplistafrica.com/...` and confirm the result is the same as before.

## D. UptimeRobot

Point the monitor at `https://api.choplistafrica.com/health` once step B passes
(keep the old monitor until then). `/health` does not touch the database, so it
answers even if MongoDB is down, and a 5-minute ping stops the free instance
sleeping. Render's free tier sleeps after a period of inactivity (check Render's
docs for the current figure); the first visitor after a sleep waits for a cold start
of tens of seconds.

## E. Frontend team (not backend work)

Do these only after A and B pass:

- Add `choplistafrica.com` and `www.choplistafrica.com` as custom domains on the
  frontend Render service, and replace the Namecheap parking records for the apex
  and `www` with the records Render shows. (Today `www` is a CNAME to
  `parkingpage.namecheap.com` and the apex is on Namecheap's parking page.)
- Change `VITE_API_BASE_URL` to `https://api.choplistafrica.com/api` and rebuild.
  It is baked in at build time, so until the rebuild the new site would still call
  the old API.
- Decide which of apex and `www` is the main one and redirect the other to it.

## F. Clerk

Clerk is a separate service, and it decides whether sign-in works on the new site.

1. **Which keys are we using?** Check `CLERK_PUBLISHABLE_KEY` on Render. `pk_test_`
   is a **development** instance; `pk_live_` is **production**. (At the time of
   writing the deployed site uses `pk_test_`.)
2. **Development instance (`pk_test_`):** sign-in works from any site, so after step
   A.4 it works on the new domain with no Clerk setting changed. It is not meant for
   real customers: it has a user cap and shows a development banner.
3. **Production instance (`pk_live_`):** it is tied to the domain it was created for.
   Clerk dashboard > switch to Production > Domains, enter `choplistafrica.com`, then
   add the DNS records Clerk lists to Namecheap, and wait until Clerk shows them
   verified. If sign-in uses Google or another social provider, production needs
   your own OAuth credentials for it: check the Clerk docs for that provider.
4. **Do not switch instances casually.** Development and production are separate
   user lists with different user ids. Every seller is linked to their Clerk user id,
   so after a switch existing sellers could not reach their shops, and the ids in
   `ADMIN_CLERK_USER_IDS` stop matching (admins locked out). Switching also means
   new `CLERK_SECRET_KEY`/`CLERK_PUBLISHABLE_KEY` on the API and the matching
   publishable key on the frontend. If you will switch, do it before real sellers
   exist or plan a migration first.

## Rolling back

Remove the new origins from `ALLOWED_ORIGINS` and redeploy. The old addresses never
stopped working, so nothing else needs undoing.
