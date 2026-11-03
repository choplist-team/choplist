import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useCurrentSeller } from "@/hooks/useCurrentSeller";
import { useSellersBanks } from "@/hooks/useSellersBanks";
import { useSaveSellerProfile } from "@/hooks/useSaveSellerProfile";

export default function BankDetails({ variant = "full" }) {
  const [selectedBankCode, setSelectedBankCode] = useState(null);
  const [accountNumber, setAccountNumber] = useState(null);
  const [accountName, setAccountName] = useState(null);

  const [isEditing, setIsEditing] = useState(false);
  const [bankSaveError, setBankSaveError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");

  const queryClient = useQueryClient();

  const { data: seller, refetch: refetchSeller } = useCurrentSeller();

  const {
    data: banksData,
    isPending: isBanksPending,
    isError: isBanksError,
    error: banksError,
    refetch: refetchBanks,
  } = useSellersBanks();

  const saveProfile = useSaveSellerProfile();

  const payment = seller?.payment ?? {};

  const currentBankCode = payment.bankCode ?? "";
  const currentBankName = payment.bankName ?? "";
  const currentAccountNumber = payment.accountNumber ?? "";
  const currentAccountName = payment.accountName ?? "";

  const selectedBankValue = selectedBankCode ?? currentBankCode;

  const accountNumberValue = accountNumber ?? currentAccountNumber;

  const accountNameValue = accountName ?? currentAccountName;

  const isCompact = variant === "compact";
  const isFull = variant === "full";

  const hasSavedBankDetails = Boolean(
    currentBankName || currentAccountNumber || currentAccountName
  );

  const banksUnavailable =
    isBanksError &&
    (banksError?.status === 503 || banksError?.code === "PAYMENTS_UNAVAILABLE");

  const showForm = isCompact || !hasSavedBankDetails || isEditing;

  function startEditing() {
    setSelectedBankCode(currentBankCode);
    setAccountNumber(currentAccountNumber);
    setAccountName(currentAccountName);
    setBankSaveError("");
    setSuccessMessage("");
    setIsEditing(true);
  }

  function cancelEditing() {
    setSelectedBankCode(null);
    setAccountNumber(null);
    setAccountName(null);
    setBankSaveError("");
    setIsEditing(false);
  }

  async function handleSaveBank(event) {
    event.preventDefault();

    setBankSaveError("");
    setSuccessMessage("");

    const selectedBank = banksData?.banks?.find(
      (bank) => bank.code === selectedBankValue
    );

    if (!selectedBank) {
      setBankSaveError("Please select a bank from the list.");
      return;
    }

    if (!/^\d{10}$/.test(accountNumberValue)) {
      setBankSaveError("Account number must contain exactly 10 digits.");
      return;
    }

    if (!accountNameValue.trim()) {
      setBankSaveError("Please enter the account name.");
      return;
    }

    if (!seller?.businessName || !seller?.phone) {
      setBankSaveError(
        "Your business profile is incomplete. Please update your profile first."
      );
      return;
    }

    const profile = {
      businessName: seller.businessName,
      phone: seller.phone,
      payment: {
        bankName: selectedBank.name,
        accountNumber: accountNumberValue,
        accountName: accountNameValue.trim(),
        bankCode: selectedBank.code,
      },
    };

    // Leave optional fields out when they are not present.
    // This preserves the existing slug and email on the backend.
    if (seller.slug) {
      profile.slug = seller.slug;
    }

    if (seller.email) {
      profile.email = seller.email;
    }

    try {
      await saveProfile.mutateAsync(profile);

      // Refresh payment status too, because changing bank details
      // can temporarily switch online payments off.
      await queryClient.invalidateQueries({
        queryKey: ["seller-payments"],
      });

      await refetchSeller();

      setSelectedBankCode(null);
      setAccountNumber(null);
      setAccountName(null);
      setIsEditing(false);

      setSuccessMessage("Your bank details have been saved successfully.");
    } catch (error) {
      setBankSaveError(
        error.message || "Could not save your bank details. Please try again."
      );
    }
  }

  return (
    <section
      className={`rounded-xl border border-border bg-card p-4 ${
        isCompact ? "mt-6 md:p-5" : "mt-6 md:p-5"
      }`}
    >
      {/* Section heading */}
      <div>
        <h2 className="font-semibold text-foreground">
          {isCompact ? "Add your bank details" : "Bank account details"}
        </h2>

        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {isCompact
            ? "Choose your bank and enter your account details so you can receive payments."
            : "Manage the bank account you use to receive payments from your customers."}
        </p>
      </div>

      {/* Saved bank details summary - Payment Settings only */}
      {isFull && hasSavedBankDetails && !isEditing && (
        <div className="mt-4 space-y-4 ">
          <div className="rounded-lg bg-soft-green p-3">
            <div className="space-y-3">
              <div>
                <p className="text-xs font-medium text-muted-foreground">
                  Bank name
                </p>
                <p className="mt-1 text-sm font-semibold text-foreground">
                  {currentBankName || "Not provided"}
                </p>
              </div>

              <div>
                <p className="text-xs font-medium text-muted-foreground">
                  Account number
                </p>
                <p className="mt-1 text-sm font-semibold text-foreground">
                  {currentAccountNumber || "Not provided"}
                </p>
              </div>

              <div>
                <p className="text-xs font-medium text-muted-foreground">
                  Account name
                </p>
                <p className="mt-1 text-sm font-semibold text-foreground">
                  {currentAccountName || "Not provided"}
                </p>
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={startEditing}
            className="w-full rounded-lg border border-border px-4 py-3 text-sm font-semibold text-foreground transition hover:bg-muted"
          >
            Change bank details
          </button>
        </div>
      )}

      {/* Bank form */}
      {showForm && (
        <>
          {isBanksPending ? (
            <p className="mt-4 text-sm text-muted-foreground">
              Loading banks...
            </p>
          ) : banksUnavailable ? (
            <div className="mt-4 rounded-lg border border-border bg-background p-3">
              <p className="text-sm text-muted-foreground">
                The bank list is temporarily unavailable. You can continue using
                bank transfers and add or change your bank details later.
              </p>

              <button
                type="button"
                onClick={() => refetchBanks()}
                className="mt-3 rounded-lg border border-border bg-soft-green px-4 py-2 text-sm font-semibold text-foreground hover:bg-muted"
              >
                Try again
              </button>
            </div>
          ) : isBanksError ? (
            <div className="mt-4">
              <p className="text-sm text-destructive">
                {banksError?.message || "Unable to load banks."}
              </p>

              <button
                type="button"
                onClick={() => refetchBanks()}
                className="mt-3 rounded-lg border border-border px-4 py-2 text-sm font-semibold text-foreground hover:bg-muted"
              >
                Try again
              </button>
            </div>
          ) : (
            <form onSubmit={handleSaveBank} className="mt-4 space-y-4">
              {/* Bank dropdown */}
              <div className="space-y-2">
                <label
                  htmlFor={`seller-bank-${variant}`}
                  className="text-sm font-medium text-foreground"
                >
                  Bank name
                </label>

                <select
                  id={`seller-bank-${variant}`}
                  value={selectedBankValue}
                  onChange={(event) => {
                    setSelectedBankCode(event.target.value);
                    setBankSaveError("");
                    setSuccessMessage("");
                  }}
                  required
                  className="w-full rounded-lg border border-border bg-background px-3 py-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <option value="">Choose your bank</option>

                  {(banksData?.banks ?? []).map((bank) => (
                    <option key={bank.code} value={bank.code}>
                      {bank.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Account number */}
              <div className="space-y-2">
                <label
                  htmlFor={`seller-account-number-${variant}`}
                  className="text-sm font-medium text-foreground"
                >
                  Account number
                </label>

                <input
                  id={`seller-account-number-${variant}`}
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={10}
                  value={accountNumberValue}
                  onChange={(event) => {
                    setAccountNumber(
                      event.target.value.replace(/\D/g, "").slice(0, 10)
                    );
                    setBankSaveError("");
                    setSuccessMessage("");
                  }}
                  placeholder="Enter your 10-digit account number"
                  required
                  className="w-full rounded-lg border border-border bg-background px-3 py-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
                />
              </div>

              {/* Account name */}
              <div className="space-y-2">
                <label
                  htmlFor={`seller-account-name-${variant}`}
                  className="text-sm font-medium text-foreground"
                >
                  Account name
                </label>

                <input
                  id={`seller-account-name-${variant}`}
                  type="text"
                  autoComplete="name"
                  value={accountNameValue}
                  onChange={(event) => {
                    setAccountName(event.target.value);
                    setBankSaveError("");
                    setSuccessMessage("");
                  }}
                  placeholder="Enter the name on your bank account"
                  required
                  className="w-full rounded-lg border border-border bg-background px-3 py-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
                />
              </div>

              {/* Error message */}
              {bankSaveError && (
                <p role="alert" className="text-sm text-destructive">
                  {bankSaveError}
                </p>
              )}

              {/* Actions */}
              <div className="space-y-3 md:flex md:items-center md:gap-3 md:space-y-0">
                <button
                  type="submit"
                  disabled={
                    !selectedBankValue ||
                    !accountNumberValue ||
                    !accountNameValue.trim() ||
                    saveProfile.isPending
                  }
                  className="w-full rounded-lg bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 md:w-auto"
                >
                  {saveProfile.isPending
                    ? "Saving bank details..."
                    : hasSavedBankDetails
                    ? "Save changes"
                    : "Save bank details"}
                </button>

                {isFull && hasSavedBankDetails && (
                  <button
                    type="button"
                    onClick={cancelEditing}
                    disabled={saveProfile.isPending}
                    className="w-full rounded-lg border border-border px-4 py-3 text-sm font-semibold text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 md:w-auto"
                  >
                    Cancel
                  </button>
                )}
              </div>
            </form>
          )}
        </>
      )}

      {/* Success message */}
      {successMessage && (
        <p role="status" className="mt-3 text-sm font-medium text-primary">
          {successMessage}
        </p>
      )}
    </section>
  );
}
