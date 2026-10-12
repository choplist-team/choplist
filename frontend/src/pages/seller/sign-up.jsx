import { SignUp } from "@clerk/react";
import { ChopListLogo } from "@/components/choplist-logo";

export default function CreateAccount() {
  return (
    <main className="flex min-h-[100dvh] flex-col items-center bg-background px-4 py-8">
      <div className="mb-8">
        <ChopListLogo />
      </div>
      <SignUp
        signInUrl="/seller/sign-in"
        fallbackRedirectUrl="/seller/onboarding"
        appearance={{
          variables: {
            colorPrimary: "var(--primary)",
          },
        }}
      />
    </main>
  );
}
