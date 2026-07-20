import { useEffect, useState } from "react";
import { Activity, Shield, Sparkles } from "lucide-react";
import {
  api,
  type AiStatusResponse,
  type AuditEntry,
  type HealthResponse,
} from "../lib/api";
import { useCurrentUser } from "../components/layout";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

export function Dashboard() {
  const user = useCurrentUser();
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [ai, setAi] = useState<AiStatusResponse | null>(null);
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .health()
      .then((h) => {
        if (!cancelled) setHealth(h);
      })
      .catch(() => {});
    api
      .aiStatus()
      .then((s) => {
        if (!cancelled) setAi(s);
      })
      .catch(() => {});
    if (user.role === "admin") {
      api
        .listAudit(10)
        .then((res) => {
          if (!cancelled) setAudit(res.entries);
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [user.role]);

  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight">
        Welcome back, {user.displayName}
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Here is what is happening on this instance.
      </p>

      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Activity
                className="h-4 w-4 text-muted-foreground"
                aria-hidden="true"
              />
              <CardTitle className="text-sm">Instance status</CardTitle>
            </div>
            <CardDescription>Runtime and database details</CardDescription>
          </CardHeader>
          <CardContent>
            {health ? (
              <div className="divide-y divide-border">
                <InfoRow label="Status" value={health.status} />
                <InfoRow label="Version" value={health.version} />
                <InfoRow
                  label="Database"
                  value={health.db === "sqlite" ? "SQLite" : "PostgreSQL"}
                />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Loading...</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Shield
                className="h-4 w-4 text-muted-foreground"
                aria-hidden="true"
              />
              <CardTitle className="text-sm">Your account</CardTitle>
            </div>
            <CardDescription>Signed-in identity</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="divide-y divide-border">
              <InfoRow label="Email" value={user.email} />
              <InfoRow
                label="Role"
                value={user.role.charAt(0).toUpperCase() + user.role.slice(1)}
              />
              <InfoRow
                label="Sign-in method"
                value={user.authSource === "oidc" ? "Single sign-on" : "Local"}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Sparkles
                className="h-4 w-4 text-muted-foreground"
                aria-hidden="true"
              />
              <CardTitle className="text-sm">AI assistant</CardTitle>
            </div>
            <CardDescription>Optional, off by default</CardDescription>
          </CardHeader>
          <CardContent>
            {ai === null ? (
              <p className="text-sm text-muted-foreground">Loading...</p>
            ) : ai.enabled ? (
              <div className="divide-y divide-border">
                <InfoRow label="Status" value="Enabled" />
                <InfoRow label="Provider" value={ai.provider ?? "Unknown"} />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                AI features are off by default. Hatcheck is fully functional
                without them; an administrator can enable a provider in the
                instance configuration.
              </p>
            )}
          </CardContent>
        </Card>

        {user.role === "admin" && (
          <Card className="md:col-span-2 lg:col-span-3">
            <CardHeader>
              <div className="flex items-center gap-2">
                <Activity
                  className="h-4 w-4 text-muted-foreground"
                  aria-hidden="true"
                />
                <CardTitle className="text-sm">Recent activity</CardTitle>
              </div>
              <CardDescription>
                Latest entries from the append-only audit log
              </CardDescription>
            </CardHeader>
            <CardContent>
              {audit === null ? (
                <p className="text-sm text-muted-foreground">Loading...</p>
              ) : audit.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No activity recorded yet.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="py-2 pr-4 font-medium">Time</th>
                        <th className="py-2 pr-4 font-medium">Actor</th>
                        <th className="py-2 font-medium">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {audit.map((entry) => (
                        <tr
                          key={entry.id}
                          className="border-b border-border last:border-0"
                        >
                          <td className="whitespace-nowrap py-2 pr-4 text-muted-foreground">
                            {new Date(entry.at).toLocaleString()}
                          </td>
                          <td className="py-2 pr-4">
                            {entry.actorEmail ?? "system"}
                          </td>
                          <td className="py-2">
                            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                              {entry.action}
                            </code>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
