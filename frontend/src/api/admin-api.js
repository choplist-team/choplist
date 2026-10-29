import { apiRequest } from "./api-client";

export function getAdminOverview(getToken) {
  return apiRequest("/admin/overview", { requiresAuth: true }, getToken);
}
