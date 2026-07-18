import { useEffect, useState } from "react";
import {
  createBrowserRouter,
  Navigate,
  RouterProvider,
} from "react-router-dom";
import { Loader } from "lucide-react";
import { api, ApiError, type ApiUser } from "./lib/api";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";

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
  const [state, setState] = useState<AuthState>({ kind: "loading" });

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
            message: "Could not reach the server. Please refresh the page.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
    return <Navigate to="/login" replace />;
  }

  if (state.kind === "error") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <p className="text-sm text-muted-foreground">{state.message}</p>
      </div>
    );
  }

  return <Dashboard user={state.user} />;
}

const router = createBrowserRouter([
  { path: "/login", element: <Login /> },
  { path: "/", element: <Protected /> },
  { path: "*", element: <Navigate to="/" replace /> },
]);

export function App() {
  return <RouterProvider router={router} />;
}
