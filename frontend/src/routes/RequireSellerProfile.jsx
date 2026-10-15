import { Link, Outlet } from "react-router-dom";
import { ArrowRight, Store } from "lucide-react";
import { ApiError } from "@/api/api-client";
import { ChopListLogo } from "@/components/choplist-logo";
import { useCurrentSeller } from "@/hooks/useCurrentSeller";

export default function RequireSellerProfile() {
  const { isPending, error } = useCurrentSeller();

  if (isPending) {
    return (
      <main className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
        <div className="text-center">
          <ChopListLogo />
          <p className="mt-3 text-sm text-muted-foreground">
            Loading your shop...
          </p>
        </div>
      </main>
    );
  }

  if (error instanceof ApiError && error.code === "PROFILE_REQUIRED") {
    return (
      <main className="flex min-h-[100dvh] flex-col items-center bg-background px-4 py-8 md:py-14">
        <ChopListLogo />

        <section className="my-auto w-full max-w-[420px] rounded-2xl border border-border bg-card p-6 text-center md:max-w-md md:p-8">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-soft-green">
            <Store className="h-7 w-7 text-primary" />
          </div>

          <h1 className="mt-5 text-xl font-bold text-foreground md:text-2xl">
            Finish setting up your shop
          </h1>

          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Add your business and payment details to start creating menus and
            receiving orders.
          </p>

          <Link
            to="/seller/onboarding"
            className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 font-semibold text-primary-foreground transition-opacity hover:opacity-90"
          >
            Complete shop setup
            <ArrowRight className="h-4 w-4" />
          </Link>
        </section>
      </main>
    );
  }

  return <Outlet />;
}
