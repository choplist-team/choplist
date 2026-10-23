// Each order has a secret access key, returned once by POST /public/orders. The
// lookup sends it as the X-Order-Key header; it is what lets the server show the
// delivery code to the customer and not to the seller (who also knows the order
// reference and the phone digits). The key lives only in this browser.

const STORAGE_KEY = "choplist.orderKeys";

const normalise = (ref) => String(ref ?? "").trim().toUpperCase();

// localStorage can be missing or throw (private windows, blocked site data), and
// the stored value could be damaged. The page must work without it.
const readAll = () => {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
};

export const saveOrderKey = (ref, accessKey) => {
  if (!ref || !accessKey) return;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...readAll(), [normalise(ref)]: accessKey })
    );
  } catch {
    // Storage unavailable: the customer just will not see the code on this device.
  }
};

export const getOrderKey = (ref) => {
  const key = readAll()[normalise(ref)];
  return typeof key === "string" ? key : undefined;
};
