import { ChopListLogo } from "@/components/choplist-logo";
import { useAuth } from "@clerk/react";
import { Navigate, Outlet } from "react-router-dom";

export default function ProtectedRoute() {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded) {
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

  if (!isSignedIn) {
    return <Navigate to="/seller/sign-in" replace />;
  }

  return <Outlet />;
}
