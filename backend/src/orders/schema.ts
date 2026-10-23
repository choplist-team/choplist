import { z } from 'zod';
import { DELIVERY_CODE_LENGTH, DELIVERY_CODE_PATTERN } from './delivery-code.js';

// Exactly the digits, as a string: "012345" is a valid code and 12345 is not.
// A malformed code is rejected here, before it can count as a wrong guess.
export const confirmDeliverySchema = z.object({
  code: z.string().regex(DELIVERY_CODE_PATTERN, `Enter the ${DELIVERY_CODE_LENGTH}-digit code`),
});
