// Tiny typed client for the Hatcheck REST API (/api/v1). The UI is just
// another API client (charter principle 3); every call here maps 1:1 to a
// documented endpoint. All requests send the session cookie.

export type Role = "admin" | "technician" | "readonly";
export type AuthSource = "local" | "oidc";

/** Sanitized user shape returned by the API. Never contains passwordHash. */
export interface ApiUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  authSource: AuthSource;
  isActive: boolean;
  createdAt: number;
}

export interface HealthResponse {
  status: "ok";
  version: string;
  db: "sqlite" | "postgres";
  oidcEnabled: boolean;
  aiEnabled: boolean;
}

export interface AiStatusResponse {
  enabled: boolean;
  provider: string | null;
}

export interface AuditEntry {
  id: string;
  at: number;
  actorUserId: string | null;
  actorEmail: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  details: string | null;
  ip: string | null;
}

export interface AuditListResponse {
  entries: AuditEntry[];
  total: number;
}

// ---- Phase 1: Assets & Locations ------------------------------------------

export type LocationKind = "site" | "building" | "room";

export interface ApiLocation {
  id: string;
  name: string;
  kind: LocationKind;
  parentId: string | null;
  description: string | null;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}

export type AssetType = "device" | "peripheral" | "license";
export type AssetStatus = "in_stock" | "deployed" | "in_repair" | "retired";

export interface ApiAsset {
  id: string;
  name: string;
  assetType: AssetType;
  status: AssetStatus;
  locationId: string | null;
  model: string | null;
  manufacturer: string | null;
  notes: string | null;
  assetTag: string | null;
  serialNumber: string | null;
  systemUuid: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ApiAssetInterface {
  id: string;
  assetId: string;
  mac: string;
  label: string | null;
  createdAt: number;
}

export interface ApiCustodyEvent {
  id: string;
  assetId: string;
  at: number;
  type: "check_out" | "check_in";
  holderUserId: string | null;
  holderName: string | null;
  locationId: string | null;
  locationName: string | null;
  note: string | null;
  actorUserId: string | null;
  actorEmail: string | null;
}

export interface ApiAssetListItem extends ApiAsset {
  currentCustody: ApiCustodyEvent | null;
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface AssetDetailResponse {
  asset: ApiAsset;
  interfaces: ApiAssetInterface[];
  currentCustody: ApiCustodyEvent | null;
  location: ApiLocation | null;
}

export interface AssetListQuery {
  limit: number;
  offset: number;
  q?: string;
  status?: AssetStatus;
  assetType?: AssetType;
  locationId?: string;
}

export interface AssetInput {
  name?: string;
  assetType?: AssetType;
  status?: AssetStatus;
  locationId?: string | null;
  model?: string | null;
  manufacturer?: string | null;
  notes?: string | null;
  assetTag?: string | null;
  serialNumber?: string | null;
  systemUuid?: string | null;
}

export interface UserOption {
  id: string;
  displayName: string;
  email: string;
}

// ---- Phase 1: CSV import & exceptions -------------------------------------

export type ImportMode = "dry_run" | "commit";

export interface ApiImportJob {
  id: string;
  at: number;
  actorUserId: string | null;
  actorEmail: string | null;
  filename: string | null;
  fileHash: string;
  mode: ImportMode;
  status: "running" | "completed" | "failed";
  totalRows: number;
  createdCount: number;
  skippedCount: number;
  collisionCount: number;
  errorCount: number;
}

export type ImportRowOutcome =
  | "created"
  | "skipped_duplicate"
  | "collision"
  | "error";

export interface ApiImportRow {
  id: string;
  jobId: string;
  rowNumber: number;
  outcome: ImportRowOutcome;
  message: string | null;
  assetId: string | null;
  raw: string | null;
}

export interface ImportRunResponse {
  job: ApiImportJob;
  rows: ApiImportRow[];
  priorImport: ApiImportJob | null;
}

export type ExceptionStatus = "open" | "resolved" | "dismissed";

export interface ApiException {
  id: string;
  at: number;
  kind: "import_identity_collision";
  status: ExceptionStatus;
  assetId: string | null;
  importRowId: string | null;
  details: string | null;
  resolvedByUserId: string | null;
  resolvedAt: number | null;
  resolutionNote: string | null;
}

interface ErrorBody {
  error: { code: string; message: string };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function request<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(path, {
    method: init.method ?? "GET",
    credentials: "same-origin",
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });

