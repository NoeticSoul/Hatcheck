// Locations: the site > building > room hierarchy, kept ceremony-free for
// flat homelab use (parent is always optional). Rank rules live in the
// API; this page surfaces its errors instead of duplicating them.
import { useEffect, useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import {
  api,
  ApiError,
  type ApiLocation,
  type LocationKind,
} from "../lib/api";
import { locationPath } from "../lib/format";
import { canWrite, useCurrentUser } from "../components/layout";
import { Pagination } from "../components/pagination";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select } from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { useLocations, toNull } from "./Assets";

const PAGE_SIZE = 25;
const RANK: Record<LocationKind, number> = { site: 0, building: 1, room: 2 };
const KIND_LABELS: Record<LocationKind, string> = {
  site: "Site",
  building: "Building",
  room: "Room",
};

interface LocationForm {
  name: string;
  kind: LocationKind;
  parentId: string;
  description: string;
  isActive: boolean;
}

const EMPTY_FORM: LocationForm = {
  name: "",
  kind: "room",
  parentId: "",
  description: "",
  isActive: true,
};

export function LocationsPage() {
  const user = useCurrentUser();
  const writer = canWrite(user);
  // Full map for paths and parent pickers; the table itself pages
  // server-side below.
  const { locations: allLocations, byId, reload: reloadAll } = useLocations();

  const [items, setItems] = useState<ApiLocation[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [nonce, setNonce] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [dialog, setDialog] = useState<"none" | "create" | "edit">("none");
  const [editing, setEditing] = useState<ApiLocation | null>(null);
  const [form, setForm] = useState<LocationForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .listLocations({ limit: PAGE_SIZE, offset, includeInactive: true })
      .then((page) => {
        if (cancelled) return;
        // A delete can empty the current page; step back instead of
        // stranding the user on an empty page past the end.
        if (page.items.length === 0 && offset > 0 && page.total > 0) {
          setOffset(Math.max(0, offset - PAGE_SIZE));
          return;
        }
        setItems(page.items);
        setTotal(page.total);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          err instanceof ApiError ? err.message : "Could not load locations.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [offset, nonce]);

  function refresh() {
    setNonce((n) => n + 1);
    reloadAll();
  }

  function openCreate() {
    setForm(EMPTY_FORM);
    setFormError(null);
    setEditing(null);
    setDialog("create");
  }

  function openEdit(location: ApiLocation) {
    setForm({
      name: location.name,
      kind: location.kind,
      parentId: location.parentId ?? "",
      description: location.description ?? "",
      isActive: location.isActive,
    });
    setFormError(null);
    setEditing(location);
    setDialog("edit");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      if (dialog === "create") {
        await api.createLocation({
          name: form.name.trim(),
          kind: form.kind,
          parentId: form.parentId === "" ? null : form.parentId,
          description: toNull(form.description),
        });
      } else if (editing !== null) {
        await api.updateLocation(editing.id, {
          name: form.name.trim(),
          kind: form.kind,
          parentId: form.parentId === "" ? null : form.parentId,
          description: toNull(form.description),
          isActive: form.isActive,
        });
      }
      setDialog("none");
      refresh();
    } catch (err) {
      setFormError(
        err instanceof ApiError ? err.message : "Could not save the location.",
      );
    } finally {
      setBusy(false);
    }
  }

  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function remove(location: ApiLocation) {
    if (deletingId !== null) return;
    setDeletingId(location.id);
    setError(null);
    try {
      await api.deleteLocation(location.id);
      refresh();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `${location.name}: ${err.message}`
          : "Could not delete the location.",
      );
    } finally {
      setDeletingId(null);
    }
  }

  // Valid parents have a strictly lower rank; when editing, a location
  // can never be its own parent.
  const parentOptions = allLocations.filter(
    (candidate) =>
      RANK[candidate.kind] < RANK[form.kind] &&
      (editing === null || candidate.id !== editing.id),
  );

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Locations</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Site, building, and room hierarchy — or a single flat level.
          </p>
        </div>
        {writer && (
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            New location
          </Button>
        )}
      </div>

      {error !== null && (
        <p className="mt-4 text-sm text-destructive">{error}</p>
      )}

      <div className="mt-6 rounded-xl border border-border bg-card px-4">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Location</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Active</TableHead>
              {writer && <TableHead className="w-32">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {items === null ? (
              <TableRow>
                <TableCell
                  colSpan={writer ? 5 : 4}
                  className="text-muted-foreground"
                >
                  Loading...
                </TableCell>
              </TableRow>
            ) : items.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={writer ? 5 : 4}
                  className="text-muted-foreground"
                >
                  No locations yet.
                </TableCell>
              </TableRow>
            ) : (
              items.map((location) => (
                <TableRow key={location.id}>
                  <TableCell className="font-medium">
                    {locationPath(location, byId)}
                  </TableCell>
                  <TableCell>{KIND_LABELS[location.kind]}</TableCell>
                  <TableCell className="max-w-72 truncate text-muted-foreground">
                    {location.description ?? ""}
                  </TableCell>
                  <TableCell>
                    {location.isActive ? (
                      <Badge variant="secondary">Active</Badge>
                    ) : (
                      <Badge variant="muted">Inactive</Badge>
                    )}
                  </TableCell>
                  {writer && (
                    <TableCell>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openEdit(location)}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={deletingId !== null}
                          onClick={() => void remove(location)}
                        >
                          Delete
                        </Button>
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Pagination
        total={total}
        limit={PAGE_SIZE}
        offset={offset}
        onPage={setOffset}
        noun="locations"
      />

      <Dialog
        open={dialog !== "none"}
        onClose={() => setDialog("none")}
        title={dialog === "create" ? "New location" : "Edit location"}
      >
        <form onSubmit={submit} className="space-y-4">
          <div>
            <Label htmlFor="location-name">Name</Label>
            <Input
              id="location-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
              maxLength={200}
              className="mt-1.5"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="location-kind">Kind</Label>
              <Select
                id="location-kind"
                value={form.kind}
                onChange={(e) => {
                  const kind = e.target.value as LocationKind;
                  // Drop a parent that is no longer strictly higher rank.
                  const parent =
                    form.parentId === ""
                      ? undefined
                      : byId.get(form.parentId);
                  setForm({
                    ...form,
                    kind,
                    parentId:
                      parent !== undefined && RANK[parent.kind] < RANK[kind]
                        ? form.parentId
                        : "",
                  });
                }}
                className="mt-1.5"
              >
                {Object.entries(KIND_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="location-parent">Parent</Label>
              <Select
                id="location-parent"
                value={form.parentId}
                onChange={(e) =>
                  setForm({ ...form, parentId: e.target.value })
                }
                disabled={form.kind === "site"}
                className="mt-1.5"
              >
                <option value="">
                  {form.kind === "site" ? "Sites have no parent" : "None"}
                </option>
                {parentOptions.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {locationPath(candidate, byId)}
                    {candidate.isActive ? "" : " (inactive)"}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <div>
            <Label htmlFor="location-description">Description</Label>
            <Textarea
              id="location-description"
              value={form.description}
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
              rows={2}
              maxLength={2000}
              className="mt-1.5"
            />
          </div>
          {dialog === "edit" && (
            <div className="flex items-center gap-2">
              <input
                id="location-active"
                type="checkbox"
                checked={form.isActive}
                onChange={(e) =>
                  setForm({ ...form, isActive: e.target.checked })
                }
                className="h-4 w-4 rounded border-border"
              />
              <Label htmlFor="location-active">Active</Label>
            </div>
          )}
          {formError !== null && (
            <p className="text-sm text-destructive">{formError}</p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setDialog("none")}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={busy || form.name.trim() === ""}
            >
              {dialog === "create" ? "Create location" : "Save changes"}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
