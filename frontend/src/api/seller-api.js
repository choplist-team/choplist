import { apiRequest } from "./api-client";

export const getCurrentSeller = (getToken) => {
  return apiRequest("/sellers/me", { requiresAuth: true }, getToken);
};

export const saveSellerProfile = (profile, getToken) => {
  return apiRequest(
    "/sellers/me",
    { method: "PUT", requiresAuth: true, body: profile },
    getToken
  );
};

export const postMenu = (menu, getToken) => {
  return apiRequest(
    "/menus",
    { method: "POST", requiresAuth: true, body: menu },
    getToken
  );
};

export const getMenus = (getToken) => {
  return apiRequest("/menus", { requiresAuth: true }, getToken);
};

export const getMenuById = (id, getToken) => {
  return apiRequest(
    `/menus/${encodeURIComponent(id)}`,
    { requiresAuth: true },
    getToken
  );
};

export const updateMenu = (id, menu, getToken) => {
  return apiRequest(
    `/menus/${encodeURIComponent(id)}`,
    { method: "PUT", requiresAuth: true, body: menu },
    getToken
  );
};

export const openMenu = (id, getToken) => {
  return apiRequest(
    `/menus/${encodeURIComponent(id)}/open`,
    {
      method: "POST",
      requiresAuth: true,
    },
    getToken
  );
};

export const closeMenu = (id, getToken) => {
  return apiRequest(
    `/menus/${encodeURIComponent(id)}/close`,
    {
      method: "POST",
      requiresAuth: true,
    },
    getToken
  );
};

export const getMenuOrders = (id, getToken, status) => {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";

  return apiRequest(
    `/menus/${encodeURIComponent(id)}/orders${query}`,
    {
      requiresAuth: true,
    },
    getToken
  );
};

export const markOrderAsPaid = (ref, getToken) => {
  return apiRequest(
    `/orders/${encodeURIComponent(ref)}/paid`,
    {
      method: "PATCH",
      requiresAuth: true,
    },
    getToken
  );
};

export const cancelOrder = (ref, getToken) => {
  return apiRequest(
    `/orders/${encodeURIComponent(ref)}/cancel`,
    {
      method: "PATCH",
      requiresAuth: true,
    },
    getToken
  );
};

export const outForDelivery = (ref, getToken) => {
  return apiRequest(
    `/orders/${encodeURIComponent(ref)}/out-for-delivery`,
    {
      method: "PATCH",
      requiresAuth: true,
    },
    getToken
  );
};

export const confirmDelivery = (ref, code, getToken) => {
  return apiRequest(
    `/orders/${encodeURIComponent(ref)}/confirm-delivery`,
    {
      method: "PATCH",
      requiresAuth: true,
      body: {code}
    },
    getToken
  );
};


export const resetDeliveryCode = (ref, getToken) => {
  return apiRequest(
    `/orders/${encodeURIComponent(ref)}/reset-delivery-code`,
    {
      method: "PATCH",
      requiresAuth: true,
    },
    getToken
  );
};


export const getMenuPrepSheet = (id, getToken, paidOnly = false) => {
  return apiRequest(
    `/menus/${encodeURIComponent(id)}/prep-sheet?paidOnly=${paidOnly}`,
    {
      requiresAuth: true,
    },
    getToken
  );
};

export const getMenuDeliveryList = (
  id,
  getToken,
  { day, paidOnly = false } = {}
) => {
  const params = new URLSearchParams();

  if (day) {
    params.set("day", day);
  }

  params.set("paidOnly", String(paidOnly));

  return apiRequest(
    `/menus/${encodeURIComponent(id)}/delivery-list?${params.toString()}`,
    {
      requiresAuth: true,
    },
    getToken
  );
};
