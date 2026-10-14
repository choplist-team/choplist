import { useState } from "react";
import { useAuth } from "@clerk/react";
import { NavLink, useNavigate } from "react-router-dom";
import {
  ChefHat,
  ClipboardList,
  CookingPot,
  Truck,
  UserRound,
  UserRoundPen,
  LogOut,
  ChevronUp,
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
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);

  const { signOut } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async () => {
    setIsSigningOut(true);

    try {
      await signOut();
      navigate("/", { replace: true });
    } catch (error) {
      alert("Unable to sign out:", error);
      setIsSigningOut(false);
    }
  };

  return (
    <nav className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-card">
      <div className="mx-auto grid w-full max-w-[420px] grid-cols-5 px-2 py-2">
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

        
        <div className="relative flex justify-center">
          {isAccountMenuOpen && (
            <div
              className="absolute bottom-full right-0 mb-3 w-56 overflow-hidden rounded-xl border border-border bg-card p-1 shadow-lg"
              role="menu"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setIsAccountMenuOpen(false);
                  navigate("/seller/profile/edit");
                }}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm font-medium text-foreground transition-colors hover:bg-muted"
              >
                <UserRoundPen className="h-4 w-4" />
                Update your profile
              </button>

              <div className="my-1 border-t border-border" />

              <button
                type="button"
                role="menuitem"
                disabled={isSigningOut}
                onClick={handleLogout}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm font-medium text-destructive transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
              >
                <LogOut className="h-4 w-4" />
                {isSigningOut ? "Logging out..." : "Logout"}
              </button>
            </div>
          )}

          <button
            type="button"
            aria-label="Account menu"
            aria-expanded={isAccountMenuOpen}
            onClick={() => setIsAccountMenuOpen((open) => !open)}
            className={`flex w-full flex-col items-center gap-1 rounded-lg py-2 text-xs font-medium transition-colors ${
              isAccountMenuOpen
                ? "text-primary"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {isAccountMenuOpen ? (
              <ChevronUp className="h-5 w-5" />
            ) : (
              <UserRound className="h-5 w-5" />
            )}
            <span>Account</span>
          </button>
        </div>
      </div>
    </nav>
  );
}