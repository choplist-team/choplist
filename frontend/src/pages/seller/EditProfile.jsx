import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCurrentSeller } from "@/hooks/useCurrentSeller";
import { useSaveSellerProfile } from "@/hooks/useSaveSellerProfile";
import { ApiError } from "@/api/api-client";
import { ChopListLogo } from "@/components/choplist-logo";
import SellerBottomNav from "@/components/seller/BottomNav";

const emptyProfile = {
  businessName: "",
  phone: "",
  bankName: "",
  accountNumber: "",
  accountName: "",
  slug: "",
};

function getProfileForm(seller) {
  return {
    businessName: seller?.businessName ?? "",
    phone: seller?.phone ?? "",
    bankName: seller?.payment?.bankName ?? "",
    accountNumber: seller?.payment?.accountNumber ?? "",
    accountName: seller?.payment?.accountName ?? "",
    slug: seller?.slug ?? "",
  };
}

export default function EditProfile() {
  const navigate = useNavigate();
  const sellerQuery = useCurrentSeller();
  const seller = sellerQuery.data;

  if (sellerQuery.isPending) {
    return (
      <main className="min-h-[100dvh] bg-background px-4 py-10">
        <div className="mx-auto max-w-[420px] text-center">
          <p className="text-muted-foreground">Loading your profile...</p>
        </div>
      </main>
    );
  }

  if (sellerQuery.isError) {
    const isProfileRequired =
      sellerQuery.error instanceof ApiError &&
      sellerQuery.error.code === "PROFILE_REQUIRED";

    if (!isProfileRequired) {
      return (
        <main className="min-h-[100dvh] bg-background px-4 py-10">
          <div className="mx-auto max-w-[420px]">
            <ChopListLogo />
            <h1 className="mt-8 text-xl font-bold text-foreground">
              Couldn't load your profile
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {sellerQuery.error?.message ||
                "Please check your connection and try again."}
            </p>
            <button
              type="button"
              onClick={() => sellerQuery.refetch()}
              className="mt-5 rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => navigate("/seller/dashboard")}
              className="ml-3 text-sm font-medium text-primary"
            >
              Back to dashboard
            </button>
          </div>
        </main>
      );
    }

    return <EditProfileForm key="new-seller-profile" seller={null} />;
  }

  return (
    <EditProfileForm
      key={seller?.id ?? seller?.slug ?? "seller-profile"}
      seller={seller ?? null}
    />
  );
}

