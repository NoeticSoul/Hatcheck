// Asset detail: fields, identity keys, interfaces, and the custody
// history — the append-only ticket stub, shown newest first. Check-out
// and check-in are the ONLY way status reaches/leaves "deployed"; the
// forms here mirror those API rules instead of hiding them.
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, LogIn, LogOut, Pencil, Trash2 } from "lucide-react";
import {
  api,
  ApiError,
  type ApiCustodyEvent,
  type AssetDetailResponse,
  type UserOption,
} from "../lib/api";
import {
  formatDateTime,
  locationPath,
  TYPE_LABELS,
} from "../lib/format";
import { canWrite, useCurrentUser } from "../components/layout";
import { Pagination } from "../components/pagination";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
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
import {
  AssetFormFields,
  StatusBadge,
  toNull,
  useLocations,
  type AssetFormValues,
} from "./Assets";

const HISTORY_PAGE = 10;

function FieldRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="whitespace-pre-wrap text-right font-medium">
        {value === null || value === "" ? "—" : value}
      </span>
    </div>
  );
}

export function AssetDetailPage() {
  const { id } = useParams<{ id: string }>();
  const user = useCurrentUser();
  const navigate = useNavigate();
  const { locations, byId } = useLocations();

  const [detail, setDetail] = useState<AssetDetailResponse | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [history, setHistory] = useState<ApiCustodyEvent[] | null>(null);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  // Reset per-asset state when navigating between assets, so a stale
  // not-found or an old asset's history never leaks across ids.
  useEffect(() => {
    setDetail(null);
    setNotFound(false);
    setLoadError(null);
    setHistory(null);
    setHistoryOffset(0);
  }, [id]);

  useEffect(() => {
    if (id === undefined) return;
    let cancelled = false;
    api
      .getAsset(id)
      .then((res) => {
        if (cancelled) return;
        setDetail(res);
        setNotFound(false);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setNotFound(true);
        } else {
          setLoadError("Could not load the asset. Please try again.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id, nonce]);

  useEffect(() => {
    if (id === undefined) return;
    let cancelled = false;
    api
      .listCustody(id, HISTORY_PAGE, historyOffset)
      .then((page) => {
        if (cancelled) return;
        setHistory(page.items);
        setHistoryTotal(page.total);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id, historyOffset, nonce]);

  if (notFound) {
    return (
      <div>
        <p className="text-sm text-muted-foreground">Asset not found.</p>
        <Button
          variant="outline"
          size="sm"
          className="mt-4"
          onClick={() => navigate("/assets")}
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to assets
        </Button>
      </div>
    );
  }

  if (loadError !== null) {
    return (
      <div>
        <p className="text-sm text-destructive">{loadError}</p>
        <Button variant="outline" size="sm" className="mt-4" onClick={reload}>
          Retry
        </Button>
      </div>
    );
  }

  if (detail === null || id === undefined) {
    return <p className="text-sm text-muted-foreground">Loading...</p>;
  }

  const { asset, interfaces, currentCustody } = detail;
  const writer = canWrite(user);

  return (
    <>
      <Link
        to="/assets"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:underline"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Assets
      </Link>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">
            {asset.name}
          </h1>
          <span data-testid="asset-status">
            <StatusBadge status={asset.status} />
          </span>
        </div>
        {writer && (
          <AssetActions
            assetId={id}
            status={asset.status}
            isAdmin={user.role === "admin"}
            currentHolder={currentCustody?.holderName ?? null}
            locations={locations}
            byId={byId}
            asset={asset}
            onChanged={reload}
          />
        )}
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Details</CardTitle>
            <CardDescription>Descriptive attributes</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="divide-y divide-border">
              <FieldRow label="Type" value={TYPE_LABELS[asset.assetType]} />
              <FieldRow
                label="Location"
                value={
                  asset.locationId === null
                    ? null
                    : (() => {
                        // Prefer the full path from the loaded map; fall
                        // back to the record the API itself returned so
                        // the location never blanks out.
                        const location = byId.get(asset.locationId);
                        if (location !== undefined) {
                          return (
                            locationPath(location, byId) +
                            (location.isActive ? "" : " (inactive)")
                          );
                        }
                        return detail.location?.name ?? null;
                      })()
                }
              />
              <FieldRow label="Model" value={asset.model} />
              <FieldRow label="Manufacturer" value={asset.manufacturer} />
              <FieldRow label="Notes" value={asset.notes} />
              <FieldRow
                label="Created"
                value={formatDateTime(asset.createdAt)}
              />
              <FieldRow
                label="Updated"
                value={formatDateTime(asset.updatedAt)}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Identity</CardTitle>
            <CardDescription>
              Distinct keys — none is assumed globally unique or always
              present
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="divide-y divide-border">
              <FieldRow label="Asset tag" value={asset.assetTag} />
              <FieldRow label="Serial number" value={asset.serialNumber} />
              <FieldRow label="System UUID" value={asset.systemUuid} />
            </div>
            <div className="mt-4 border-t border-border pt-4">
              <InterfacesSection
                assetId={id}
                interfaces={interfaces}
                writer={writer}
                onChanged={reload}
              />
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2" data-testid="custody-history">
          <CardHeader>
            <CardTitle className="text-sm">Custody history</CardTitle>
            <CardDescription>
              Append-only event stream — the ticket stub. Current holder:{" "}
              {currentCustody?.holderName ?? "none (in stock)"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {history === null ? (
              <p className="text-sm text-muted-foreground">Loading...</p>
            ) : history.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No custody events yet.
              </p>
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Time</TableHead>
                      <TableHead>Event</TableHead>
                      <TableHead>Holder</TableHead>
                      <TableHead>Location</TableHead>
                      <TableHead>Note</TableHead>
                      <TableHead>By</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {history.map((event) => (
                      <TableRow key={event.id}>
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {formatDateTime(event.at)}
                        </TableCell>
                        <TableCell>
                          {event.type === "check_out" ? (
                            <Badge>Checked out</Badge>
                          ) : (
                            <Badge variant="secondary">Checked in</Badge>
                          )}
                        </TableCell>
                        <TableCell>{event.holderName ?? "—"}</TableCell>
                        <TableCell>{event.locationName ?? "—"}</TableCell>
                        <TableCell className="max-w-64 truncate">
                          {event.note ?? ""}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {event.actorEmail ?? ""}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <Pagination
                  total={historyTotal}
                  limit={HISTORY_PAGE}
                  offset={historyOffset}
                  onPage={setHistoryOffset}
                  noun="events"
                />
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function InterfacesSection({
  assetId,
  interfaces,
  writer,
  onChanged,
}: {
  assetId: string;
  interfaces: AssetDetailResponse["interfaces"];
  writer: boolean;
  onChanged: () => void;
}) {
  const [mac, setMac] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function addInterface(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.addAssetInterface(assetId, {
        mac: mac.trim(),
        label: toNull(label),
      });
      setMac("");
      setLabel("");
      onChanged();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not add interface.",
      );
    } finally {
      setBusy(false);
    }
  }

  const [removingId, setRemovingId] = useState<string | null>(null);

  async function removeInterface(interfaceId: string) {
    if (removingId !== null) return;
    setRemovingId(interfaceId);
    setError(null);
    try {
      await api.deleteAssetInterface(assetId, interfaceId);
      onChanged();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not remove interface.",
      );
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <div>
      <p className="text-sm font-medium">Network interfaces</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        MACs are per-interface attributes, never identity keys.
      </p>
      {interfaces.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">No interfaces.</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {interfaces.map((iface) => (
            <li
              key={iface.id}
              className="flex items-center justify-between gap-2 text-sm"
            >
              <span>
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                  {iface.mac}
                </code>
                {iface.label !== null && (
                  <span className="ml-2 text-muted-foreground">
                    {iface.label}
                  </span>
                )}
              </span>
              {writer && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={removingId !== null}
                  onClick={() => void removeInterface(iface.id)}
                  aria-label={`Remove interface ${iface.mac}`}
                >
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {writer && (
        <form onSubmit={addInterface} className="mt-3 flex flex-wrap gap-2">
          <Input
            value={mac}
            onChange={(e) => setMac(e.target.value)}
            placeholder="aa:bb:cc:dd:ee:ff"
            aria-label="MAC address"
            className="w-44 font-mono text-xs"
          />
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label (optional)"
            aria-label="Interface label"
            maxLength={100}
            className="w-36"
          />
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={busy || mac.trim() === ""}
          >
            Add
          </Button>
        </form>
      )}
      {error !== null && (
        <p className="mt-2 text-sm text-destructive">{error}</p>
      )}
    </div>
  );
}

function AssetActions({
  assetId,
  status,
  isAdmin,
  currentHolder,
  locations,
  byId,
  asset,
  onChanged,
}: {
  assetId: string;
  status: AssetDetailResponse["asset"]["status"];
  isAdmin: boolean;
  currentHolder: string | null;
  locations: ReturnType<typeof useLocations>["locations"];
  byId: ReturnType<typeof useLocations>["byId"];
  asset: AssetDetailResponse["asset"];
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<
    "none" | "checkout" | "checkin" | "edit" | "delete"
  >("none");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Check-out form
  const [holderMode, setHolderMode] = useState<"user" | "label">("user");
  const [users, setUsers] = useState<UserOption[]>([]);
  const [holderUserId, setHolderUserId] = useState("");
  const [holderLabel, setHolderLabel] = useState("");
  const [moveLocationId, setMoveLocationId] = useState("");
  const [note, setNote] = useState("");

  // Edit form
  const [form, setForm] = useState<AssetFormValues>({
    name: asset.name,
    assetType: asset.assetType,
    status: asset.status === "deployed" ? "" : asset.status,
    locationId: asset.locationId ?? "",
    model: asset.model ?? "",
    manufacturer: asset.manufacturer ?? "",
    assetTag: asset.assetTag ?? "",
    serialNumber: asset.serialNumber ?? "",
    systemUuid: asset.systemUuid ?? "",
    notes: asset.notes ?? "",
  });

  useEffect(() => {
    if (dialog !== "checkout") return;
    api
      .listUserOptions()
      .then((res) => setUsers(res.items))
      .catch(() => {});
  }, [dialog]);

  function openDialog(next: typeof dialog) {
    setError(null);
    setNote("");
    setMoveLocationId("");
    if (next === "checkout") {
      // Fresh holder every time: a remembered previous holder makes a
      // wrong-holder custody event one accidental click away.
      setHolderMode("user");
      setHolderUserId("");
      setHolderLabel("");
    }
    if (next === "edit") {
      setForm({
        name: asset.name,
        assetType: asset.assetType,
        status: asset.status === "deployed" ? "" : asset.status,
        locationId: asset.locationId ?? "",
        model: asset.model ?? "",
        manufacturer: asset.manufacturer ?? "",
        assetTag: asset.assetTag ?? "",
        serialNumber: asset.serialNumber ?? "",
        systemUuid: asset.systemUuid ?? "",
        notes: asset.notes ?? "",
      });
    }
    setDialog(next);
  }

  function fail(err: unknown, fallback: string) {
    setError(err instanceof ApiError ? err.message : fallback);
  }

  async function submitCheckout(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.checkOutAsset(assetId, {
        ...(holderMode === "user"
          ? { holderUserId }
          : { holderLabel: holderLabel.trim() }),
        ...(moveLocationId === "" ? {} : { locationId: moveLocationId }),
        ...(note.trim() === "" ? {} : { note: note.trim() }),
      });
      setDialog("none");
      onChanged();
    } catch (err) {
      fail(err, "Could not check the asset out.");
    } finally {
      setBusy(false);
    }
  }

  async function submitCheckin(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.checkInAsset(assetId, {
        ...(moveLocationId === "" ? {} : { locationId: moveLocationId }),
        ...(note.trim() === "" ? {} : { note: note.trim() }),
      });
      setDialog("none");
      onChanged();
    } catch (err) {
      fail(err, "Could not check the asset in.");
    } finally {
      setBusy(false);
    }
  }

  async function submitEdit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.updateAsset(assetId, {
        name: form.name.trim(),
        assetType: form.assetType,
        // While deployed, status is custody-owned and not editable here.
        ...(form.status === "" ? {} : { status: form.status }),
        locationId: form.locationId === "" ? null : form.locationId,
        model: toNull(form.model),
        manufacturer: toNull(form.manufacturer),
        assetTag: toNull(form.assetTag),
        serialNumber: toNull(form.serialNumber),
        systemUuid: toNull(form.systemUuid),
        notes: toNull(form.notes),
      });
      setDialog("none");
      onChanged();
    } catch (err) {
      fail(err, "Could not update the asset.");
    } finally {
      setBusy(false);
    }
  }

  async function submitDelete() {
    setBusy(true);
    setError(null);
    try {
      await api.deleteAsset(assetId);
      navigate("/assets");
    } catch (err) {
      fail(err, "Could not delete the asset.");
      setBusy(false);
    }
  }

  const locationField = (
    <div>
      <Label htmlFor="custody-location">Move to location (optional)</Label>
      <Select
        id="custody-location"
        value={moveLocationId}
        onChange={(e) => setMoveLocationId(e.target.value)}
        className="mt-1.5"
      >
        <option value="">Keep current location</option>
        {locations
          .filter((location) => location.isActive)
          .map((location) => (
            <option key={location.id} value={location.id}>
              {locationPath(location, byId)}
            </option>
          ))}
      </Select>
    </div>
  );

  const noteField = (
    <div>
      <Label htmlFor="custody-note">Note (optional)</Label>
      <Textarea
        id="custody-note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        maxLength={2000}
        className="mt-1.5"
      />
    </div>
  );

  return (
    <div className="flex flex-wrap items-center gap-2">
      {status === "in_stock" && (
        <Button onClick={() => openDialog("checkout")}>
          <LogOut className="h-4 w-4" aria-hidden="true" />
          Check out
        </Button>
      )}
      {status === "deployed" && (
        <Button onClick={() => openDialog("checkin")}>
          <LogIn className="h-4 w-4" aria-hidden="true" />
          Check in
        </Button>
      )}
      <Button variant="outline" onClick={() => openDialog("edit")}>
        <Pencil className="h-4 w-4" aria-hidden="true" />
        Edit
      </Button>
      {isAdmin && (
        <Button variant="destructive" onClick={() => openDialog("delete")}>
          <Trash2 className="h-4 w-4" aria-hidden="true" />
          Delete
        </Button>
      )}

      <Dialog
        open={dialog === "checkout"}
        onClose={() => setDialog("none")}
        title="Check out"
        description="Creates a custody event and sets the asset to deployed."
      >
        <form onSubmit={submitCheckout} className="space-y-4">
          <div>
            <Label htmlFor="holder-mode">Holder</Label>
            <Select
              id="holder-mode"
              value={holderMode}
              onChange={(e) =>
                setHolderMode(e.target.value as "user" | "label")
              }
              className="mt-1.5"
            >
              <option value="user">A registered user</option>
              <option value="label">Someone else (free text)</option>
            </Select>
          </div>
          {holderMode === "user" ? (
            <div>
              <Label htmlFor="holder-user">User</Label>
              <Select
                id="holder-user"
                value={holderUserId}
                onChange={(e) => setHolderUserId(e.target.value)}
                required
                className="mt-1.5"
              >
                <option value="" disabled>
                  Select a user...
                </option>
                {users.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.displayName} ({option.email})
                  </option>
                ))}
              </Select>
            </div>
          ) : (
            <div>
              <Label htmlFor="holder-label">Holder name</Label>
              <Input
                id="holder-label"
                value={holderLabel}
                onChange={(e) => setHolderLabel(e.target.value)}
                required
                maxLength={200}
                className="mt-1.5"
              />
            </div>
          )}
          {locationField}
          {noteField}
          {error !== null && (
            <p className="text-sm text-destructive">{error}</p>
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
              disabled={
                busy ||
                (holderMode === "user"
                  ? holderUserId === ""
                  : holderLabel.trim() === "")
              }
            >
              Check out
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={dialog === "checkin"}
        onClose={() => setDialog("none")}
        title="Check in"
        description={`Returns the asset to stock${
          currentHolder === null ? "" : ` from ${currentHolder}`
        }.`}
      >
        <form onSubmit={submitCheckin} className="space-y-4">
          {locationField}
          {noteField}
          {error !== null && (
            <p className="text-sm text-destructive">{error}</p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setDialog("none")}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Check in
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={dialog === "edit"}
        onClose={() => setDialog("none")}
        title="Edit asset"
        className="max-w-2xl"
      >
        <form onSubmit={submitEdit}>
          <AssetFormFields
            values={form}
            onChange={setForm}
            locations={locations}
            byId={byId}
            statusEditable={status !== "deployed"}
          />
          {error !== null && (
            <p className="mt-3 text-sm text-destructive">{error}</p>
          )}
          <div className="mt-5 flex justify-end gap-2">
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
              Save changes
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={dialog === "delete"}
        onClose={() => setDialog("none")}
        title="Delete asset"
        description="Hard delete: interfaces and custody history go with it. The audit log keeps the final snapshot. Prefer retiring assets instead."
      >
        {error !== null && (
          <p className="mb-3 text-sm text-destructive">{error}</p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setDialog("none")}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() => void submitDelete()}
          >
            Delete permanently
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
