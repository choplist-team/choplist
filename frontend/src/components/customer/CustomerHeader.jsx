
import { Utensils } from "lucide-react";

export default function CustomerHeader() {
  return (
    <header className="flex w-full items-center justify-between gap-3 py-4">
      <div className="flex shrink-0 items-center gap-2 text-primary">
        <Utensils size={26} strokeWidth={2.5} />

        <span className="text-2xl font-bold tracking-tight">
          choplist
        </span>
      </div>

      <p className="text-right text-xs font-semibold text-muted-foreground sm:text-sm">
        NO APP. NO SIGN-UP.
      </p>
    </header>
  );
}
