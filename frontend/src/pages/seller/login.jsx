import { SignIn } from "@clerk/react";
import { ChopListLogo } from "@/components/choplist-logo";

export default function Login() {
  return (
    <main className="flex min-h-[100dvh] flex-col items-center bg-background px-4 py-8">
      <div className="mb-8">
        <ChopListLogo />
      </div>

      <SignIn
        signUpUrl="/seller/sign-up"
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
