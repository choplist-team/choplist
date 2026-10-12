import { apiRequest } from "./api-client";

export const getShop = (slug) => {
  return apiRequest(`/public/menu/${encodeURIComponent(slug)}`);
};

export const placeOrder = (order) => {
  return apiRequest("/public/orders", { method: "POST", body: order });
};

export const lookupOrder = (ref, phoneLast4) => {
  return apiRequest(
    `/public/orders/${encodeURIComponent(ref)}?phoneLast4=${encodeURIComponent(
      phoneLast4
    )}`
  );
};
