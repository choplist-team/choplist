import { ChopListLogo } from "@/choplist-logo";
import { Button } from "@/components/ui/button";
import { ArrowRight, Link2 } from "lucide-react";
import { Link } from "react-router-dom";

export default function Home() {
  return (
    <main className="min-h-[100dvh] bg-background">
      <div className="mx-auto flex min-h-[100dvh] w-full max-w-[420px] flex-col px-4 py-2">
        <header className="mt-8 flex justify-center">
          <ChopListLogo />
        </header>
        <p className="mt-8 text-center text-sm font-semibold text-muted-foreground">
          YOUR DIGITAL MENU BUDDY. YOUR PREP ASSISTANT
        </p>
        <img
          src="/choplist-splash.png"
          alt="Jollof rice"
          className="mt-8 w-full rounded-md text-muted-foreground"
        />
        <p className="mt-4 text-muted-foreground">
          Your weekly menu, orders, payments and delivery all in one seller
          workspace.
        </p>
        <Link to="/create-account">
          <Button className="mt-8 w-full py-6 text-primary-foreground">
            Get started <ArrowRight />
          </Button>
        </Link>

        <p className="text-muted-foreground text-sm mt-4 text-center">
          Already a seller?{""}
          <Link to="/login" className="text-primary font-semibold">
            Sign in
          </Link>
        </p>

        <div className="mt-5 flex gap-4 border rounded-lg bg-soft-green px-2 py-2">
          <Link2 className="mt-1 shrink-0 text-primary" />

          <div>
            <p className="font-semibold text-primary mt-1 text-sm">
              Ordering food?
            </p>

            <p className="mt-1 leading-[1] text-sm text-primary/60">
              Open the menu link your seller shared. No app download or sign-up
              needed.
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