  if (res.status === 204) {
    return undefined as T;
  }

  if (!res.ok) {
    let code = "unknown";
    let message = `Request failed with status ${res.status}`;
    try {
      const body = (await res.json()) as Partial<ErrorBody>;
      if (body.error && typeof body.error.message === "string") {
        code = body.error.code;
        message = body.error.message;
      }
    } catch {
      // Non-JSON error body; keep the generic message.
    }
    throw new ApiError(res.status, code, message);
  }

  return (await res.json()) as T;
}

export const api = {
  health(): Promise<HealthResponse> {
    return request<HealthResponse>("/api/v1/health");
  },

  login(email: string, password: string): Promise<{ user: ApiUser }> {
    return request<{ user: ApiUser }>("/api/v1/auth/login", {
      method: "POST",
      body: { email, password },
    });
  },

  logout(): Promise<void> {
    return request<void>("/api/v1/auth/logout", { method: "POST" });
  },

  me(): Promise<{ user: ApiUser }> {
    return request<{ user: ApiUser }>("/api/v1/auth/me");
  },

  aiStatus(): Promise<AiStatusResponse> {
    return request<AiStatusResponse>("/api/v1/ai/status");
  },

  listAudit(
    limit: number,
    offset = 0,
    action?: string,
  ): Promise<AuditListResponse> {
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
    });
    if (action !== undefined && action !== "") params.set("action", action);
    return request<AuditListResponse>(`/api/v1/audit?${params.toString()}`);
  },

  // ---- Phase 1: Assets & Locations ----------------------------------------

  listLocations(query: {
    limit: number;
    offset: number;
    includeInactive?: boolean;
  }): Promise<Page<ApiLocation>> {
    const params = new URLSearchParams({
      limit: String(query.limit),
      offset: String(query.offset),
    });
    if (query.includeInactive) params.set("includeInactive", "true");
    return request<Page<ApiLocation>>(
      `/api/v1/locations?${params.toString()}`,
    );
  },

  createLocation(input: {
    name: string;
    kind?: LocationKind;
    parentId?: string | null;
    description?: string | null;
  }): Promise<{ location: ApiLocation }> {
    return request<{ location: ApiLocation }>("/api/v1/locations", {
      method: "POST",
      body: input,
    });
  },

  updateLocation(
    id: string,
    patch: {
      name?: string;
      kind?: LocationKind;
      parentId?: string | null;
      description?: string | null;
      isActive?: boolean;
    },
  ): Promise<{ location: ApiLocation }> {
    return request<{ location: ApiLocation }>(`/api/v1/locations/${id}`, {
      method: "PATCH",
      body: patch,
    });
  },

  deleteLocation(id: string): Promise<void> {
    return request<void>(`/api/v1/locations/${id}`, { method: "DELETE" });
  },

  listAssets(query: AssetListQuery): Promise<Page<ApiAssetListItem>> {
    const params = new URLSearchParams({
      limit: String(query.limit),
      offset: String(query.offset),
    });
    if (query.q !== undefined && query.q !== "") params.set("q", query.q);
    if (query.status !== undefined) params.set("status", query.status);
    if (query.assetType !== undefined) {
      params.set("assetType", query.assetType);
    }
    if (query.locationId !== undefined) {
      params.set("locationId", query.locationId);
    }
    return request<Page<ApiAssetListItem>>(
      `/api/v1/assets?${params.toString()}`,
    );
  },

  getAsset(id: string): Promise<AssetDetailResponse> {
    return request<AssetDetailResponse>(`/api/v1/assets/${id}`);
  },

  createAsset(
    input: AssetInput & { name: string },
  ): Promise<{ asset: ApiAsset; interfaces: ApiAssetInterface[] }> {
    return request<{ asset: ApiAsset; interfaces: ApiAssetInterface[] }>(
      "/api/v1/assets",
      { method: "POST", body: input },
    );
  },

  updateAsset(id: string, patch: AssetInput): Promise<{ asset: ApiAsset }> {
    return request<{ asset: ApiAsset }>(`/api/v1/assets/${id}`, {
      method: "PATCH",
      body: patch,
    });
  },

