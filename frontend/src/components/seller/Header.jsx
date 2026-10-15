import { ChopListLogo } from "@/components/choplist-logo";
import { Link } from "react-router-dom";

export default function SellerHeader({ businessName }) {
  return (
    <header className="flex items-center justify-between gap-3 lg:hidden">
      <Link to="/" aria-label="Go to ChopList home">
        <ChopListLogo />
      </Link>

      <p className="max-w-[160px] truncate text-right text-xs font-semibold text-muted-foreground">
        {businessName}
      </p>
    </header>
  );
}
