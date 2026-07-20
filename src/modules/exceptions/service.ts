// Domain logic for exception review. Exceptions are the product's
// exception-first invariant made visible: conflicting device identities
// are never force-merged, they land here for a human decision. Routes stay
// thin; the only rule — a decision is final, so only OPEN exceptions can
// be resolved or dismissed — lives here.
import type {
  ExceptionRecord,
  ExceptionStatus,
  Store,
} from "../../db/store";
import { fail, type LocationFailure } from "../locations/service";

export type ResolveExceptionResult =
  | { ok: true; before: ExceptionRecord; exception: ExceptionRecord }
  | LocationFailure<404 | 409>;

export async function resolveException(
  store: Store,
  id: string,
  input: {
    status: "resolved" | "dismissed";
    note?: string;
    resolvedByUserId: string;
  },
): Promise<ResolveExceptionResult> {
  const existing = await store.getExceptionById(id);
  if (existing === null) {
    return fail(404, "not_found", "Exception not found");
  }
  if (existing.status !== "open") {
    return fail(
      409,
      "not_open",
      `Exception is already ${existing.status}; decisions are final`,
    );
  }
  const note = input.note?.trim();
  // The pre-check above is only the friendly fast path; the store's
  // UPDATE carries its own status = 'open' guard, so a concurrent resolve
  // landing between the read and this write cannot be overwritten.
  const updated = await store.resolveException(id, {
    status: input.status,
    resolvedByUserId: input.resolvedByUserId,
    resolutionNote: note === undefined || note === "" ? null : note,
  });
  if (updated === null) {
    const now = await store.getExceptionById(id);
    if (now === null) {
      return fail(404, "not_found", "Exception not found");
    }
    return fail(
      409,
      "not_open",
      `Exception is already ${now.status}; decisions are final`,
    );
  }
  return { ok: true, before: existing, exception: updated };
}

export async function listExceptions(
  store: Store,
  input: { limit: number; offset: number; status?: ExceptionStatus },
): Promise<{ items: ExceptionRecord[]; total: number }> {
  const items = await store.listExceptions(input);
  // Same filter, so total stays consistent with the page contents.
  const total = await store.countExceptions(input.status);
  return { items, total };
}
