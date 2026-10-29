// The admin analytics count how often a shop's menu is opened. The page tells the
// server once per browser session per shop, not on every refresh or refetch, so
// one customer refreshing does not look like many. sessionStorage is cleared when
// the tab closes, so coming back tomorrow counts again, which is what we want.
//
// This must never get in the customer's way: no storage, no network, or a server
// error just means the view is not counted.

const STORAGE_KEY = "choplist.viewedShops";

const readViewed = () => {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

// True the first time it is called for a slug in this session, false after.
export const shouldCountView = (slug) => {
  const key = String(slug ?? "").toLowerCase();
  if (!key) return false;
  const viewed = readViewed();
  if (viewed.includes(key)) return false;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...viewed, key]));
  } catch {
    // Storage unavailable: count this view, and possibly again on the next load.
  }
  return true;
};
