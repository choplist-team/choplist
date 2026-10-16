import { useState } from "react";
import { useAuth } from "@clerk/react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { ApiError } from "@/api/api-client";
import { ChopListLogo } from "@/components/choplist-logo";
import { useCurrentSeller } from "@/hooks/useCurrentSeller";
import { useSaveSellerProfile } from "@/hooks/useSaveSellerProfile";
import { FieldError } from "@/components/field-error";
import { hasErrors, validateProfile } from "@/lib/validation";

export default function SellerOnboarding() {
  const { isLoaded, isSignedIn } = useAuth();
  const navigate = useNavigate();

  const {
    data: seller,
    isPending: isLoadingSeller,
    error: profileError,
    refetch,
  } = useCurrentSeller();

  const saveProfile = useSaveSellerProfile();

  const [formData, setFormData] = useState({
    businessName: "",
    phone: "",
    bankName: "",
    accountNumber: "",
    accountName: "",
    slug: "",
  });

  const [validationError, setValidationError] = useState("");
  const [fieldErrors, setFieldErrors] = useState({});

  const needsOnboarding =
    profileError instanceof ApiError &&
    profileError.code === "PROFILE_REQUIRED";

  const handleChange = (event) => {
    const { name, value } = event.target;

    setFormData((previous) => ({
      ...previous,
      [name]: value,
    }));

    setFieldErrors((previous) => ({
      ...previous,
      [name]: "",
    }));

    setValidationError("");
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setValidationError("");

    const errors = validateProfile(formData);
    setFieldErrors(errors);

    if (hasErrors(errors)) {
      setValidationError("Please fix the highlighted fields below.");
      return;
    }

    const profile = {
      businessName: formData.businessName.trim(),
      phone: formData.phone.trim(),
      payment: {
        bankName: formData.bankName.trim(),
        accountNumber: formData.accountNumber,
        accountName: formData.accountName.trim(),
      },
      ...(formData.slug.trim()
        ? { slug: formData.slug.trim().toLowerCase() }
        : {}),
    };

    try {
      await saveProfile.mutateAsync(profile);
      navigate("/seller/dashboard", { replace: true });
    } catch (error) {
      if (error.code === "SLUG_TAKEN") {
        setFieldErrors((previous) => ({
          ...previous,
          slug: "This shop link is already taken by another seller. Choose a different one, or leave it blank to generate one.",
        }));
        setValidationError("Please fix the highlighted fields below.");
        return;
      }

      setValidationError(
        error.message || "Could not save your profile. Please try again."
      );
    }
  };

  if (!isLoaded) {
    return <LoadingScreen message="Checking your account..." />;
  }

  if (!isSignedIn) {
    return <Navigate to="/seller/sign-in" replace />;
  }

  if (isLoadingSeller) {
    return <LoadingScreen message="Loading your seller profile..." />;
  }

  {
    if (seller) {
      return <Navigate to="/seller/dashboard" replace />;
    }
  }

  if (profileError && !needsOnboarding) {
    return (
      <main className="min-h-[100dvh] bg-background px-4 py-10 md:py-14">
        <div className="mx-auto flex w-full max-w-[420px] flex-col gap-6 md:max-w-xl">
          <ChopListLogo />

          <div className="rounded-xl border border-border bg-card p-5">
            <h1 className="text-lg font-semibold text-foreground">
              Unable to load your profile
            </h1>

            <p className="mt-2 text-sm text-muted-foreground">
              {profileError.message ||
                "Something went wrong while loading your seller profile."}
            </p>

            <button
              type="button"
              onClick={() => refetch()}
              className="mt-5 w-full rounded-lg bg-primary px-4 py-3 font-semibold text-primary-foreground hover:opacity-90"
            >
              Try again
            </button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-[100dvh] bg-background px-4 py-8 md:px-8 md:py-14">
      <div className="mx-auto flex w-full max-w-[420px] flex-col md:max-w-xl">
        <div className="flex items-center justify-between gap-3">
          <ChopListLogo />

          <Link to="/seller/dashboard" className="text-sm font-semibold hover:underline">
          SKIP</Link>

        </div>

        <div className="mt-8">
          <p className="text-sm font-medium text-primary">
            Let&apos;s get started
          </p>
        </div>

        <div className="mt-2">
          <h1 className=" text-2xl font-bold text-foreground md:text-3xl">
            Set up your shop
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Your business and payment details are required before you can
            create menus and receive orders.
          </p>
        </div>

        <form onSubmit={handleSubmit} noValidate className="mt-8 space-y-5">
          <div className="space-y-4 rounded-xl border border-border bg-card p-4 md:grid md:grid-cols-2 md:gap-4 md:space-y-0 md:p-5">
            <div className="space-y-2">
              <label
                htmlFor="businessName"
                className="text-sm font-medium text-foreground"
              >
                Business name
              </label>

              <input
                id="businessName"
                name="businessName"
                type="text"
                autoComplete="organization"
                placeholder="Mama T's Kitchen"
                value={formData.businessName}
                onChange={handleChange}
                required
                aria-invalid={Boolean(fieldErrors.businessName)}
                aria-describedby={fieldErrors.businessName ? "businessName-error" : undefined}
                className="w-full rounded-lg border border-border bg-background px-3 py-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-primary"
              />

              <FieldError
                id="businessName-error"
                message={fieldErrors.businessName}
              />
            </div>

            <div className="space-y-2">
              <label
                htmlFor="phone"
                className="text-sm font-medium text-foreground"
              >
                Phone number
              </label>

              <input
                id="phone"
                name="phone"
                type="tel"
                autoComplete="tel"
                placeholder="08031234567"
                value={formData.phone}
                onChange={handleChange}
                required
                aria-invalid={Boolean(fieldErrors.phone)}
                aria-describedby={fieldErrors.phone ? "phone-error" : undefined}
                className="w-full rounded-lg border border-border bg-background px-3 py-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-primary"
              />

              <FieldError
                id="phone-error"
                message={fieldErrors.phone}
              />
            </div>
          </div>

          <div className="space-y-4 rounded-xl border border-border bg-card p-4 md:p-5">
            <div>
              <h2 className="font-semibold text-foreground">Payment details</h2>
            </div>

            <div className="space-y-2">
              <label
                htmlFor="bankName"
                className="text-sm font-medium text-foreground"
              >
                Bank name
              </label>

              <input
                id="bankName"
                name="bankName"
                type="text"
                autoComplete="off"
                placeholder="GTBank"
                value={formData.bankName}
                onChange={handleChange}
                required
                aria-invalid={Boolean(fieldErrors.bankName)}
                aria-describedby={fieldErrors.bankName ? "bankName-error" : undefined}
                className="w-full rounded-lg border border-border bg-background px-3 py-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-primary"
              />

              <FieldError
                id="bankName-error"
                message={fieldErrors.bankName}
              />
            </div>

            <div className="space-y-2">
              <label
                htmlFor="accountNumber"
                className="text-sm font-medium text-foreground"
              >
                Account number
              </label>

              <input
                id="accountNumber"
                name="accountNumber"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                maxLength={10}
                pattern="[0-9]{10}"
                placeholder="10-digit account number"
                value={formData.accountNumber}
                onChange={handleChange}
                required
                aria-invalid={Boolean(fieldErrors.accountNumber)}
                aria-describedby={fieldErrors.accountNumber ? "accountNumber-error" : undefined}
                className="w-full rounded-lg border border-border bg-background px-3 py-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-primary"
              />

              <FieldError
                id="accountNumber-error"
                message={fieldErrors.accountNumber}
              />
            </div>

            <div className="space-y-2">
              <label
                htmlFor="accountName"
                className="text-sm font-medium text-foreground"
              >
                Account name
              </label>

              <input
                id="accountName"
                name="accountName"
                type="text"
                autoComplete="off"
                placeholder="Name registered with your bank"
                value={formData.accountName}
                onChange={handleChange}
                required
                aria-invalid={Boolean(fieldErrors.accountName)}
                aria-describedby={fieldErrors.accountName ? "accountName-error" : undefined}
                className="w-full rounded-lg border border-border bg-background px-3 py-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-primary"
              />

              <FieldError
                id="accountName-error"
                message={fieldErrors.accountName}
              />
            </div>
          </div>

          <div className="space-y-2">
            <label
              htmlFor="slug"
              className="text-sm font-medium text-foreground"
            >
              Shop Link{" "}
              <span className="font-normal text-muted-foreground">
                (optional)
              </span>
            </label>

            <input
              id="slug"
              name="slug"
              type="text"
              autoComplete="off"
              placeholder="e.g. mama-ts-kitchen"
              value={formData.slug}
              onChange={handleChange}
              aria-invalid={Boolean(fieldErrors.slug)}
              aria-describedby={fieldErrors.slug ? "slug-error" : undefined}
              className="w-full rounded-lg border border-border bg-card px-3 py-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-primary"
            />

            <p className="text-xs text-muted-foreground">
              Leave this blank and we'll create one from your business name.
            </p>

            <FieldError
              id="slug-error"
              message={fieldErrors.slug}
            />
          </div>

          {validationError && (
            <p
              role="alert"
              className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
            >
              {validationError}
            </p>
          )}

          {saveProfile.isError && !validationError && (
            <p role="alert" className="text-sm text-destructive">
              {saveProfile.error.message ||
                "Could not save your profile. Please try again."}
            </p>
          )}

          <button
            type="submit"
            disabled={saveProfile.isPending}
            className="w-full rounded-lg bg-primary px-4 py-3 font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saveProfile.isPending
              ? "Saving your details..."
              : "Save and continue"}
          </button>
        </form>
      </div>
    </main>
  );
}

function LoadingScreen({ message }) {
  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <div className="flex flex-col items-center gap-4">
        <ChopListLogo />
        <p className="text-sm text-muted-foreground">{message}</p>
      </div>
    </main>
  );
}
