// Audit view (admin): paginated read of the append-only log with an
// action filter. The API enforces the admin requirement; this page just
// surfaces the 403 cleanly for anyone who navigates here by URL.
import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type AuditEntry } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { Pagination } from "../components/pagination";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";

const PAGE_SIZE = 50;

export function AuditPage() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [filterInput, setFilterInput] = useState("");
  const [action, setAction] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .listAudit(PAGE_SIZE, offset, action === "" ? undefined : action)
      .then((res) => {
        if (cancelled) return;
        setEntries(res.entries);
        setTotal(res.total);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          err instanceof ApiError && err.status === 403
            ? "The audit log is admin-only."
            : "Could not load the audit log.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [offset, action]);

  function submitFilter(event: FormEvent) {
    event.preventDefault();
    setOffset(0);
    setAction(filterInput.trim());
  }

  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight">Audit log</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Append-only record of every mutating action.
      </p>

      <form
        onSubmit={submitFilter}
        className="mt-6 flex flex-wrap items-center gap-2"
      >
        <Input
          value={filterInput}
          onChange={(e) => setFilterInput(e.target.value)}
          placeholder="Filter by action, e.g. asset.create"
          aria-label="Filter by action"
          className="w-72"
        />
        <Button type="submit" variant="outline">
          Filter
        </Button>
      </form>

      {error !== null && (
        <p className="mt-4 text-sm text-destructive">{error}</p>
      )}

      <div className="mt-4 rounded-xl border border-border bg-card px-4">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Time</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Entity</TableHead>
              <TableHead>Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries === null ? (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground">
                  Loading...
                </TableCell>
              </TableRow>
            ) : entries.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground">
                  No entries match.
                </TableCell>
              </TableRow>
            ) : (
              entries.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {formatDateTime(entry.at)}
                  </TableCell>
                  <TableCell>{entry.actorEmail ?? "system"}</TableCell>
                  <TableCell>
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                      {entry.action}
                    </code>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {entry.entityType ?? ""}
                  </TableCell>
                  <TableCell className="max-w-96">
                    {entry.details !== null && (
                      <details>
                        <summary className="cursor-pointer text-xs text-muted-foreground">
                          view
                        </summary>
                        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">
                          {JSON.stringify(
                            JSON.parse(entry.details),
                            null,
                            2,
                          )}
                        </pre>
                      </details>
                    )}
                  </TableCell>
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
        noun="entries"
      />
    </>
  );
}
