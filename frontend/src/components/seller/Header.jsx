import { ChopListLogo } from "@/components/choplist-logo";
import { Link } from "react-router-dom";
import NotificationsBell from "@/components/seller/NotificationsBell";

export default function SellerHeader({ businessName }) {
  return (
    <header className="flex items-center justify-between gap-3 lg:hidden">
      <Link to="/" aria-label="Go to ChopList home">
        <ChopListLogo />
      </Link>

      <div className="flex items-center gap-3">
        <p className="max-w-[140px] truncate text-right text-xs font-semibold text-muted-foreground">
          {businessName}
        </p>
        <NotificationsBell />
      </div>
    </header>
  );
}
