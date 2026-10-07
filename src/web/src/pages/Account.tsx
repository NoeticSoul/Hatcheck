import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { RoleBadge, useCurrentUser } from "../components/layout";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";

export function AccountPage() {
  const user = useCurrentUser();
  const navigate = useNavigate();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (newPassword !== confirmPassword) { setError("The new passwords do not match."); return; }
    setBusy(true);
    try {
      await api.changePassword(currentPassword, newPassword);
      setCurrentPassword(""); setNewPassword(""); setConfirmPassword("");
      navigate("/login?passwordChanged=1&returnTo=%2Faccount", { replace: true });
    } catch (err) { setError(err instanceof ApiError ? err.message : "Could not change your password. Please try again."); }
    finally { setBusy(false); }
  }

  return <><h1 className="text-xl font-semibold tracking-tight">Your account</h1><div className="mt-6 grid gap-4 md:grid-cols-2"><Card><CardHeader><CardTitle>{user.displayName}</CardTitle><CardDescription>{user.email}</CardDescription></CardHeader><CardContent><RoleBadge role={user.role} /><p className="mt-4 text-sm text-muted-foreground">{user.authSource === "oidc" ? "Sign-in and passwords are managed by your identity provider." : "Local account. Contact an administrator to change your name or access."}</p></CardContent></Card>
    {user.authSource === "local" && <Card><CardHeader><CardTitle>Change password</CardTitle><CardDescription>Changing your password signs out every session, including this one.</CardDescription></CardHeader><CardContent><form onSubmit={submit} className="space-y-4"><div><Label htmlFor="current-password">Current password</Label><Input id="current-password" type="password" autoComplete="current-password" required value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} disabled={busy} className="mt-1.5" /></div><div><Label htmlFor="new-password">New password</Label><Input id="new-password" type="password" autoComplete="new-password" minLength={12} required value={newPassword} onChange={(e) => setNewPassword(e.target.value)} disabled={busy} className="mt-1.5" /><p className="mt-1 text-xs text-muted-foreground">Use at least 12 characters.</p></div><div><Label htmlFor="confirm-password">Confirm new password</Label><Input id="confirm-password" type="password" autoComplete="new-password" minLength={12} required value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} disabled={busy} className="mt-1.5" /></div>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<Button type="submit" disabled={busy}>{busy ? "Changing password..." : "Change password"}</Button></form></CardContent></Card>}
  </div></>;
}
