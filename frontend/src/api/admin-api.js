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


export function getAdminOrders(
  getToken,
  {
    ref = "",
    sellerId = "",
    from = "",
    to = "",
    status = [],
    flag = "",
    page = 1,
    limit = 20,
  } = {},
) {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
  });

  if (ref.trim()) params.set("ref", ref.trim());
  if (sellerId.trim()) params.set("sellerId", sellerId.trim());
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (flag) params.set("flag", flag);

  // The API accepts comma-separated statuses.
  const statuses = Array.isArray(status) ? status : [status];
  const selectedStatuses = statuses.filter(Boolean);

  if (selectedStatuses.length > 0) {
    params.set("status", selectedStatuses.join(","));
  }

  return apiRequest(
    `/admin/orders?${params.toString()}`,
    { requiresAuth: true },
    getToken,
  );
}

export function getAdminOrder(getToken, ref, { reveal = false } = {}) {
  const params = new URLSearchParams({
    reveal: String(reveal),
  });

  return apiRequest(
    `/admin/orders/${encodeURIComponent(ref)}?${params.toString()}`,
    { requiresAuth: true },
    getToken,
  );
}


export function getAdminMenuAnalytics(
  getToken,
  { from = "", to = "", page = 1, limit = 20 } = {},
) {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
  });

  if (from) params.set("from", from);
  if (to) params.set("to", to);

  return apiRequest(
    `/admin/analytics/menus?${params.toString()}`,
    { requiresAuth: true },
    getToken,
  );
}

export function getAdminItemAnalytics(
  getToken,
  {
    from = "",
    to = "",
    sellerId = "",
    page = 1,
    limit = 10,
  } = {},
) {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
  });

  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (sellerId.trim()) params.set("sellerId", sellerId.trim());

  return apiRequest(
    `/admin/analytics/items?${params.toString()}`,
    { requiresAuth: true },
    getToken,
  );
}

export function getAdminCustomerAnalytics(
  getToken,
  { from = "", to = "" } = {},
) {
  const params = new URLSearchParams();

  if (from) params.set("from", from);
  if (to) params.set("to", to);

  const query = params.toString();

  return apiRequest(
    `/admin/analytics/customers${query ? `?${query}` : ""}`,
    { requiresAuth: true },
    getToken,
  );
}


export function getAdminHealth(getToken) {
  return apiRequest("/admin/health", { requiresAuth: true }, getToken);
}

export function getAdminEvents(
  getToken,
  {
    type = "",
    level = "",
    sellerId = "",
    from = "",
    to = "",
    page = 1,
    limit = 20,
  } = {},
) {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
  });

  if (type) params.set("type", type);
  if (level) params.set("level", level);
  if (sellerId.trim()) params.set("sellerId", sellerId.trim());
  if (from) params.set("from", from);
  if (to) params.set("to", to);

  return apiRequest(
    `/admin/events?${params.toString()}`,
    { requiresAuth: true },
    getToken,
  );
}

export function getAdminReports(
  getToken,
  { status = "", page = 1, limit = 20 } = {},
) {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
  });

  if (status) params.set("status", status);

  return apiRequest(
    `/admin/reports?${params.toString()}`,
    { requiresAuth: true },
    getToken,
  );
}

export function resolveAdminReport(getToken, reportId, note = "") {
  const trimmedNote = note.trim();

  return apiRequest(
    `/admin/reports/${encodeURIComponent(reportId)}/resolve`,
    {
      method: "PATCH",
      requiresAuth: true,
      body: trimmedNote ? { note: trimmedNote } : {},
    },
    getToken,
  );
}

export function getAdminAudit(
  getToken,
  {
    adminId = "",
    action = "",
    targetId = "",
    from = "",
    to = "",
    page = 1,
    limit = 20,
  } = {},
) {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
  });

  if (adminId.trim()) params.set("adminId", adminId.trim());
  if (action) params.set("action", action);
  if (targetId.trim()) params.set("targetId", targetId.trim());
  if (from) params.set("from", from);
  if (to) params.set("to", to);

  return apiRequest(
    `/admin/audit?${params.toString()}`,
    { requiresAuth: true },
    getToken,
  );
}