function EditProfileForm({ seller }) {
  const navigate = useNavigate();
  const saveProfile = useSaveSellerProfile();

  const [formData, setFormData] = useState(() =>
    seller ? getProfileForm(seller) : { ...emptyProfile }
  );
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState("");

  function handleChange(event) {
    const { name, value } = event.target;

    setFormData((current) => ({
      ...current,
      [name]: value,
    }));

    setErrors((current) => ({
      ...current,
      [name]: "",
    }));

    setFormError("");
  }

  function validateForm() {
    const nextErrors = {};

    if (!formData.businessName.trim()) {
      nextErrors.businessName = "Enter your business name.";
    }

    if (!formData.phone.trim()) {
      nextErrors.phone = "Enter your phone number.";
    }

    if (!formData.bankName.trim()) {
      nextErrors.bankName = "Enter your bank name.";
    }

    if (!/^\d{10}$/.test(formData.accountNumber)) {
      nextErrors.accountNumber =
        "Enter an account number containing exactly 10 digits.";
    }

    if (!formData.accountName.trim()) {
      nextErrors.accountName = "Enter the account holder's name.";
    }

    if (
      formData.slug.trim() &&
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(formData.slug.trim())
    ) {
      nextErrors.slug =
        "Use lowercase letters, numbers, and single hyphens only.";
    }

    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setFormError("");

    if (!validateForm()) return;

    const profile = {
      businessName: formData.businessName.trim(),
      phone: formData.phone.trim(),
      payment: {
        bankName: formData.bankName.trim(),
        accountNumber: formData.accountNumber,
        accountName: formData.accountName.trim(),
      },
    };

    const slug = formData.slug.trim();
    if (slug && slug !== (seller?.slug ?? "")) {
      profile.slug = slug;
    }

    try {
      await saveProfile.mutateAsync(profile);
      navigate("/seller/dashboard", { replace: true });
    } catch (error) {
      if (error instanceof ApiError && error.code === "SLUG_TAKEN") {
        setErrors((current) => ({
          ...current,
          slug: "This public link is already in use. Choose another.",
        }));
        return;
      }

      if (error instanceof ApiError && error.code === "VALIDATION_ERROR") {
        setFormError(
          error.message || "Please check the information you entered."
        );
        return;
      }

      setFormError(
        error?.message || "We couldn't save your profile. Please try again."
      );
    }
  }

  return (
    <main className="min-h-[100dvh] bg-background">
      <div className="mx-auto flex min-h-[100dvh] w-full max-w-[420px] flex-col pb-28">
        <header className="flex items-center justify-between">
          <ChopListLogo />
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="text-sm font-medium text-primary hover:cursor-pointer"
          >
            Back
          </button>
        </header>

        <div className="mt-8">
          <h1 className="text-2xl font-bold text-foreground">
            Edit your profile
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Update your business, contact, and payment details.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="mt-7 space-y-5">
          <div className="space-y-4 rounded-xl border border-border bg-card p-4">
            <FormField
              label="Business name"
              name="businessName"
              value={formData.businessName}
              onChange={handleChange}
              error={errors.businessName}
              placeholder="mama T's kitchen"
              required
            />

            <FormField
              label="Phone number"
              name="phone"
              value={formData.phone}
              onChange={handleChange}
              error={errors.phone}
              placeholder="0803 123 4567"
              type="tel"
              required
            />
          </div>

          <div className="space-y-4 rounded-xl border border-border bg-card p-4">
            <div>
              <h2 className="font-semibold text-foreground">
                Update payment details
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                These details are used for your business payments.
              </p>
            </div>

            <FormField
              className="bg-background"
              label="Bank name"
              name="bankName"
              value={formData.bankName}
              onChange={handleChange}
              error={errors.bankName}
              placeholder="GTBank"
              required
            />

            <FormField
              label="Account number"
              name="accountNumber"
              value={formData.accountNumber}
              onChange={handleChange}
              error={errors.accountNumber}
              placeholder="0123456789"
              inputMode="numeric"
              maxLength={10}
              required
            />

            <FormField
              label="Account name"
              name="accountName"
              value={formData.accountName}
              onChange={handleChange}
              error={errors.accountName}
              placeholder="Name on your bank account"
              required
              className="bg-background"
            />
          </div>

          <div className="space-y-4 rounded-xl border border-border bg-card p-4">
            <div className="pt-5">
              <h2 className="font-semibold text-foreground">Shop menu link</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Changing this link may break links you've already shared. Leave
                it unchanged to keep your current link.
              </p>
            </div>

            <FormField
              label="Menu link"
              name="slug"
              value={formData.slug}
              onChange={handleChange}
              error={errors.slug}
              placeholder="mama-ts-kitchen"
            />
          </div>

          {formError && (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          )}

          <button
            type="submit"
            disabled={saveProfile.isPending}
            className="w-full rounded-xl bg-primary px-4 py-3 font-semibold text-primary-foreground transition-opacity disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saveProfile.isPending ? "Saving..." : "Save changes"}
          </button>

          <button
            type="button"
            onClick={() => navigate("/seller/dashboard")}
            className="w-full rounded-xl border border-border px-4 py-3 font-semibold text-destructive/70 hover:border-destructive"
          >
            Cancel
          </button>
        </form>
      </div>

      <SellerBottomNav />
    </main>
  );
}

function FormField({
  label,
  name,
  value,
  onChange,
  error,
  type = "text",
  placeholder,
  inputMode,
  maxLength,
  required = false,
}) {
  const inputId = `seller-profile-${name}`;

  return (
    <div className="space-y-2">
      <label htmlFor={inputId} className="text-sm font-medium text-foreground">
        {label}
        {required && <span className="text-destructive"> *</span>}
      </label>

      <input
        id={inputId}
        name={name}
        type={type}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        inputMode={inputMode}
        maxLength={maxLength}
        required={required}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${inputId}-error` : undefined}
        className="w-full rounded-xl border border-border bg-background px-3 py-3 text-sm text-foreground outline-none transition focus-visible:ring-2 focus-visible:ring-primary"
      />

      {error && (
        <p id={`${inputId}-error`} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
