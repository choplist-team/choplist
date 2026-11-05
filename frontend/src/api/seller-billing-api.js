import { apiRequest } from "./api-client";

// Calls a seller makes about their free trial, subscription, share link and
// notifications. Same style as seller-api.js: every call takes Clerk's getToken last.
// What each route returns is described in docs/api.md ("Vendor billing" and "Notifications").

// Where the seller stands: state ("trial", "active" or "expired"), canShareLink, trial
// dates, the current subscription, when paid cover ends, and the plans with prices.
export const getSellerBilling = (getToken) =>
  apiRequest("/sellers/me/billing", { requiresAuth: true }, getToken);

// The seller's shop link. The server REFUSES (403 SHARING_NOT_ALLOWED) once the free
// trial has ended and there is no active subscription, so the share button asks first.
export const getShareLink = (getToken) =>
  apiRequest("/sellers/me/share", { requiresAuth: true }, getToken);

// Starts paying for a plan ("monthly" or "quarterly"). Returns { authorizationUrl,
// reference, plan, amountNaira }: send the seller to authorizationUrl. Nothing is
// active until Paystack confirms the payment to the server.
export const startSubscription = (plan, getToken) =>
  apiRequest(
    "/sellers/me/billing/subscribe",
    { method: "POST", requiresAuth: true, body: { plan } },
    getToken
  );

// One payment attempt, by its reference. The page the seller lands on after Paystack
// asks this until status is "active".
export const getSubscriptionStatus = (reference, getToken) =>
  apiRequest(
    `/sellers/me/billing/subscriptions/${encodeURIComponent(reference)}`,
    { requiresAuth: true },
    getToken
  );

// The seller's own payments and renewals, newest first.
export const getSubscriptionHistory = (getToken) =>
  apiRequest("/sellers/me/billing/subscriptions", { requiresAuth: true }, getToken);

// The seller's bell.
export const getSellerNotifications = (getToken, { unread = false, limit = 20 } = {}) => {
  const params = new URLSearchParams({ limit: String(limit) });
  if (unread) params.set("unread", "true");
  return apiRequest(`/sellers/me/notifications?${params.toString()}`, { requiresAuth: true }, getToken);
};

// body is { all: true } or { ids: ["..."] }
export const markSellerNotificationsRead = (body, getToken) =>
  apiRequest(
    "/sellers/me/notifications/read",
    { method: "POST", requiresAuth: true, body },
    getToken
  );