  deleteAsset(id: string): Promise<void> {
    return request<void>(`/api/v1/assets/${id}`, { method: "DELETE" });
  },

  addAssetInterface(
    assetId: string,
    input: { mac: string; label?: string | null },
  ): Promise<{ interface: ApiAssetInterface }> {
    return request<{ interface: ApiAssetInterface }>(
      `/api/v1/assets/${assetId}/interfaces`,
      { method: "POST", body: input },
    );
  },

  deleteAssetInterface(assetId: string, interfaceId: string): Promise<void> {
    return request<void>(
      `/api/v1/assets/${assetId}/interfaces/${interfaceId}`,
      { method: "DELETE" },
    );
  },

  checkOutAsset(
    assetId: string,
    input: {
      holderUserId?: string;
      holderLabel?: string;
      locationId?: string;
      note?: string;
    },
  ): Promise<{ event: ApiCustodyEvent; asset: ApiAsset }> {
    return request<{ event: ApiCustodyEvent; asset: ApiAsset }>(
      `/api/v1/assets/${assetId}/checkout`,
      { method: "POST", body: input },
    );
  },

  checkInAsset(
    assetId: string,
    input: { locationId?: string; note?: string },
  ): Promise<{ event: ApiCustodyEvent; asset: ApiAsset }> {
    return request<{ event: ApiCustodyEvent; asset: ApiAsset }>(
      `/api/v1/assets/${assetId}/checkin`,
      { method: "POST", body: input },
    );
  },

  listCustody(
    assetId: string,
    limit: number,
    offset = 0,
  ): Promise<Page<ApiCustodyEvent>> {
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
    });
    return request<Page<ApiCustodyEvent>>(
      `/api/v1/assets/${assetId}/custody?${params.toString()}`,
    );
  },

  listUserOptions(): Promise<{ items: UserOption[] }> {
    return request<{ items: UserOption[] }>("/api/v1/users/options");
  },

  // ---- Phase 1: CSV import & exceptions -----------------------------------

  runImport(
    csv: string,
    mode: ImportMode,
    filename?: string,
  ): Promise<ImportRunResponse> {
    const params = new URLSearchParams({ mode });
    if (filename !== undefined && filename !== "") {
      params.set("filename", filename);
    }
    // Raw text/csv body; the shared JSON helper does not fit this call.
    return (async () => {
      const res = await fetch(
        `/api/v1/imports/assets?${params.toString()}`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            Accept: "application/json",
            "Content-Type": "text/csv",
          },
          body: csv,
        },
      );
      if (!res.ok) {
        let code = "unknown";
        let message = `Request failed with status ${res.status}`;
        try {
          const body = (await res.json()) as Partial<ErrorBody>;
          if (body.error && typeof body.error.message === "string") {
            code = body.error.code;
            message = body.error.message;
          }
        } catch {
          // Non-JSON error body; keep the generic message.
        }
        throw new ApiError(res.status, code, message);
      }
      return (await res.json()) as ImportRunResponse;
    })();
  },

  listImports(limit: number, offset = 0): Promise<Page<ApiImportJob>> {
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
    });
    return request<Page<ApiImportJob>>(
      `/api/v1/imports?${params.toString()}`,
    );
  },

  listImportRows(
    jobId: string,
    limit: number,
    offset = 0,
  ): Promise<Page<ApiImportRow>> {
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
    });
    return request<Page<ApiImportRow>>(
      `/api/v1/imports/${jobId}/rows?${params.toString()}`,
    );
  },

  listExceptions(query: {
    limit: number;
    offset: number;
    status?: ExceptionStatus;
  }): Promise<Page<ApiException>> {
    const params = new URLSearchParams({
      limit: String(query.limit),
      offset: String(query.offset),
    });
    if (query.status !== undefined) params.set("status", query.status);
    return request<Page<ApiException>>(
      `/api/v1/exceptions?${params.toString()}`,
    );
  },

  resolveException(
    id: string,
    status: "resolved" | "dismissed",
    note?: string,
  ): Promise<{ exception: ApiException }> {
    return request<{ exception: ApiException }>(
      `/api/v1/exceptions/${id}/resolve`,
      {
        method: "POST",
        body: note === undefined || note === "" ? { status } : { status, note },
      },
    );
  },
};
