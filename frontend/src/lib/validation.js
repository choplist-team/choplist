const NIGERIAN_PHONE = /^(?:\+234|234|0)[789]\d{9}$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ORDER_REF_PATTERN = /^CL-[2-9A-HJ-NP-Z]{5}$/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const LAGOS_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Lagos",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const formatDay = (day) =>
  new Intl.DateTimeFormat("en-NG", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(`${day}T00:00:00Z`));

const isRealDay = (day) => {
  if (!DAY_PATTERN.test(day)) return false;

  const parsed = new Date(`${day}T00:00:00Z`);

  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === day
  );
};

export const hasErrors = (errors) => Object.values(errors).some(Boolean);

function checkText(value, { label, min = 1, max, emptyMessage }) {
  const text = value.trim();

  if (!text) return emptyMessage;

  if (text.length < min) {
    return `${label} must be at least ${min} characters.`;
  }

  if (max && text.length > max) {
    return `${label} must be ${max} characters or fewer. It is currently ${text.length}.`;
  }

  return "";
}

export function checkNigerianPhone(value) {
  const phone = value.replace(/[\s\-().]/g, "");

  if (!phone) return "Enter your phone number.";

  if (!NIGERIAN_PHONE.test(phone)) {
    return "Enter a valid Nigerian mobile number, e.g. 0803 123 4567 or +234 803 123 4567.";
  }

  return "";
}

export function validateProfile(formData) {
  const errors = {
    businessName: checkText(formData.businessName, {
      label: "Business name",
      min: 2,
      max: 80,
      emptyMessage: "Enter your business name.",
    }),
    phone: checkNigerianPhone(formData.phone),
    bankName: checkText(formData.bankName, {
      label: "Bank name",
      min: 2,
      max: 60,
      emptyMessage: "Enter the name of your bank, e.g. GTBank.",
    }),
    accountName: checkText(formData.accountName, {
      label: "Account name",
      min: 2,
      max: 80,
      emptyMessage: "Enter the name on your bank account.",
    }),
  };

  if (!formData.accountNumber) {
    errors.accountNumber = "Enter your bank account number.";
  } else if (!/^\d+$/.test(formData.accountNumber)) {
    errors.accountNumber = "Account number can only contain digits.";
  } else if (formData.accountNumber.length !== 10) {
    errors.accountNumber = `Account number must be exactly 10 digits. You entered ${formData.accountNumber.length}.`;
  }

  const slug = formData.slug.trim().toLowerCase();

  if (slug) {
    if (slug.length < 3) {
      errors.slug = "Shop link must be at least 3 characters.";
    } else if (slug.length > 40) {
      errors.slug = "Shop link must be 40 characters or fewer.";
    } else if (!SLUG_PATTERN.test(slug)) {
      errors.slug =
        "Use only lowercase letters, numbers and single hyphens, e.g. mama-ts-kitchen.";
    }
  }

  return errors;
}

function checkWholeNumber(value, { label, min, max, emptyMessage }) {
  if (String(value).trim() === "") return emptyMessage;

  const number = Number(value);

  if (!Number.isFinite(number)) return `${label} must be a number.`;

  if (!Number.isInteger(number)) {
    return `${label} must be a whole number, without decimals.`;
  }

  if (number < min) return `${label} must be at least ${min.toLocaleString()}.`;

  if (number > max) return `${label} cannot be more than ${max.toLocaleString()}.`;

  return "";
}

