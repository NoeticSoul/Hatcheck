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

  listAudit(limit: number, offset = 0): Promise<AuditListResponse> {
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
    });
    return request<AuditListResponse>(`/api/v1/audit?${params.toString()}`);
  },
};
