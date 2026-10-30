import { ChopListLogo } from "@/components/choplist-logo";
import SuspendedAccount from "@/components/seller/SuspendedAccount";
import { useCurrentSeller } from "@/hooks/useCurrentSeller";
import { useAuth } from "@clerk/react";
import { Navigate, Outlet } from "react-router-dom";

function Checking() {
  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <div className="text-center">
        <ChopListLogo />
        <p className="text-sm mt-3 text-muted-foreground">
          Checking your session...
        </p>
      </div>
    </main>
  );
}

export default function ProtectedRoute() {
  const { isLoaded, isSignedIn } = useAuth();
  // Every seller page is behind this, so this is the one place that turns a
  // suspended account into the "not active" screen. The query only runs once
  // the user is signed in, and is shared with the pages that read the seller.
  const seller = useCurrentSeller();

  if (!isLoaded) {
    return <Checking />;
  }

  if (!isSignedIn) {
    return <Navigate to="/seller/sign-in" replace />;
  }

  if (seller.error?.code === "ACCOUNT_SUSPENDED") {
    return <SuspendedAccount />;
  }

  if (seller.isPending) {
    return <Checking />;
  }

  return <Outlet />;
}
