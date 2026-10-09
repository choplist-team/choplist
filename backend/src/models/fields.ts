// Field rules shared by the models. These are the last line of defence: request
// bodies are validated with zod before they reach a model.
//
// Note: Mongoose runs these on create/save, NOT on updateOne with $inc. The
// schema alone cannot stop stock going negative; the ordering query does that.

// Money is whole naira, quantities are whole portions.
export function wholeNumber(min: number) {
  return {
    type: Number,
    required: true,
    min,
    validate: { validator: Number.isInteger, message: '{PATH} must be a whole number' },
  };
}

// A calendar day with no time, e.g. "2026-10-17". Stored as text so time zones
// can never move it to the day before.
export const DAY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

// Nigerian mobile in one normalised form, so "0803 123 4567" and "+2348031234567"
// are the same customer and the last 4 digits are always phone.slice(-4).
export const PHONE_PATTERN = /^\+234\d{10}$/;
