import { useAuth } from "@clerk/react";
import { ShieldAlert } from "lucide-react";
import { ChopListLogo } from "@/components/choplist-logo";
import { Button } from "@/components/ui/button";

// Shown instead of any seller page when the API answers ACCOUNT_SUSPENDED
// (the account is suspended or deactivated). Nothing is deleted: support can
// restore the account.
export default function SuspendedAccount() {
  const { signOut } = useAuth();

  return (
    <main className="flex min-h-[100dvh] flex-col items-center bg-background px-4 py-8 md:py-14">
      <ChopListLogo />

      <section
        role="alert"
        className="my-auto w-full max-w-[420px] rounded-2xl border border-border bg-card p-6 text-center md:max-w-md md:p-8"
      >
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-soft-green">
          <ShieldAlert className="h-7 w-7 text-primary" />
        </div>

        <h1 className="mt-5 text-xl font-bold text-foreground md:text-2xl">
          Your account is not active
        </h1>

        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          You can't manage your shop or receive new orders right now. Your menus
          and past orders are safe. Contact ChopList support to have your
          account restored.
        </p>

        <Button
          type="button"
          variant="outline"
          className="mt-6 w-full rounded-xl"
          onClick={() => signOut({ redirectUrl: "/" })}
        >
          Sign out
        </Button>
      </section>
    </main>
  );
}
