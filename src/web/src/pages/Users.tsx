import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import { api, ApiError, type ApiUser, type Role } from "../lib/api";
import { RoleBadge, useCurrentUser } from "../components/layout";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select } from "../components/ui/select";
import { Badge } from "../components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

interface UserForm { email: string; displayName: string; role: Role; isActive: boolean; password: string }
const EMPTY: UserForm = { email: "", displayName: "", role: "technician", isActive: true, password: "" };

export function UsersPage() {
  const currentUser = useCurrentUser();
  const navigate = useNavigate();
  const [users, setUsers] = useState<ApiUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [dialog, setDialog] = useState<"create" | "edit" | "reset" | null>(null);
  const [target, setTarget] = useState<ApiUser | null>(null);
  const [form, setForm] = useState<UserForm>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (currentUser.role !== "admin") return;
    let cancelled = false;
    setError(null);
    setUsers(null);
    api.listUsers().then((res) => { if (!cancelled) setUsers(res.users); }).catch((err: unknown) => {
      if (!cancelled) setError(err instanceof ApiError ? err.message : "Could not load users.");
    });
    return () => { cancelled = true; };
  }, [currentUser.role, nonce]);

  if (currentUser.role !== "admin") return <p>User administration requires the admin role.</p>;

  function open(kind: "create" | "edit" | "reset", user: ApiUser | null = null) {
    setTarget(user);
    setForm(user ? { email: user.email, displayName: user.displayName, role: user.role, isActive: user.isActive, password: "" } : EMPTY);
    setFormError(null);
    setDialog(kind);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setFormError(null);
    try {
      if (dialog === "create") {
        await api.createUser({ email: form.email.trim(), displayName: form.displayName.trim(), role: form.role, password: form.password });
      } else if (target) {
        await api.updateUser(target.id, dialog === "reset" ? { password: form.password } : { displayName: form.displayName.trim(), role: form.role, isActive: form.isActive });
        if (target.id === currentUser.id) {
          if (dialog === "reset" || !form.isActive) {
            navigate(dialog === "reset" ? "/login?passwordChanged=1" : "/login", { replace: true });
          } else {
            // Refresh the signed-in identity and its role-dependent navigation.
            window.location.reload();
          }
        }
      }
      setDialog(null);
      setForm(EMPTY);
      setNonce((n) => n + 1);
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Could not save the user. Please try again.");
    } finally { setBusy(false); }
  }

  return <>
    <div className="flex flex-wrap items-center justify-between gap-4"><div><h1 className="text-xl font-semibold tracking-tight">Users</h1><p className="mt-1 text-sm text-muted-foreground">Manage access, local credentials, and inactive accounts.</p></div><Button onClick={() => open("create")}><Plus className="h-4 w-4" aria-hidden="true" />New user</Button></div>
    {error && <div className="mt-4 flex flex-wrap items-center gap-3" role="alert"><p className="text-sm text-destructive">{error}</p><Button variant="outline" size="sm" onClick={() => setNonce((n) => n + 1)}>Retry</Button></div>}
    <div className="mt-6 rounded-xl border border-border bg-card px-4"><Table><TableHeader><TableRow><TableHead>Name / email</TableHead><TableHead>Role</TableHead><TableHead>Sign-in</TableHead><TableHead>Status</TableHead><TableHead>Actions</TableHead></TableRow></TableHeader><TableBody>
      {users === null ? <TableRow><TableCell colSpan={5}>{error ? "Users unavailable." : "Loading..."}</TableCell></TableRow> : users.map((user) => <TableRow key={user.id}>
        <TableCell><p className="font-medium">{user.displayName}{user.id === currentUser.id ? " (you)" : ""}</p><p className="text-xs text-muted-foreground">{user.email}</p></TableCell><TableCell><RoleBadge role={user.role} /></TableCell><TableCell>{user.authSource === "local" ? "Local" : "Single sign-on"}</TableCell><TableCell><Badge variant={user.isActive ? "secondary" : "muted"}>{user.isActive ? "Active" : "Inactive"}</Badge></TableCell><TableCell><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={() => open("edit", user)} aria-label={`Edit ${user.displayName}`}>Edit access</Button>{user.authSource === "local" && <Button variant="outline" size="sm" onClick={() => open("reset", user)} aria-label={`Reset password for ${user.displayName}`}>Reset password</Button>}</div></TableCell>
      </TableRow>)}
    </TableBody></Table></div>
    <Dialog open={dialog !== null} onClose={() => { if (!busy) setDialog(null); }} title={dialog === "create" ? "New user" : dialog === "reset" ? "Reset password" : "Edit user"} description={dialog === "reset" ? "All existing sessions for this user will be revoked. Share the new password through a secure channel." : "At least one active administrator must remain. Deactivating an account revokes its sessions."}>
      <form onSubmit={submit} className="space-y-4">
        {dialog !== "reset" && <>
          <div><Label htmlFor="user-name">Display name</Label><Input id="user-name" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} required disabled={busy} className="mt-1.5" /></div>
          <div><Label htmlFor="user-email">Email</Label><Input id="user-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required disabled={busy || dialog !== "create"} autoComplete="off" className="mt-1.5" /></div>
          <div><Label htmlFor="user-role">Role</Label><Select id="user-role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })} disabled={busy} className="mt-1.5"><option value="readonly">Read only</option><option value="technician">Technician</option><option value="admin">Administrator</option></Select></div>
          {dialog === "edit" && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} disabled={busy} />Account active</label>}
        </>}
        {(dialog === "create" || dialog === "reset") && <div><Label htmlFor="user-password">{dialog === "create" ? "Initial password" : "New password"}</Label><Input id="user-password" type="password" autoComplete="new-password" minLength={12} required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} disabled={busy} className="mt-1.5" /><p className="mt-1 text-xs text-muted-foreground">Use at least 12 characters.</p></div>}
        {formError && <p role="alert" className="text-sm text-destructive">{formError}</p>}
        <div className="flex justify-end gap-2"><Button type="button" variant="outline" disabled={busy} onClick={() => setDialog(null)}>Cancel</Button><Button type="submit" disabled={busy}>{busy ? "Saving..." : dialog === "create" ? "Create user" : dialog === "reset" ? "Reset password" : "Save changes"}</Button></div>
      </form>
    </Dialog>
  </>;
}
