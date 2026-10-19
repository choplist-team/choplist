import { useState } from "react";
import { useAuth } from "@clerk/react";
import { Link, NavLink, useNavigate } from "react-router-dom";
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
import { useQuery } from "@tanstack/react-query";
import { ChopListLogo } from "@/components/choplist-logo";

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
  const { data: seller } = useQuery({
    queryKey: ["current-seller"],
    enabled: false,
  });

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
    <>
      <aside className="fixed inset-y-0 left-0 z-50 hidden w-64 flex-col border-r border-border bg-card lg:flex">
        <div className="px-6 pb-6 pt-8">
          <Link to="/" aria-label="Go to ChopList home">
            <ChopListLogo />
          </Link>

          {seller?.businessName && (
            <p className="mt-3 truncate text-sm font-semibold text-muted-foreground">
              {seller.businessName}
            </p>
          )}
        </div>

        <nav className="flex-1 space-y-1 px-3" aria-label="Seller navigation">
          {navigationItems.map(({ label, path, icon: Icon }) => (
            <NavLink
              key={path}
              to={path}
              end={path === "/seller/dashboard"}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-soft-green text-primary"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                }`
              }
            >
              {({ isActive }) => (
                <>
                  <Icon
                    className={`h-5 w-5 ${isActive ? "stroke-[2.5]" : ""}`}
                  />
                  <span>{label}</span>
                </>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="space-y-1 border-t border-border p-3">
          <NavLink
            to="/seller/profile/edit"
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                isActive
                  ? "bg-soft-green text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`
            }
          >
            <UserRoundPen className="h-5 w-5" />
            Update your profile
          </NavLink>

          <button
            type="button"
            disabled={isSigningOut}
            onClick={handleLogout}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium text-destructive transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
          >
            <LogOut className="h-5 w-5" />
            {isSigningOut ? "Logging out..." : "Logout"}
          </button>
        </div>
      </aside>

      <nav className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-card lg:hidden">
        <div className="mx-auto grid w-full max-w-[420px] grid-cols-5 px-2 py-2 md:max-w-xl">
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
                    className={`h-5 w-5 ${isActive ? "stroke-[2.5]" : ""}`}
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
    </>
  );
}
