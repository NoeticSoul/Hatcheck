import { useEffect, useState } from "react";
import {
  createBrowserRouter,
  Navigate,
  RouterProvider,
  useLocation,
} from "react-router-dom";
import { Loader } from "lucide-react";
import { api, ApiError, SESSION_EXPIRED_EVENT, type ApiUser } from "./lib/api";
import { Button } from "./components/ui/button";
import { AppLayout } from "./components/layout";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { AssetsPage } from "./pages/Assets";
import { AssetDetailPage } from "./pages/AssetDetail";
import { LocationsPage } from "./pages/Locations";
import { ImportPage } from "./pages/Import";
import { ExceptionsPage } from "./pages/Exceptions";
import { AuditPage } from "./pages/Audit";
import { UsersPage } from "./pages/Users";
import { AccountPage } from "./pages/Account";
import { ImportDetailPage } from "./pages/ImportDetail";
import { DocumentsPage } from "./pages/Documents";
import { DocumentDetailPage } from "./pages/DocumentDetail";

type AuthState =
  | { kind: "loading" }
  | { kind: "authenticated"; user: ApiUser }
  | { kind: "unauthenticated" }
  | { kind: "error"; message: string };

/**
 * Auth guard for protected routes: asks the API who the current user is
 * and redirects to /login on 401. RBAC itself is enforced by the API
 * (hard rule 5); the UI only decides what to show.
 */
function Protected() {
  const location = useLocation();
  const [state, setState] = useState<AuthState>({ kind: "loading" });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const expired = () => setState({ kind: "unauthenticated" });
    window.addEventListener(SESSION_EXPIRED_EVENT, expired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, expired);
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .me()
      .then(({ user }) => {
        if (!cancelled) setState({ kind: "authenticated", user });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          setState({ kind: "unauthenticated" });
        } else {
          setState({
            kind: "error",
            message: "Could not reach the server. Please try again.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  if (state.kind === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader
          className="h-6 w-6 animate-spin text-muted-foreground"
          aria-label="Loading"
        />
      </div>
    );
  }

  if (state.kind === "unauthenticated") {
    const destination = location.pathname + location.search + location.hash;
    return <Navigate to={destination === "/" ? "/login" : `/login?returnTo=${encodeURIComponent(destination)}`} replace />;
  }

  if (state.kind === "error") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-4">
        <p role="alert" className="text-sm text-muted-foreground">{state.message}</p>
        <Button onClick={() => { setState({ kind: "loading" }); setNonce((n) => n + 1); }}>Retry</Button>
      </div>
    );
  }

  return <AppLayout user={state.user} />;
}

const router = createBrowserRouter([
  { path: "/login", element: <Login /> },
  {
    path: "/",
    element: <Protected />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: "assets", element: <AssetsPage /> },
      { path: "assets/:id", element: <AssetDetailPage /> },
      { path: "locations", element: <LocationsPage /> },
      { path: "documents", element: <DocumentsPage /> },
      { path: "documents/:id", element: <DocumentDetailPage /> },
      { path: "import", element: <ImportPage /> },
      { path: "import/:id", element: <ImportDetailPage /> },
      { path: "exceptions", element: <ExceptionsPage /> },
      { path: "audit", element: <AuditPage /> },
      { path: "users", element: <UsersPage /> },
      { path: "account", element: <AccountPage /> },
    ],
  },
  { path: "*", element: <Navigate to="/" replace /> },
]);

export function App() {
  return <RouterProvider router={router} />;
}
