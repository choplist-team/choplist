
import { ChopListLogo } from "@/components/choplist-logo";

export default function SellerHeader({ businessName }) {
  return (
    <header className="flex items-center justify-between gap-3">
      <ChopListLogo />

      <p className="max-w-[160px] truncate text-right text-xs font-semibold text-muted-foreground">
        {businessName}
      </p>
    </header>
  );
}
