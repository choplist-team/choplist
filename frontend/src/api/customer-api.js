import { getOrderKey, saveOrderKey } from "@/lib/order-keys";
import { apiRequest } from "./api-client";

export const getShop = (slug) => {
  return apiRequest(`/public/menu/${encodeURIComponent(slug)}`);
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
