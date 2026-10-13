
import { NavLink } from "react-router-dom";
import {
  ChefHat,
  ClipboardList,
  CookingPot,
  Truck,
} from "lucide-react";

const navigationItems = [
  {
    label: "Menu",
    path: "/seller/dashboard",
    icon: ChefHat,
  },
  {
    label: "Orders",
    path: "/seller/orders",
    icon: ClipboardList,
  },
  {
    label: "Prep",
    path: "/seller/prep",
    icon: CookingPot,
  },
  {
    label: "Delivery",
    path: "/seller/delivery",
    icon: Truck,
  },
];

export default function SellerBottomNav() {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-card">
      <div className="mx-auto grid w-full max-w-[420px] grid-cols-4 px-2 py-2">
        {navigationItems.map(({ label, path, icon: Icon }) => (
          <NavLink
            key={path}
            to={path}
            end={path === "/seller/dashboard"}
            className={({ isActive }) =>
              `flex flex-col items-center gap-1 rounded-lg py-2 text-xs font-medium transition-colors ${
                isActive
                  ? "text-primary"
                  : "text-muted-foreground hover:text-foreground"
              }`
            }
          >
            {({ isActive }) => (
              <>
                <Icon
                  className={`h-5 w-5 ${
                    isActive ? "stroke-[2.5]" : ""
                  }`}
                />
                <span>{label}</span>
              </>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
