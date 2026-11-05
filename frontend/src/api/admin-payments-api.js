import { apiRequest } from "./api-client";

// Calls for the admin pages about money: refunds, payment problems, subscriptions,
// the inbox and the system check. The contract for each is in docs/api.md. Every call
// needs an admin sign-in, so it takes Clerk's getToken like the rest of admin-api.js.

function listParams({ page = 1, limit = 20, ...filters } = {}) {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      params.set(key, String(value).trim());
    }
  }
  return params.toString();
}

const withNote = (note) => {
  const trimmed = (note ?? "").trim();
  return trimmed ? { note: trimmed } : {};
};

// ---- System check: is this server set up right? ------------------------------------
export function getAdminSystem(getToken) {
  return apiRequest("/admin/system", { requiresAuth: true }, getToken);
}

// ---- Refunds owed to customers (refunded by hand in Paystack, recorded here) --------
export function getAdminRefunds(getToken, options) {
  return apiRequest(`/admin/refunds?${listParams(options)}`, { requiresAuth: true }, getToken);
}

export function markAdminRefunded(getToken, refundId, note) {
  return apiRequest(
    `/admin/refunds/${encodeURIComponent(refundId)}/mark-refunded`,
    { method: "PATCH", requiresAuth: true, body: withNote(note) },
    getToken,
  );
}

// ---- Payment problems raised by customers and sellers --------------------------------
export function getAdminPaymentQueries(getToken, options) {
  return apiRequest(`/admin/payment-queries?${listParams(options)}`, { requiresAuth: true }, getToken);
}

// The note is shown to the person who raised the problem, so it is a reply.
export function resolveAdminPaymentQuery(getToken, queryId, note) {
  return apiRequest(
    `/admin/payment-queries/${encodeURIComponent(queryId)}/resolve`,
    { method: "PATCH", requiresAuth: true, body: withNote(note) },
    getToken,
  );
}

// ---- Vendor subscriptions ----------------------------------------------------------
export function getAdminSubscriptions(getToken, options) {
  return apiRequest(`/admin/subscriptions?${listParams(options)}`, { requiresAuth: true }, getToken);
}

// A free subscription. The note (a reason) is required by the API.
export function grantAdminSubscription(getToken, sellerId, { plan, note }) {
  return apiRequest(
    `/admin/sellers/${encodeURIComponent(sellerId)}/subscriptions`,
    { method: "POST", requiresAuth: true, body: { plan, note: (note ?? "").trim() } },
    getToken,
  );
}

export function cancelAdminSubscription(getToken, subscriptionId, note) {
  return apiRequest(
    `/admin/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`,
    { method: "PATCH", requiresAuth: true, body: withNote(note) },
    getToken,
  );
}

export function markAdminSubscriptionRefunded(getToken, subscriptionId, note) {
  return apiRequest(
    `/admin/subscriptions/${encodeURIComponent(subscriptionId)}/mark-refunded`,
    { method: "PATCH", requiresAuth: true, body: withNote(note) },
    getToken,
  );
}

// Verification is only recorded: it blocks and unlocks nothing yet.
export function setAdminVerification(getToken, sellerId, { status, note }) {
  return apiRequest(
    `/admin/sellers/${encodeURIComponent(sellerId)}/verification`,
    { method: "PATCH", requiresAuth: true, body: { status, ...withNote(note) } },
    getToken,
  );
}

// ---- ChopList's own inbox -------------------------------------------------------------
export function getAdminNotifications(getToken, { unread = false, limit = 30 } = {}) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (unread) params.set("unread", "true");
  return apiRequest(`/admin/notifications?${params.toString()}`, { requiresAuth: true }, getToken);
}

// Pass { all: true } or { ids: [...] }.
export function markAdminNotificationsRead(getToken, body) {
  return apiRequest(
    "/admin/notifications/read",
    { method: "POST", requiresAuth: true, body },
    getToken,
  );
}
