import { apiRequest } from "./api-client";

export function getAdminOverview(getToken) {
  return apiRequest("/admin/overview", { requiresAuth: true }, getToken);
}

export function getAdminSellers(
  getToken,
  { q = "", status = "", page = 1, limit = 20 } = {}
) {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
  });

  if (q.trim()) {
    params.set("q", q.trim());
  }

  if (status) {
    params.set("status", status);
  }

  return apiRequest(
    `/admin/sellers?${params.toString()}`,
    { requiresAuth: true },
    getToken
  );
}

export function getAdminSeller(getToken, sellerId) {
  return apiRequest(
    `/admin/sellers/${encodeURIComponent(sellerId)}`,
    { requiresAuth: true },
    getToken
  );
}

export function suspendAdminSeller(getToken, sellerId, reason) {
  return apiRequest(
    `/admin/sellers/${encodeURIComponent(sellerId)}/suspend`,
    {
      method: "PATCH",
      requiresAuth: true,
      body: { reason: reason.trim() },
    },
    getToken
  );
}

export function deactivateAdminSeller(getToken, sellerId, reason) {
  return apiRequest(
    `/admin/sellers/${encodeURIComponent(sellerId)}/deactivate`,
    {
      method: "PATCH",
      requiresAuth: true,
      body: { reason: reason.trim() },
    },
    getToken
  );
}

export function reinstateAdminSeller(getToken, sellerId, reason = "") {
  const trimmedReason = reason.trim();

  return apiRequest(
    `/admin/sellers/${encodeURIComponent(sellerId)}/reinstate`,
    {
      method: "PATCH",
      requiresAuth: true,
      body: trimmedReason ? { reason: trimmedReason } : {},
    },
    getToken
  );
}
