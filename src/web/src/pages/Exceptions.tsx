// Exception review: the human half of the exception-first invariant.
// Each record is a conflict the importer refused to merge; a reviewer
// resolves it (handled by hand) or dismisses it. Decisions are final.
import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import {
  api,
  ApiError,
  type ApiException,
  type ExceptionStatus,
} from "../lib/api";
import { formatDateTime } from "../lib/format";
import { canWrite, useCurrentUser } from "../components/layout";
import { Pagination } from "../components/pagination";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
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

interface ParsedDetails {
  reason?: string;
  identity?: {
    assetTag: string | null;
    serialNumber: string | null;
    systemUuid: string | null;
  };
  matches?: { field: string; value: string; assetId: string; assetName: string }[];
}

function parseDetails(details: string | null): ParsedDetails {
  if (details === null) return {};
  try {
    return JSON.parse(details) as ParsedDetails;
  } catch {
    return {};
  }
}

const REASON_LABELS: Record<string, string> = {
  identity_mismatch: "Identity fields differ",
  would_extend_identity: "Row would add identity fields",
  multiple_assets: "Matches multiple assets",
};

function StatusBadge({ status }: { status: ExceptionStatus }) {
  if (status === "open") return <Badge>Open</Badge>;
  if (status === "resolved") return <Badge variant="secondary">Resolved</Badge>;
  return <Badge variant="muted">Dismissed</Badge>;
}

export function ExceptionsPage() {
  const user = useCurrentUser();
  const writer = canWrite(user);

  const [status, setStatus] = useState<ExceptionStatus | "">("open");
  const [items, setItems] = useState<ApiException[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [nonce, setNonce] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [reviewing, setReviewing] = useState<ApiException | null>(null);
  const [decision, setDecision] = useState<"resolved" | "dismissed">(
    "resolved",
  );
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  useEffect(() => {
    if (!writer) return;
    let cancelled = false;
    setError(null);
    api
      .listExceptions({
        limit: PAGE_SIZE,
        offset,
        status: status === "" ? undefined : status,
      })
      .then((page) => {
        if (cancelled) return;
        // Resolving the last item on a filtered page can empty it; step
        // back instead of stranding the user past the end.
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
          err instanceof ApiError
            ? err.message
            : "Could not load exceptions.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [writer, status, offset, nonce]);

  // The list endpoint itself requires technician or admin, so readonly
  // users get the explanation instead of a raw 403 (the nav also hides
  // this page for them; this covers direct URL entry).
  if (!writer) {
    return (
      <p className="text-sm text-muted-foreground">
        Exception review requires the technician or admin role.
      </p>
    );
  }

  async function submitDecision(event: FormEvent) {
    event.preventDefault();
    if (reviewing === null) return;
    setBusy(true);
    setDialogError(null);
    try {
      await api.resolveException(reviewing.id, decision, note.trim());
      setReviewing(null);
      setNote("");
      setNonce((n) => n + 1);
    } catch (err) {
      setDialogError(
        err instanceof ApiError
          ? err.message
          : "Could not record the decision.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Exceptions</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Identity conflicts held for human review — never auto-merged.
          </p>
        </div>
        <Select
          value={status}
          onChange={(e) => {
            setOffset(0);
            setStatus(e.target.value as ExceptionStatus | "");
          }}
          aria-label="Filter by status"
          className="w-40"
        >
          <option value="open">Open</option>
          <option value="resolved">Resolved</option>
          <option value="dismissed">Dismissed</option>
          <option value="">All</option>
        </Select>
      </div>

      {error !== null && (
        <p className="mt-4 text-sm text-destructive">{error}</p>
      )}

      <div className="mt-6 rounded-xl border border-border bg-card px-4">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Raised</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Conflict</TableHead>
              <TableHead>Row identity</TableHead>
              <TableHead>Existing asset</TableHead>
              <TableHead>Decision</TableHead>
              {writer && <TableHead className="w-24">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {items === null ? (
              <TableRow>
                <TableCell
                  colSpan={writer ? 7 : 6}
                  className="text-muted-foreground"
                >
                  Loading...
                </TableCell>
              </TableRow>
            ) : items.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={writer ? 7 : 6}
                  className="text-muted-foreground"
                >
                  Nothing here — imports are clean.
                </TableCell>
              </TableRow>
            ) : (
              items.map((exception) => {
                const details = parseDetails(exception.details);
                const identity = [
                  details.identity?.assetTag,
                  details.identity?.serialNumber,
                  details.identity?.systemUuid,
                ]
                  .filter(
                    (value): value is string =>
                      value !== null && value !== undefined,
                  )
                  .join(", ");
                return (
                  <TableRow key={exception.id}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDateTime(exception.at)}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={exception.status} />
                    </TableCell>
                    <TableCell className="text-sm">
                      {REASON_LABELS[details.reason ?? ""] ??
                        "Identity collision"}
                    </TableCell>
                    <TableCell className="max-w-56 truncate font-mono text-xs">
                      {identity}
                    </TableCell>
                    <TableCell>
                      {exception.assetId !== null ? (
                        <Link
                          to={`/assets/${exception.assetId}`}
                          className="text-sm underline underline-offset-4"
                        >
                          View asset
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="max-w-56 truncate text-sm text-muted-foreground">
                      {exception.resolutionNote ?? ""}
                    </TableCell>
                    {writer && (
                      <TableCell>
                        {exception.status === "open" && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setDecision("resolved");
                              setNote("");
                              setDialogError(null);
                              setReviewing(exception);
                            }}
                          >
                            Review
                          </Button>
                        )}
                      </TableCell>
                    )}
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
        noun="exceptions"
      />

      <Dialog
        open={reviewing !== null}
        onClose={() => setReviewing(null)}
        title="Review exception"
        description="Decisions are final. Resolving changes nothing else — any asset edits you decide on are separate, audited actions."
      >
        {reviewing !== null && (
          <form onSubmit={submitDecision} className="space-y-4">
            <ExceptionSummary exception={reviewing} />
            <div>
              <Label htmlFor="decision">Decision</Label>
              <Select
                id="decision"
                value={decision}
                onChange={(e) =>
                  setDecision(e.target.value as "resolved" | "dismissed")
                }
                className="mt-1.5"
              >
                <option value="resolved">
                  Resolved — handled by hand
                </option>
                <option value="dismissed">
                  Dismissed — no action needed
                </option>
              </Select>
            </div>
            <div>
              <Label htmlFor="decision-note">Note (optional)</Label>
              <Textarea
                id="decision-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                maxLength={2000}
                className="mt-1.5"
              />
            </div>
            {dialogError !== null && (
              <p className="text-sm text-destructive">{dialogError}</p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setReviewing(null)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                Record decision
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </>
  );
}

function ExceptionSummary({ exception }: { exception: ApiException }) {
  const details = parseDetails(exception.details);
  return (
    <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
      <p className="font-medium">
        {REASON_LABELS[details.reason ?? ""] ?? "Identity collision"}
      </p>
      {details.matches !== undefined && details.matches.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
          {details.matches.map((match, index) => (
            <li key={index}>
              <code className="rounded bg-muted px-1 py-0.5">
                {match.field}
              </code>{" "}
              = {match.value} already belongs to{" "}
              <span className="font-medium text-foreground">
                {match.assetName}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
