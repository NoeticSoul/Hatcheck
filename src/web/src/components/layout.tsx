// App shell for authenticated pages: header with brand, primary nav, and
// the signed-in identity. RBAC is enforced by the API (hard rule 5); the
// nav only decides what to SHOW (e.g. the Audit link is admin-only).
import { useState } from "react";
import {
  NavLink,
  Outlet,
  useNavigate,
  useOutletContext,
} from "react-router-dom";
import { Boxes, LogOut } from "lucide-react";
import { api, type ApiUser, type Role } from "../lib/api";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";

const roleBadgeClasses: Record<Role, string> = {
  admin: "bg-primary text-primary-foreground",
  technician: "bg-secondary text-secondary-foreground border border-border",
  readonly: "bg-muted text-muted-foreground border border-border",
};

export function RoleBadge({ role }: { role: Role }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize",
        roleBadgeClasses[role],
      )}
    >
      {role}
    </span>
  );
}

interface LayoutContext {
  user: ApiUser;
}

/** Signed-in user for pages rendered inside AppLayout. */
export function useCurrentUser(): ApiUser {
  return useOutletContext<LayoutContext>().user;
}

/** True when the user may perform write actions (technician or admin). */
export function canWrite(user: ApiUser): boolean {
  return user.role === "technician" || user.role === "admin";
}

const NAV_ITEMS: {
  to: string;
  label: string;
  adminOnly?: boolean;
  writeOnly?: boolean;
}[] = [
  { to: "/", label: "Dashboard" },
  { to: "/assets", label: "Assets" },
  { to: "/locations", label: "Locations" },
  // Import and exception review are technician+ at the API, so readonly
  // users are not offered dead links (direct URLs still get a friendly
  // explanation from the pages themselves).
  { to: "/import", label: "Import", writeOnly: true },
  { to: "/exceptions", label: "Exceptions", writeOnly: true },
  { to: "/audit", label: "Audit", adminOnly: true },
];

export function AppLayout({ user }: { user: ApiUser }) {
  const navigate = useNavigate();
  const [loggingOut, setLoggingOut] = useState(false);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await api.logout();
    } catch {
      // Even if the request fails, drop back to the login screen.
    }
    navigate("/login", { replace: true });
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-6">
            <div className="flex items-center gap-2">
              <Boxes className="h-5 w-5 text-primary" aria-hidden="true" />
              <span className="text-base font-semibold tracking-tight">
                Hatcheck
              </span>
            </div>
            <nav aria-label="Primary" className="flex items-center gap-1 overflow-x-auto">
              {NAV_ITEMS.filter(
                (item) =>
                  (!item.adminOnly || user.role === "admin") &&
                  (!item.writeOnly || canWrite(user)),
              ).map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === "/"}
                  className={({ isActive }) =>
                    cn(
                      "rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors",
                      isActive
                        ? "bg-secondary text-secondary-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                    )
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <span className="hidden text-sm font-medium sm:inline">
              {user.displayName}
            </span>
            <RoleBadge role={user.role} />
            <Button
              variant="ghost"
              size="sm"
              onClick={handleLogout}
              disabled={loggingOut}
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">Sign out</span>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <Outlet context={{ user } satisfies LayoutContext} />
      </main>
    </div>
  );
}
