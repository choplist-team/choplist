import BankDetails from "@/components/seller/BankDetails";
import SellerBottomNav from "@/components/seller/BottomNav";
import SellerHeader from "@/components/seller/Header";
import { useCurrentSeller } from "@/hooks/useCurrentSeller";
import {
  useSellerPayments,
  useRetrySellerPaymentsSetup,
  useUpdateSellerFeeMode,
} from "@/hooks/useSellerPayments";

export default function PaymentSettings() {
  const {
    data: paymentStatus,
    isPending: isPaymentsPending,
    isError: isPaymentsError,
    error: paymentsError,
    refetch: refetchPayments,
  } = useSellerPayments();

  const { data: seller } = useCurrentSeller();

  const retryPayments = useRetrySellerPaymentsSetup();
  const updateFeeMode = useUpdateSellerFeeMode();

  return (
    <main className="min-h-[100dvh] bg-background px-4 py-6 pb-28 md:px-8 md:pt-10 lg:pb-12 lg:pl-72 lg:pr-8">
      <div className="mx-auto flex w-full max-w-[420px] flex-col md:max-w-3xl lg:max-w-5xl">
        <SellerHeader businessName={seller?.businessName} />
        <header className="mt-8 lg:mt-0">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground md:text-4xl">
            Payment settings
          </h1>
          <p className="mt-2 text-sm leading-5 text-muted-foreground">
            Manage your online payment setup and choose who pays the ChopList
            service fee.
          </p>
        </header>

        <BankDetails variant="full" />

        <section className="mt-6">
          <div className="space-y-4 rounded-xl border border-border bg-card p-4">
            {isPaymentsPending ? (
              <p className="text-sm text-muted-foreground">
                Loading payment settings...
              </p>
            ) : isPaymentsError ? (
              <div>
                <p className="text-sm text-destructive">
                  {paymentsError?.message || "Unable to load payment settings."}
                </p>

                <button
                  type="button"
                  onClick={() => refetchPayments()}
                  className="mt-3 rounded-lg border border-border px-3 py-2 text-sm font-semibold"
                >
                  Try again
                </button>
              </div>
            ) : (
              <>
                <div>
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="font-semibold text-foreground">
                      Online payments
                    </h2>

                    <span
                      className={`rounded-full px-3 py-1 text-xs font-semibold ${
                        paymentStatus?.paymentsReady
                          ? "bg-soft-green text-primary"
                          : "bg-warning text-foreground"
                      }`}
                    >
                      {paymentStatus?.paymentsReady ? "Ready" : "Setup needed"}
                    </span>
                  </div>

                  {!paymentStatus?.paymentsReady && (
                    <div className="mt-2">
                      <p className="text-sm text-muted-foreground">
                        {paymentStatus?.paymentsIssue ||
                          "Your payment setup needs attention."}
                      </p>

                      <button
                        type="button"
                        disabled={retryPayments.isPending}
                        onClick={() => retryPayments.mutate()}
                        className="mt-3 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
                      >
                        {retryPayments.isPending
                          ? "Retrying..."
                          : "Retry payment setup"}
                      </button>

                      {retryPayments.isError && (
                        <p className="mt-2 text-sm text-destructive">
                          {retryPayments.error?.message ||
                            "Could not retry payment setup."}
                        </p>
                      )}
                    </div>
                  )}
                </div>

                <div className="border-t border-border pt-4">
                  <h2 className="font-semibold text-foreground">Service fee</h2>

                  <p className="mt-1 text-sm leading-5 text-muted-foreground">
                    Choose who pays the ChopList service fee on online orders.
                  </p>

                  <div className="mt-3 space-y-3">
                    <label className="flex cursor-pointer items-start gap-3">
                      <input
                        type="radio"
                        name="feeMode"
                        value="customer"
                        checked={paymentStatus?.feeMode === "customer"}
                        disabled={updateFeeMode.isPending}
                        onChange={() => updateFeeMode.mutate("customer")}
                        className="mt-1 accent-primary"
                      />

                      <span>
                        <span className="block text-sm font-medium text-foreground">
                          Customer pays
                        </span>
                        <span className="block text-xs leading-5 text-muted-foreground">
                          The service fee is added to the customer's total.
                        </span>
                      </span>
                    </label>

                    <label className="flex cursor-pointer items-start gap-3">
                      <input
                        type="radio"
                        name="feeMode"
                        value="seller"
                        checked={paymentStatus?.feeMode === "seller"}
                        disabled={updateFeeMode.isPending}
                        onChange={() => updateFeeMode.mutate("seller")}
                        className="mt-1 accent-primary"
                      />

                      <span>
                        <span className="block text-sm font-medium text-foreground">
                          I pay
                        </span>
                        <span className="block text-xs leading-5 text-muted-foreground">
                          The service fee comes from your proceeds.
                        </span>
                      </span>
                    </label>
                  </div>

                  {updateFeeMode.isPending && (
                    <p className="mt-3 text-sm text-muted-foreground">
                      Saving your preference...
                    </p>
                  )}

                  {updateFeeMode.isError && (
                    <p className="mt-3 text-sm text-destructive">
                      {updateFeeMode.error?.message ||
                        "Could not update your service fee preference."}
                    </p>
                  )}
                </div>
              </>
            )}
          </div>
        </section>
        <SellerBottomNav />
      </div>
    </main>
  );
}
