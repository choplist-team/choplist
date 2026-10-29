import { apiRequest } from "./api-client";

export function getAdminOverview(getToken) {
  return apiRequest("/admin/overview", { requiresAuth: true }, getToken);
}


export function getAdminSellers(
  getToken,
  { q = "", status = "", page = 1, limit = 20 } = {},
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
    getToken,
  );
}

export function getAdminSeller(getToken, sellerId) {
  return apiRequest(
    `/admin/sellers/${encodeURIComponent(sellerId)}`,
    { requiresAuth: true },
    getToken,
  );
}