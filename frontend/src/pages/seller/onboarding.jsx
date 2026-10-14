import { useState } from "react";
import { useAuth } from "@clerk/react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { ApiError } from "@/api/api-client";
import { ChopListLogo } from "@/components/choplist-logo";
import { useCurrentSeller } from "@/hooks/useCurrentSeller";
import { useSaveSellerProfile } from "@/hooks/useSaveSellerProfile";

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

  const needsOnboarding =
    profileError instanceof ApiError &&
    profileError.code === "PROFILE_REQUIRED";

  const handleChange = (event) => {
    const { name, value } = event.target;

    setFormData((previous) => ({
      ...previous,
      [name]: value,
    }));

    setValidationError("");
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setValidationError("");

    if (!/^\d{10}$/.test(formData.accountNumber)) {
      setValidationError("Enter a valid 10-digit bank account number.");
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
      ...(formData.slug.trim() ? { slug: formData.slug.trim() } : {}),
    };

    try {
      await saveProfile.mutateAsync(profile);
      navigate("/seller/dashboard", { replace: true });
    } catch (error) {
      if (error.code === "SLUG_TAKEN") {
        setValidationError(
          "This shop URL is already taken. Choose another one."
        );
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
      <main className="min-h-[100dvh] bg-background px-4 py-10">
        <div className="mx-auto flex w-full max-w-[420px] flex-col gap-6">
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
    <main className="min-h-[100dvh] bg-background px-4 py-8">
      <div className="mx-auto flex w-full max-w-[420px] flex-col">
        <div className="flex items-center justify-between gap-3">
          <ChopListLogo />

          <span className="text-xs font-semibold tracking-wide text-muted-foreground">
            SELLER SETUP
          </span>
        </div>

        <div className="mt-8">
          <p className="text-sm font-medium text-primary">
            Let&apos;s get started
          </p>
        </div>

        <div className="mt-2 flex items-center justify-between">
          <h1 className=" text-2xl font-bold text-foreground">
            Set up your shop
          </h1>
          <Link
            to="/seller/dashboard"
            className="text-sm text-foreground font-semibold hover:underline"
          >
            SKIP
          </Link>
        </div>

        <form onSubmit={handleSubmit} className="mt-8 space-y-5">
          <div className="space-y-4 rounded-xl border border-border bg-card p-4">
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
                className="w-full rounded-lg border border-border bg-background px-3 py-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-primary"
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
                className="w-full rounded-lg border border-border bg-background px-3 py-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-primary"
              />
            </div>
          </div>

          <div className="space-y-4 rounded-xl border border-border bg-card p-4">
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
                className="w-full rounded-lg border border-border bg-background px-3 py-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-primary"
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
                className="w-full rounded-lg border border-border bg-background px-3 py-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-primary"
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
                className="w-full rounded-lg border border-border bg-background px-3 py-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-primary"
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
              className="w-full rounded-lg border border-border bg-card px-3 py-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-primary"
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
