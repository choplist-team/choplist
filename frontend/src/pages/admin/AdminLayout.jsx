import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import {
  LayoutDashboard,
  Users,
  ShoppingBag,
  ChartNoAxesCombined,
  Activity,
  Menu,
  X,
  Undo2,
  MessageSquareWarning,
  BadgeCheck,
  Inbox,
  ShieldCheck,
  LogOut,
} from "lucide-react";
import { ChopListLogo } from "@/components/choplist-logo";
import InboxBadge from "@/components/admin/InboxBadge";
import { useAuth } from "@clerk/react";

const adminNavigation = [
  { label: "Overview", path: "/admin", icon: LayoutDashboard, end: true },
  { label: "Sellers", path: "/admin/sellers", icon: Users },
  { label: "Orders", path: "/admin/orders", icon: ShoppingBag },
  { label: "Analytics", path: "/admin/analytics", icon: ChartNoAxesCombined },
  { label: "System Health", path: "/admin/system-health", icon: Activity },
  // Money
  { label: "Inbox", path: "/admin/inbox", icon: Inbox, badge: true },
  { label: "Refunds", path: "/admin/refunds", icon: Undo2 },
  {
    label: "Payment problems",
    path: "/admin/payment-problems",
    icon: MessageSquareWarning,
  },
  { label: "Subscriptions", path: "/admin/subscriptions", icon: BadgeCheck },
  { label: "System check", path: "/admin/system-check", icon: ShieldCheck },
];

function ChoplistBrand() {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <ChopListLogo />

      <span className="pl-9 mt-2 text-xs font-medium text-muted-foreground">
        Admin workspace
      </span>
    </div>
  );
}
function SidebarContent({ onNavigate, onLogout }) {
  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-border px-5 py-5">
        <ChoplistBrand />
      </div>

      <nav
        aria-label="Admin navigation"
        className="min-h-0 flex-1 space-y-1 overflow-y-auto px-4 py-3"
      >
        <p className="mb-3 px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Workspace
        </p>

        {adminNavigation.map((item) => {
          const Icon = item.icon;

          return (
            <NavLink
              key={item.path}
              to={item.path}
              end={item.end}
              onClick={onNavigate}
              className={({ isActive }) =>
                [
                  "flex min-h-11 items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-primary text-primary-foreground"
                    : "text-foreground hover:bg-muted",
                ].join(" ")
              }
            >
              <Icon size={19} />
              <span>{item.label}</span>
              {item.badge && <InboxBadge />}
            </NavLink>
          );
        })}
      </nav>

      <div className="shrink-0 border-t border-border">
        <button
          type="button"
          onClick={onLogout}
          className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10"
        >
          <LogOut size={19} />
          Sign out
        </button>
      </div>
    </div>
  );
}

export default function AdminLayout() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const { signOut } = useAuth();

  async function handleLogout() {
    await signOut({
      redirectUrl: "/admin/sign-in",
    });
  }

  function closeMobileMenu() {
    setMobileMenuOpen(false);
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-border bg-card lg:block">
        <SidebarContent onLogout={handleLogout} />
      </aside>

      {/* Mobile header */}
      <header className="sticky top-0 z-20 flex min-h-20 items-center justify-between border-b border-border bg-background px-4 py-2 lg:hidden">
        {" "}
        <ChoplistBrand />
        <button
          type="button"
          onClick={() => setMobileMenuOpen((open) => !open)}
          aria-label={mobileMenuOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={mobileMenuOpen}
          className="inline-flex size-11 items-center justify-center rounded-xl border border-border hover:bg-muted"
        >
          {mobileMenuOpen ? <X size={21} /> : <Menu size={21} />}
        </button>
      </header>

      {/* Mobile menu backdrop */}
      {mobileMenuOpen && (
        <>
          <button
            type="button"
            aria-label="Close navigation menu"
            onClick={closeMobileMenu}
            className="fixed inset-0 z-30 bg-black/40 lg:hidden"
          />

          <aside className="fixed inset-y-0 left-0 z-40 w-[min(18rem,85vw)] border-r border-border bg-card shadow-xl lg:hidden">
            <SidebarContent
              onNavigate={closeMobileMenu}
              onLogout={handleLogout}
            />
          </aside>
        </>
      )}

      {/* Main content */}
      <div className="min-w-0 lg:pl-64">
        <div className="hidden h-16 items-center justify-between border-b border-border px-8 lg:flex">
          <p className="text-sm text-muted-foreground">
            Choplist administration
          </p>

          <span className="rounded-full border border-border px-3 py-1 text-xs font-medium text-muted-foreground">
            Admin workspace
          </span>
        </div>

        <main className="min-w-0">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
