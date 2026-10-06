const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

export const apiRequest = async (endpoint, options = {}, getToken) => {
  const headers = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

if (options.requiresAuth) {
    const token = await getToken();
    if (!token) {
        throw new Error("Authentication required");
    }
    headers.Authorization = `Bearer ${token}`;
}
  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    ...options,
    headers,
  });
  if (!response.ok) {
    throw new Error(`API request failed with status ${response.status}`);
  }
  return response.json();
};
