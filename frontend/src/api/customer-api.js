import { shouldCountView } from "@/lib/menu-views";
import { getOrderKey, saveOrderKey } from "@/lib/order-keys";
import { apiRequest } from "./api-client";

export const getShop = async (slug) => {
  const shop = await apiRequest(`/public/menu/${encodeURIComponent(slug)}`);
  // Tell the server the menu was opened (once per session per shop), without
  // waiting for it and without ever letting it fail the page.
  if (shop?.menu && shouldCountView(slug)) {
    apiRequest(`/public/menu/${encodeURIComponent(slug)}/view`, { method: "POST" }).catch(
      () => {}
    );
  }
  return shop;
};

export const placeOrder = async (order) => {
  const result = await apiRequest("/public/orders", {
    method: "POST",
    body: order,
  });
  // The key is shown once. Keep it with the reference, in this browser.
  saveOrderKey(result?.order?.ref, result?.accessKey);
  return result;
};

export const lookupOrder = (ref, phoneLast4) => {
  const accessKey = getOrderKey(ref);
  return apiRequest(
    `/public/orders/${encodeURIComponent(ref)}?phoneLast4=${encodeURIComponent(
      phoneLast4
    )}`,
    accessKey ? { headers: { "X-Order-Key": accessKey } } : {}
  );
};

// "My order is missing". The server always answers { received: true }, whether
// or not it found an order, and the page must not say otherwise.
export const reportMissingOrder = ({ ref, phoneLast4, message }) =>
  apiRequest("/public/orders/report-missing", {
    method: "POST",
    body: { ref, phoneLast4, message },
  });
