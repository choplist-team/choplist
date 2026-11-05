import { ApiError } from "@/api/api-client";

// Plain helpers for the admin money pages: how numbers, naira and dates are shown, and
// how an error is put into words. Kept apart from admin-ui.jsx because a file of
// components should not also export functions (the dev server's fast refresh needs that).

export function formatNumber(value) {
  return typeof value === "number" ? new Intl.NumberFormat("en-NG").format(value) : "—";
}

export function formatNaira(value) {
  return typeof value === "number"
    ? new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", maximumFractionDigits: 2 }).format(value)
    : "—";
}

export function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-NG", { dateStyle: "medium", timeStyle: "short" });
}

export function getErrorMessage(error) {
  if (error instanceof ApiError && error.status === 403) {
    return "Access denied. Your account is not authorized to access the admin workspace.";
  }
  if (error instanceof ApiError && error.status === 401) {
    return "Your session is missing or has expired. Please sign in again.";
  }
  return error?.message || "Something went wrong. Please try again.";
}