export function validateMenu({ title, cutoffAt, items, areasText, deliveryDays }) {
  const errors = {};

  errors.title = checkText(title, {
    label: "Menu title",
    max: 80,
    emptyMessage: "Enter a title for this menu, e.g. Week of 3 Oct.",
  });

  let cutoffDay = "";
  const cutoffDate = cutoffAt ? new Date(cutoffAt) : null;

  if (!cutoffAt) {
    errors.cutoffAt = "Choose the date and time when orders should close.";
  } else if (Number.isNaN(cutoffDate.getTime())) {
    errors.cutoffAt = "Enter a valid order cutoff date and time.";
  } else if (cutoffDate.getTime() <= Date.now()) {
    errors.cutoffAt = "The order cutoff must be in the future.";
  } else {
    cutoffDay = LAGOS_DAY.format(cutoffDate);
  }

  if (items.length < 1) {
    errors.items = "Add at least one dish.";
  } else if (items.length > 30) {
    errors.items = "A menu can have at most 30 dishes.";
  }

  items.forEach((item, index) => {
    errors[`item-${index}-name`] = checkText(item.name, {
      label: "Dish name",
      max: 80,
      emptyMessage: "Enter the name of this dish.",
    });

    if (item.description.trim().length > 300) {
      errors[`item-${index}-description`] =
        `Description must be 300 characters or fewer. It is currently ${item.description.trim().length}.`;
    }

    errors[`item-${index}-price`] = checkWholeNumber(item.price, {
      label: "Price",
      min: 1,
      max: 1_000_000,
      emptyMessage: "Enter a price in naira.",
    });

    errors[`item-${index}-qty`] = checkWholeNumber(item.qty, {
      label: "Portions",
      min: 1,
      max: 1000,
      emptyMessage: "Enter how many portions are available.",
    });
  });

  const seenDays = new Set();

  deliveryDays.forEach((day, index) => {
    const key = `deliveryDay-${index}`;

    if (!day) {
      errors[key] =
        deliveryDays.length > 1
          ? "Choose a delivery date or remove this row."
          : "Choose at least one delivery date.";
    } else if (!isRealDay(day)) {
      errors[key] = "Enter a valid delivery date.";
    } else if (seenDays.has(day)) {
      errors[key] = "This date is already listed. Choose a different date.";
    } else if (cutoffDay && day < cutoffDay) {
      errors[key] = `Delivery date cannot be before the order cutoff date (${formatDay(cutoffDay)}).`;
    }

    if (day) seenDays.add(day);
  });

  if (deliveryDays.length === 0) {
    errors.deliveryDays = "Add at least one delivery date.";
  } else if (deliveryDays.length > 14) {
    errors.deliveryDays = "You can add at most 14 delivery dates.";
  }

  const areas = [
    ...new Set(
      areasText
        .split(",")
        .map((area) => area.trim())
        .filter(Boolean)
    ),
  ];

  const longArea = areas.find((area) => area.length > 60);

  if (areas.length === 0) {
    errors.areas =
      "Enter at least one delivery area, e.g. Yaba, Surulere, Lekki.";
  } else if (areas.length > 30) {
    errors.areas = `You can list at most 30 delivery areas. You entered ${areas.length}.`;
  } else if (longArea) {
    errors.areas = `"${longArea.slice(0, 20)}..." is too long. Each area must be 60 characters or fewer.`;
  }

  return {
    errors,
    menu: {
      title: title.trim(),
      cutoffAt: cutoffDate && !errors.cutoffAt ? cutoffDate.toISOString() : "",
      items: items.map((item) => ({
        name: item.name.trim(),
        description: item.description.trim(),
        price: Number(item.price),
        qty: Number(item.qty),
      })),
      areas,
      deliveryDays: deliveryDays.filter(Boolean),
    },
  };
}

export function validateOrder({ customer, delivery, note }) {
  return {
    name: checkText(customer.name, {
      label: "Full name",
      max: 80,
      emptyMessage: "Enter your full name so the kitchen knows who the order is for.",
    }),
    phone: checkNigerianPhone(customer.phone),
    area: delivery.area ? "" : "Choose the area you want your food delivered to.",
    address: checkText(delivery.address, {
      label: "Delivery address",
      min: 5,
      max: 300,
      emptyMessage: "Enter your street address and any directions for the rider.",
    }),
    day: delivery.day ? "" : "Choose the day you want your food delivered.",
    note:
      note.trim().length > 300
        ? `Note must be 300 characters or fewer. It is currently ${note.trim().length}.`
        : "",
  };
}

export function validateOrderLookup({ reference, phoneLast4 }) {
  const ref = reference.trim().toUpperCase();
  const errors = {};

  if (!ref) {
    errors.reference = "Enter the order reference from your confirmation, e.g. CL-7KQ2M.";
  } else if (!ORDER_REF_PATTERN.test(ref)) {
    errors.reference =
      "Order references start with CL- followed by 5 letters or numbers, e.g. CL-7KQ2M.";
  }

  if (!phoneLast4) {
    errors.phoneLast4 = "Enter the last 4 digits of the phone number you ordered with.";
  } else if (!/^\d{4}$/.test(phoneLast4)) {
    errors.phoneLast4 = `Enter exactly 4 digits. You entered ${phoneLast4.length}.`;
  }

  return errors;
}
