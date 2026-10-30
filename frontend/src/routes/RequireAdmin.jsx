import { useEffect, useState } from "react";
import { useAuth } from "@clerk/react";
import { Navigate, Outlet } from "react-router-dom";
import { ChopListLogo } from "@/components/choplist-logo";
import { getAdminMe } from "@/api/admin-api";

function Screen({ children }) {
  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <div className="max-w-sm text-center">
        <ChopListLogo />
        {children}
      </div>
    </main>
  );
}

const buttonClass =
  "mt-5 inline-flex min-h-11 items-center justify-center rounded-xl bg-primary px-5 text-sm font-semibold text-primary-foreground";

// Guards /admin. Signed out goes to the admin sign-in. Signed in is checked
// with the API (GET /admin/me), which is the real decision: this page only
// decides what to show. A non-admin who opens /admin by hand sees a polite
// refusal and is never shown an admin page, and the API would refuse their data
// requests anyway.
export default function RequireAdmin() {
  const { isLoaded, isSignedIn, userId, getToken, signOut } = useAuth();
  // The check is remembered for the user it was made for, so signing out and
  // in as someone else never reuses the old answer.
  const [result, setResult] = useState({ userId: null, state: "checking" });

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    let cancelled = false;

    getAdminMe(getToken)
      .then(() => !cancelled && setResult({ userId, state: "admin" }))
      .catch((err) => {
        if (cancelled) return;
        setResult({
          userId,
          state: err.status === 403 ? "denied" : "error",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn, userId, getToken]);

  if (!isLoaded) {
    return (
      <Screen>
        <p className="mt-3 text-sm text-muted-foreground">
          Checking your session...
        </p>
      </Screen>
    );
  }

  if (!isSignedIn) {
    return <Navigate to="/admin/sign-in" replace />;
  }

  const state = result.userId === userId ? result.state : "checking";

  if (state === "checking") {
    return (
      <Screen>
        <p className="mt-3 text-sm text-muted-foreground">
          Checking admin access...
        </p>
      </Screen>
    );
  }

  if (state === "denied") {
    return (
      <Screen>
        <h1 className="mt-4 text-lg font-semibold">Admins only</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This account is not a ChopList administrator. Sign out and use an
          admin account.
        </p>
        <button
          type="button"
          className={buttonClass}
          onClick={() => signOut({ redirectUrl: "/admin/sign-in" })}
        >
          Sign out
        </button>
      </Screen>
    );
  }

  if (state === "error") {
    return (
      <Screen>
        <h1 className="mt-4 text-lg font-semibold">Could not check access</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          We could not reach the server. Check your connection and try again.
        </p>
        <button
          type="button"
          className={buttonClass}
          onClick={() => window.location.reload()}
        >
          Try again
        </button>
      </Screen>
    );
  }

  return <Outlet />;
}
