import { ChopListLogo } from "@/choplist-logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Link2 } from "lucide-react";
import { Link } from "react-router-dom";

export default function CreateAccount() {
  return (
    <main className="bg-background min-h-[100dvh]">
      <div className="mx-auto mt-8 min-h-[100dvh] w-full max-w-[420px] flex flex-col px-4 py-2">
        <header className="flex items-center justify-between">
          <ChopListLogo />
          <p className="text-muted-foreground text-sm font-semibold">
            SELLER ACCESS
          </p>
        </header>
        <div>
          <p className="mt-8 text-primary font-semibold text-xs">
            SELLER SETUP · 1 0F 1
          </p>
          <h1 className=" mt-3 leading-[1.05] tracking-tight font-semibold text-4xl text-foreground">
            Make room for <br />
            your next orders.
          </h1>
          <p className="mt-2 text-md text-muted-foreground">
            Create an account for your food business. Your <br />
            customers will still order as guest
          </p>
        </div>

        <form>
          <div className="mt-8">
            <Label htmlFor="email">Your email</Label>
            <Input
              id="email"
              type="email"
              placeholder="titilayoadebayo55@gmail.com"
              className="mt-2 h-12"
            />
          </div>

          <div className="mt-4">
            <Label htmlFor="phone">Phone number</Label>
            <Input
              id="phone"
              type="number"
              placeholder="+234 803 555 0120"
              className="mt-2 h-12"
            />
            <p className="text-xs mt-1 text-muted-foreground">
              Your WhatsApp line
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

          <div className="mt-4">
            <Label htmlFor="kitchen">Kitchen/business name</Label>
            <Input
              id="kitchen"
              type="text"
              placeholder="Mama T's kitchen"
              className="mt-2 h-12"
            />
            <p className="text-xs mt-1 text-muted-foreground">
              This is the name customers will see on your menu
            </p>
          </div>

          <div className="mt-4">
            <Label htmlFor="account">Account Number</Label>
            <Input
              id="account"
              type="number"
              placeholder="0123456789"
              className="mt-2 h-12"
            />
          </div>

          <div className="mt-4">
            <Label htmlFor="owner">Account Holder Name</Label>
            <Input
              id="owner"
              type="text"
              placeholder="Titilayo Adebayo"
              className="mt-2 h-12"
            />
          </div>

          <div className="mt-4">
            <Label htmlFor="bank">Bank Name</Label>
            <Input
              id="bank"
              type="text"
              placeholder="Bank name..."
              className="mt-2 h-12"
            />
          </div>

          <p className="mt-6 text-xs text-muted-foreground">
            By creating an account, you agree to Choplist's{" "}
            <Link to="#" className="text-primary font-semibold">
              Terms of use
            </Link>{" "}
            and{" "}
            <Link to="#" className="text-primary font-semibold">
              Privacy policy
            </Link>
          </p>
          <Button className="mt-4 w-full py-6 text-primary-foreground">
            Create seller account
          </Button>
        </form>
        <p className="mt-4 text-center text-muted-foreground text-sm">
          Already a seller?{" "}
          <Link to="/login" className="text-primary font-semibold">
            Sign in
          </Link>
        </p>

        <div className="mt-6 bg-soft-green border flex gap-4 rounded-lg py-2 px-2">
          <Link2 className="text-primary" />
          <div>
            <p className="mt-1 text-primary font-semibold text-sm">
              An account for you, not your customers.
            </p>
            <p className="text-sm text-primary/80">
              Share you weekly menu link. Customer orders
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
