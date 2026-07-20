// CSV import: dry-run first is the designed flow — the preview runs the
// identical pipeline server-side and persists the report, but creates no
// assets or exceptions. Collisions never merge; they become exception
// records linked from the result rows.
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { FileUp, Play, Upload } from "lucide-react";
import {
  api,
  ApiError,
  type ApiImportJob,
  type ImportRowOutcome,
  type ImportRunResponse,
} from "../lib/api";
import { formatDateTime } from "../lib/format";
import { canWrite, useCurrentUser } from "../components/layout";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";

const COLUMNS_HINT =
  "name (required), asset_type, status, location or location_id, model, " +
  "manufacturer, notes, asset_tag, serial_number, system_uuid, " +
  "mac_addresses. Every row needs at least one identity field.";

function OutcomeBadge({ outcome }: { outcome: ImportRowOutcome }) {
  switch (outcome) {
    case "created":
      return <Badge>Created</Badge>;
    case "skipped_duplicate":
      return <Badge variant="secondary">Skipped</Badge>;
    case "collision":
      return <Badge variant="outline">Collision</Badge>;
    case "error":
      return <Badge variant="destructive">Error</Badge>;
  }
}

function CountsLine({ job }: { job: ApiImportJob }) {
  return (
    <p className="text-sm text-muted-foreground">
      {job.totalRows} rows: {job.createdCount} created, {job.skippedCount}{" "}
      skipped, {job.collisionCount} collisions, {job.errorCount} errors
    </p>
  );
}

export function ImportPage() {
  const user = useCurrentUser();
  const writer = canWrite(user);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [csv, setCsv] = useState("");
  const [filename, setFilename] = useState("");
  const [busy, setBusy] = useState<"none" | "dry_run" | "commit">("none");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportRunResponse | null>(null);

  const [recent, setRecent] = useState<ApiImportJob[] | null>(null);
  const [recentNonce, setRecentNonce] = useState(0);

  useEffect(() => {
    if (!writer) return;
    let cancelled = false;
    api
      .listImports(10)
      .then((page) => {
        if (!cancelled) setRecent(page.items);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [writer, recentNonce]);

  async function loadFile(file: File) {
    setCsv(await file.text());
    // The API caps filename at 200 chars; a longer picked name must not
    // poison the whole request.
    setFilename(file.name.slice(0, 200));
    setResult(null);
    setError(null);
  }

  async function run(mode: "dry_run" | "commit") {
    setBusy(mode);
    setError(null);
    try {
      const res = await api.runImport(csv, mode, filename.trim() || undefined);
      setResult(res);
      setRecentNonce((n) => n + 1);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Import request failed.",
      );
    } finally {
      setBusy("none");
    }
  }

  if (!writer) {
    return (
      <p className="text-sm text-muted-foreground">
        CSV import requires the technician or admin role.
      </p>
    );
  }

  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight">CSV import</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Preview with a dry run, then commit. Conflicting identities become
        exception records — nothing is ever force-merged.
      </p>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-sm">File</CardTitle>
            <CardDescription>Columns: {COLUMNS_HINT}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file !== undefined) void loadFile(file);
                  // Allow re-selecting the same file after edits.
                  e.target.value = "";
                }}
              />
              <Button
                variant="outline"
                onClick={() => fileRef.current?.click()}
              >
                <FileUp className="h-4 w-4" aria-hidden="true" />
                Choose CSV file
              </Button>
              <Input
                value={filename}
                onChange={(e) => setFilename(e.target.value)}
                placeholder="Filename (optional)"
                aria-label="Filename"
                maxLength={200}
                className="w-56"
              />
            </div>
            <div className="mt-4">
              <Label htmlFor="csv-text">CSV content</Label>
              <Textarea
                id="csv-text"
                value={csv}
                onChange={(e) => {
                  setCsv(e.target.value);
                  setResult(null);
                }}
                rows={10}
                placeholder={"name,serial_number\nLoaner Laptop 01,SN-0001"}
                className="mt-1.5 font-mono text-xs"
              />
            </div>
            {error !== null && (
              <p className="mt-3 text-sm text-destructive">{error}</p>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={busy !== "none" || csv.trim() === ""}
                onClick={() => void run("dry_run")}
              >
                <Play className="h-4 w-4" aria-hidden="true" />
                {busy === "dry_run" ? "Previewing..." : "Preview (dry run)"}
              </Button>
              <Button
                disabled={busy !== "none" || csv.trim() === ""}
                onClick={() => void run("commit")}
              >
                <Upload className="h-4 w-4" aria-hidden="true" />
                {busy === "commit" ? "Importing..." : "Commit import"}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Recent imports</CardTitle>
            <CardDescription>Newest first</CardDescription>
          </CardHeader>
          <CardContent>
            {recent === null ? (
              <p className="text-sm text-muted-foreground">Loading...</p>
            ) : recent.length === 0 ? (
              <p className="text-sm text-muted-foreground">No imports yet.</p>
            ) : (
              <ul className="space-y-3">
                {recent.map((job) => (
                  <li key={job.id} className="text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">
                        {job.filename ?? "(unnamed)"}
                      </span>
                      <Badge
                        variant={
                          job.mode === "commit" ? "default" : "muted"
                        }
                      >
                        {job.mode === "commit" ? "Commit" : "Dry run"}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {formatDateTime(job.at)}
                    </p>
                    <CountsLine job={job} />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {result !== null && (
          <Card className="lg:col-span-3" data-testid="import-result">
            <CardHeader>
              <CardTitle className="text-sm">
                {result.job.mode === "commit"
                  ? "Import result"
                  : "Dry-run preview"}
              </CardTitle>
              <CardDescription>
                <CountsLine job={result.job} />
                {result.priorImport !== null && (
                  <span className="mt-1 block text-xs">
                    This exact file was already committed on{" "}
                    {formatDateTime(result.priorImport.at)} — matching rows
                    are skipped, never duplicated.
                  </span>
                )}
                {result.job.collisionCount > 0 &&
                  result.job.mode === "commit" && (
                    <span className="mt-1 block text-xs">
                      Collisions are waiting for human review in{" "}
                      <Link to="/exceptions" className="underline">
                        Exceptions
                      </Link>
                      .
                    </span>
                  )}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-16">Row</TableHead>
                    <TableHead className="w-28">Outcome</TableHead>
                    <TableHead>Message</TableHead>
                    <TableHead className="w-24">Asset</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {/* Rendering thousands of rows freezes the tab; the
                      full report stays queryable via the imports API. */}
                  {result.rows.slice(0, 1000).map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="text-muted-foreground">
                        {row.rowNumber}
                      </TableCell>
                      <TableCell>
                        <OutcomeBadge outcome={row.outcome} />
                      </TableCell>
                      <TableCell className="text-sm">
                        {row.message ?? ""}
                      </TableCell>
                      <TableCell>
                        {row.assetId !== null && (
                          <Link
                            to={`/assets/${row.assetId}`}
                            className="text-sm underline underline-offset-4"
                          >
                            View
                          </Link>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {result.rows.length > 1000 && (
                <p className="mt-3 text-sm text-muted-foreground">
                  Showing the first 1000 of {result.rows.length} rows; the
                  complete report is stored with the import job.
                </p>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
