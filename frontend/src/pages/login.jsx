import { ChopListLogo } from "@/choplist-logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Link2, Store } from "lucide-react";
import { Link } from "react-router-dom";

export default function Login() {
  return (
    <main className="bg-background min-h-[100dvh]">
      <div className="mx-auto mt-8 min-h-[100dvh] w-full max-w-[420px] flex flex-col px-4 py-2">
        <header className="flex items-center justify-between">
          <ChopListLogo />
          <p className="text-muted-foreground text-sm font-semibold">
            SELLER ACCESS
          </p>
        </header>

        <div className="mt-10 flex size-[68px] items-center justify-center rounded-[20px] bg-soft-green">
          <Store size={30} strokeWidth={1.8} className="text-primary" />
        </div>
        <div>
          <p className="mt-8 text-primary text-xs font-semibold">
            WELCOME BACK
          </p>
          <h1 className="mt-3 text-4xl font-semibold text-foreground">
            Back to your kitchen.
          </h1>
          <p className="mt-2 text-md text-muted-foreground">
            Sign in to your seller workspace to manage your
            <br />
            menus, orders and deliveries.
          </p>
        </div>

        <div>
          <div className="mt-4">
            <Label htmlFor="email">email</Label>
            <Input
              id="email"
              type="email"
              placeholder="titlayoadebayo55@gmail.com"
              className="mt-2 h-12"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Use the email registered to your seller account
            </p>
          </div>

          <div className="mt-4">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              placeholder="***********"
              className="mt-2 h-12"
            />
          </div>

          <Button className="mt-4 text-primary-foreground w-full py-6">
            Sign in
          </Button>
        </div>

        <p className="mb-6 mt-4 text-xs text-center text-muted-foreground">
          {" "}
          New to Choplist ?{" "}
          <Link to="/create-account" className="text-primary font-semibold">
            Create seller account
          </Link>
        </p>
        <div className="mb-8 flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Can't access your number?
          </p>

          <Link to="#" className="text-sm text-primary font-semibold">
            {" "}
            Get help ➡
          </Link>
        </div>

        <div className="mt-8 flex gap-4 border rounded-lg bg-soft-green px-2 py-2">
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
