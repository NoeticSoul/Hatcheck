// Assets list: server-side search, filters, and pagination from the start
// (Phase 1 domain rule — no load-everything-then-filter). Write controls
// are hidden for readonly users; the API enforces RBAC regardless.
import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
} from "react";
import { Link, useNavigate } from "react-router-dom";
import { Download, Plus, Search } from "lucide-react";
import {
  api,
  ApiError,
  type ApiAssetListItem,
  type ApiLocation,
  type AssetStatus,
  type AssetType,
} from "../lib/api";
import { locationPath, STATUS_LABELS, TYPE_LABELS } from "../lib/format";
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

const PAGE_SIZE = 25;

export function StatusBadge({ status }: { status: AssetStatus }) {
  const variant =
    status === "deployed"
      ? ("default" as const)
      : status === "in_stock"
        ? ("secondary" as const)
        : status === "in_repair"
          ? ("outline" as const)
          : ("muted" as const);
  return <Badge variant={variant}>{STATUS_LABELS[status]}</Badge>;
}

/**
 * All locations for pickers and name lookups; hierarchy scale is small.
 * Inactive locations are included on purpose: assets may still reference
 * them, and hiding them would blank those lookups and silently drop
 * locationId from edit forms.
 */
export function useLocations(): {
  locations: ApiLocation[];
  byId: Map<string, ApiLocation>;
  reload: () => void;
} {
  const [locations, setLocations] = useState<ApiLocation[]>([]);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Page through the server list; the 200-per-request cap is the
      // API's, not a UI guess.
      const all: ApiLocation[] = [];
      for (let offset = 0; ; offset += 200) {
        const page = await api.listLocations({
          limit: 200,
          offset,
          includeInactive: true,
        });
        all.push(...page.items);
        if (all.length >= page.total || page.items.length === 0) break;
      }
      if (!cancelled) setLocations(all);
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  return {
    locations,
    byId: new Map(locations.map((l) => [l.id, l])),
    reload: useCallback(() => setNonce((n) => n + 1), []),
  };
}

export interface AssetFormValues {
  name: string;
  assetType: AssetType;
  status: Exclude<AssetStatus, "deployed"> | "";
  locationId: string;
  model: string;
  manufacturer: string;
  assetTag: string;
  serialNumber: string;
  systemUuid: string;
  notes: string;
}

const EMPTY_FORM: AssetFormValues = {
  name: "",
  assetType: "device",
  status: "in_stock",
  locationId: "",
  model: "",
  manufacturer: "",
  assetTag: "",
  serialNumber: "",
  systemUuid: "",
  notes: "",
};

