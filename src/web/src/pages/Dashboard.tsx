import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, type DashboardResponse } from "../lib/api";
import { canWrite, useCurrentUser } from "../components/layout";
import { formatDateTime } from "../lib/format";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";

export function Dashboard() {
  const user = useCurrentUser();
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    api.dashboard().then((res) => { if (!cancelled) setData(res); }).catch((err: unknown) => {
      if (!cancelled) setError(err instanceof ApiError ? err.message : "Could not load the dashboard.");
    });
    return () => { cancelled = true; };
  }, [nonce]);

  const cards = data ? [
    { label: "Inventory", count: data.assets.total, to: "/assets" },
    { label: "In stock", count: data.assets.in_stock, to: "/assets?status=in_stock" },
    { label: "Deployed", count: data.assets.deployed, to: "/assets?status=deployed" },
    { label: "In repair", count: data.assets.in_repair, to: "/assets?status=in_repair" },
    ...(canWrite(user) ? [{ label: "Open exceptions", count: data.openExceptions, to: "/exceptions" }] : []),
    ...(data.overdueDocuments !== undefined ? [{ label: "Documents due for review", count: data.overdueDocuments, to: "/documents?overdue=true&published=true" }] : []),
  ] : [];

  return <><h1 className="text-xl font-semibold tracking-tight">Welcome back, {user.displayName}</h1><p className="mt-1 text-sm text-muted-foreground">Inventory, custody changes, and work needing review.</p>
    {error && <div className="mt-4 flex flex-wrap items-center gap-2" role="alert"><p className="text-sm text-destructive">{error}</p><Button variant="outline" size="sm" onClick={() => setNonce((n) => n + 1)}>Retry dashboard</Button></div>}
    {!data && !error && <p className="mt-6 text-sm text-muted-foreground">Loading...</p>}
    {data && <><div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-3">{cards.map((card) => <Link to={card.to} key={card.label} className="rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><Card className="h-full transition-colors hover:bg-accent"><CardHeader><CardTitle className="text-sm text-muted-foreground">{card.label}</CardTitle></CardHeader><CardContent><p className="text-3xl font-semibold">{card.count}</p></CardContent></Card></Link>)}</div>
      <Card className="mt-6"><CardHeader><CardTitle>Recent custody</CardTitle><CardDescription>Latest check-ins and check-outs. Open an asset for its complete history.</CardDescription></CardHeader><CardContent>{data.recentCustody.length === 0 ? <p className="text-sm text-muted-foreground">No custody events yet.</p> : <ul className="divide-y divide-border">{data.recentCustody.map((event) => <li key={event.id} className="flex flex-wrap items-center justify-between gap-3 py-3"><div className="min-w-0"><Link to={`/assets/${event.assetId}`} className="break-words text-sm font-medium underline underline-offset-4">{event.assetName ?? "View asset"}</Link><p className="mt-1 text-xs text-muted-foreground">{formatDateTime(event.at)}{event.actorEmail ? ` by ${event.actorEmail}` : ""}</p><p className="mt-1 break-words text-sm">{event.type === "check_out" ? `To ${event.holderName ?? "holder"}` : "Returned to stock"}{event.locationName ? ` at ${event.locationName}` : ""}</p></div><Badge variant={event.type === "check_out" ? "default" : "secondary"}>{event.type === "check_out" ? "Checked out" : "Checked in"}</Badge></li>)}</ul>}</CardContent></Card></>}
    <p className="mt-6 text-sm text-muted-foreground">Signed in as {user.email}. <Link to="/account" className="underline">Manage your account</Link></p>
  </>;
}
