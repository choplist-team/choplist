import { ChopListLogo } from "@/components/choplist-logo";
import { Button } from "@/components/ui/button";
import { ArrowRight, Search } from "lucide-react";
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
        <Link to="/seller/sign-up">
          <Button className="mt-8 w-full py-6 text-primary-foreground">
            Get started <ArrowRight />
          </Button>
        </Link>

        <p className="text-muted-foreground text-sm mt-4 text-center">
          Already a seller?{" "}
          <Link to="/seller/sign-in" className="text-primary font-semibold">
            Sign in
          </Link>
        </p>
        <div className="mt-5 rounded-lg border border-border bg-soft-green px-4 py-3 text-center">
          <Link
            to="/order-lookup"
            className="inline-flex items-center justify-center gap-2 text-sm font-semibold text-primary hover:underline"
          >
            <Search size={16} />
            Find my order
          </Link>

          <p className="mt-2 text-sm leading-relaxed text-primary/70">
            Already placed an order?
          </p>
        </div>
      </div>
    </main>
  );
}