export function AssetFormFields({
  values,
  onChange,
  locations,
  byId,
  statusEditable,
}: {
  values: AssetFormValues;
  onChange: (values: AssetFormValues) => void;
  locations: ApiLocation[];
  byId: Map<string, ApiLocation>;
  statusEditable: boolean;
}) {
  const set = <K extends keyof AssetFormValues>(
    key: K,
    value: AssetFormValues[K],
  ) => onChange({ ...values, [key]: value });

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <Label htmlFor="asset-name">Name</Label>
        <Input
          id="asset-name"
          value={values.name}
          onChange={(e) => set("name", e.target.value)}
          required
          maxLength={200}
          className="mt-1.5"
        />
      </div>
      <div>
        <Label htmlFor="asset-type">Type</Label>
        <Select
          id="asset-type"
          value={values.assetType}
          onChange={(e) => set("assetType", e.target.value as AssetType)}
          className="mt-1.5"
        >
          {Object.entries(TYPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor="asset-status">Status</Label>
        {statusEditable ? (
          <Select
            id="asset-status"
            value={values.status}
            onChange={(e) =>
              set("status", e.target.value as AssetFormValues["status"])
            }
            className="mt-1.5"
          >
            <option value="in_stock">In stock</option>
            <option value="in_repair">In repair</option>
            <option value="retired">Retired</option>
          </Select>
        ) : (
          <p className="mt-2.5 text-sm text-muted-foreground">
            Deployed — status changes via check-in.
          </p>
        )}
      </div>
      <div className="sm:col-span-2">
        <Label htmlFor="asset-location">Location</Label>
        <Select
          id="asset-location"
          value={values.locationId}
          onChange={(e) => set("locationId", e.target.value)}
          className="mt-1.5"
        >
          <option value="">No location</option>
          {locations
            // Offer active locations, plus the current (possibly
            // inactive) one so editing never silently drops it.
            .filter(
              (location) =>
                location.isActive || location.id === values.locationId,
            )
            .map((location) => (
              <option key={location.id} value={location.id}>
                {locationPath(location, byId)}
                {location.isActive ? "" : " (inactive)"}
              </option>
            ))}
        </Select>
      </div>
      <div>
        <Label htmlFor="asset-model">Model</Label>
        <Input
          id="asset-model"
          value={values.model}
          onChange={(e) => set("model", e.target.value)}
          maxLength={200}
          className="mt-1.5"
        />
      </div>
      <div>
        <Label htmlFor="asset-manufacturer">Manufacturer</Label>
        <Input
          id="asset-manufacturer"
          value={values.manufacturer}
          onChange={(e) => set("manufacturer", e.target.value)}
          maxLength={200}
          className="mt-1.5"
        />
      </div>
      <div>
        <Label htmlFor="asset-tag">Asset tag</Label>
        <Input
          id="asset-tag"
          value={values.assetTag}
          onChange={(e) => set("assetTag", e.target.value)}
          maxLength={200}
          className="mt-1.5"
        />
      </div>
      <div>
        <Label htmlFor="asset-serial">Serial number</Label>
        <Input
          id="asset-serial"
          value={values.serialNumber}
          onChange={(e) => set("serialNumber", e.target.value)}
          maxLength={200}
          className="mt-1.5"
        />
      </div>
      <div className="sm:col-span-2">
        <Label htmlFor="asset-uuid">System UUID</Label>
        <Input
          id="asset-uuid"
          value={values.systemUuid}
          onChange={(e) => set("systemUuid", e.target.value)}
          maxLength={200}
          className="mt-1.5"
        />
      </div>
      <div className="sm:col-span-2">
        <Label htmlFor="asset-notes">Notes</Label>
        <Textarea
          id="asset-notes"
          value={values.notes}
          onChange={(e) => set("notes", e.target.value)}
          maxLength={5000}
          rows={3}
          className="mt-1.5"
        />
      </div>
    </div>
  );
}

/** Maps "" to null so cleared inputs clear the field server-side. */
export function toNull(value: string): string | null {
  const v = value.trim();
  return v === "" ? null : v;
}

export function AssetsPage() {
  const user = useCurrentUser();
  const navigate = useNavigate();
  const { locations, byId } = useLocations();

  const [items, setItems] = useState<ApiAssetListItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<AssetStatus | "">("");
  const [assetType, setAssetType] = useState<AssetType | "">("");
  const [error, setError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<AssetFormValues>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .listAssets({
        limit: PAGE_SIZE,
        offset,
        q: q === "" ? undefined : q,
        status: status === "" ? undefined : status,
        assetType: assetType === "" ? undefined : assetType,
      })
      .then((page) => {
        if (cancelled) return;
        setItems(page.items);
        setTotal(page.total);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          err instanceof ApiError ? err.message : "Could not load assets.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [offset, q, status, assetType]);

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    setOffset(0);
    setQ(search.trim());
  }

  async function submitCreate(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      const { asset } = await api.createAsset({
        name: form.name.trim(),
        assetType: form.assetType,
        status: form.status === "" ? undefined : form.status,
        locationId: form.locationId === "" ? null : form.locationId,
        model: toNull(form.model),
        manufacturer: toNull(form.manufacturer),
        assetTag: toNull(form.assetTag),
        serialNumber: toNull(form.serialNumber),
        systemUuid: toNull(form.systemUuid),
        notes: toNull(form.notes),
      });
      navigate(`/assets/${asset.id}`);
    } catch (err) {
      setFormError(
        err instanceof ApiError ? err.message : "Could not create the asset.",
      );
      setSaving(false);
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Assets</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Inventory with live custody state.
          </p>
        </div>
        {canWrite(user) && (
          <Button
            onClick={() => {
              setForm(EMPTY_FORM);
              setFormError(null);
              setCreateOpen(true);
            }}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            New asset
          </Button>
        )}
      </div>

      <form
        onSubmit={submitSearch}
        className="mt-6 flex flex-wrap items-center gap-2"
      >
        <div className="relative min-w-56 flex-1">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, model, tag, serial..."
            aria-label="Search assets"
            className="pl-8"
          />
        </div>
        <Select
          value={status}
          onChange={(e) => {
            setOffset(0);
            setStatus(e.target.value as AssetStatus | "");
          }}
          aria-label="Filter by status"
          className="w-40"
        >
          <option value="">All statuses</option>
          {Object.entries(STATUS_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
        <Select
          value={assetType}
          onChange={(e) => {
            setOffset(0);
            setAssetType(e.target.value as AssetType | "");
          }}
          aria-label="Filter by type"
          className="w-40"
        >
          <option value="">All types</option>
          {Object.entries(TYPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="outline">
          Search
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            // Server-generated CSV of the CURRENT committed filters; the
            // attachment disposition keeps the SPA in place.
            const params = new URLSearchParams();
            if (q !== "") params.set("q", q);
            if (status !== "") params.set("status", status);
            if (assetType !== "") params.set("assetType", assetType);
            const qs = params.toString();
            window.location.assign(
              `/api/v1/assets/export${qs === "" ? "" : `?${qs}`}`,
            );
          }}
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          Export CSV
        </Button>
      </form>

      {error !== null && (
        <p className="mt-4 text-sm text-destructive">{error}</p>
      )}

      <div className="mt-4 rounded-xl border border-border bg-card px-4">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Holder</TableHead>
              <TableHead>Location</TableHead>
              <TableHead>Serial</TableHead>
              <TableHead>Tag</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items === null ? (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground">
                  Loading...
                </TableCell>
              </TableRow>
            ) : items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground">
                  No assets match.
                </TableCell>
              </TableRow>
            ) : (
              items.map((asset) => {
                const location =
                  asset.locationId === null
                    ? undefined
                    : byId.get(asset.locationId);
                return (
                  <TableRow key={asset.id}>
                    <TableCell>
                      <Link
                        to={`/assets/${asset.id}`}
                        className="font-medium text-foreground underline-offset-4 hover:underline"
                      >
                        {asset.name}
                      </Link>
                    </TableCell>
                    <TableCell>{TYPE_LABELS[asset.assetType]}</TableCell>
                    <TableCell>
                      <StatusBadge status={asset.status} />
                    </TableCell>
                    <TableCell>
                      {asset.currentCustody?.holderName ?? (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {location === undefined ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        locationPath(location, byId)
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {asset.serialNumber ?? ""}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {asset.assetTag ?? ""}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <Pagination
        total={total}
        limit={PAGE_SIZE}
        offset={offset}
        onPage={setOffset}
        noun="assets"
      />

      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New asset"
        description="Deployed status always comes from a check-out, never from this form."
        className="max-w-2xl"
      >
        <form onSubmit={submitCreate}>
          <AssetFormFields
            values={form}
            onChange={setForm}
            locations={locations}
            byId={byId}
            statusEditable
          />
          {formError !== null && (
            <p className="mt-3 text-sm text-destructive">{formError}</p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setCreateOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving || form.name.trim() === ""}>
              Create asset
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
