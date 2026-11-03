const STORAGE_KEY = "choplist.paymentAttempt";

export const savePaymentAttempt = (orderRef, paymentReference) => {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        orderRef,
        paymentReference,
      })
    );
  } catch {
    // Do not redirect if the attempt details could not be saved.
    throw new Error(
      "Unable to save your payment details. Please try again."
    );
  }
};

export const getPaymentAttempt = () => {
  try {
    const attempt = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? "null"
    );

    return attempt &&
      typeof attempt.orderRef === "string" &&
      typeof attempt.paymentReference === "string"
      ? attempt
      : null;
  } catch {
    return null;
  }
};

export const clearPaymentAttempt = () => {
  localStorage.removeItem(STORAGE_KEY);
};