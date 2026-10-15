import { ChopListLogo } from "@/components/choplist-logo";
import { Button } from "@/components/ui/button";
import { ArrowRight, Search } from "lucide-react";
import { Link } from "react-router-dom";

export default function Home() {
  return (
    <main className="min-h-[100dvh] bg-background">
      <div className="mx-auto flex min-h-[100dvh] w-full max-w-[420px] flex-col px-4 py-2 md:max-w-xl md:px-8 lg:max-w-6xl lg:py-8">
        <header className="mt-8 flex justify-center lg:mt-0 lg:justify-start">
          <ChopListLogo />
        </header>
        <div className="flex flex-col lg:my-auto lg:grid lg:grid-cols-2 lg:items-center lg:gap-16 lg:py-12">
          <div className="flex flex-col">
            <p className="mt-8 text-center text-sm font-semibold text-muted-foreground lg:mt-0 lg:text-left">
              YOUR DIGITAL MENU BUDDY. YOUR PREP ASSISTANT
            </p>
            <img
              src="/choplist-splash.png"
              alt="Jollof rice"
              className="mt-8 w-full rounded-md text-muted-foreground lg:hidden"
            />
            <p className="mt-4 text-muted-foreground md:text-lg lg:mt-5 lg:text-4xl lg:font-semibold lg:leading-tight lg:tracking-tight lg:text-foreground">
              Your weekly menu, orders, payments and delivery all in one seller
              workspace.
            </p>
            <Link to="/seller/sign-up" className="lg:self-start">
              <Button className="mt-8 w-full py-6 text-primary-foreground lg:mt-10 lg:w-auto lg:px-10">
                Get started <ArrowRight />
              </Button>
            </Link>

            <p className="text-muted-foreground text-sm mt-4 text-center lg:text-left">
              Already a seller?{" "}
              <Link to="/seller/sign-in" className="text-primary font-semibold">
                Sign in
              </Link>
            </p>
            <div className="mt-5 rounded-lg border border-border bg-soft-green px-4 py-3 text-center lg:mt-10 lg:max-w-sm lg:px-5 lg:py-4 lg:text-left">
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
          <img
            src="/choplist-splash.png"
            alt="Jollof rice"
            className="hidden w-full rounded-2xl lg:block"
          />
        </div>
      </div>
    </main>
  );
}
