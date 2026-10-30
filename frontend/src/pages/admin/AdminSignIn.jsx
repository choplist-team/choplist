import { SignIn } from "@clerk/react";
import { ChopListLogo } from "@/components/choplist-logo";

// The sign-in page for ChopList staff. It is the same Clerk sign-in as the
// seller one, but it lands on /admin and offers no sign-up. Whether an account
// is an admin is decided by the API, not by this page (see RequireAdmin).
export default function AdminSignIn() {
  return (
    <main className="flex min-h-[100dvh] flex-col items-center bg-background px-4 py-8">
      <div className="mb-2">
        <ChopListLogo />
      </div>
      <p className="mb-6 text-sm font-medium text-muted-foreground">
        Admin sign in
      </p>

      <SignIn
        path="/admin/sign-in"
        routing="path"
        forceRedirectUrl="/admin"
        appearance={{
          variables: {
            colorPrimary: "var(--primary)",
          },
          elements: {
            footerAction: "hidden",
          },
        }}
      />
    </main>
  );
}
