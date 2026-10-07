import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Download } from "lucide-react";
import { api, ApiError, type ApiImportJob, type ApiImportRow } from "../lib/api";
import { canWrite, useCurrentUser } from "../components/layout";
import { formatDateTime } from "../lib/format";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Pagination } from "../components/pagination";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { CountsLine, OutcomeBadge } from "./Import";

const PAGE_SIZE = 50;
// Protect the report when it is opened by spreadsheet software.
function csvCell(value: string | number | null): string {
  const raw = String(value ?? "");
  const text = /^[\s]*[=+@-]/.test(raw) ? `'${raw}` : raw;
  return `"${text.replace(/"/g, '""')}"`;
}

export function ImportDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const writer = canWrite(useCurrentUser());
  const initialRow = Number(params.get("row") ?? 1);
  const [offset, setOffset] = useState(Number.isInteger(initialRow) && initialRow > 0 ? Math.floor((initialRow - 1) / PAGE_SIZE) * PAGE_SIZE : 0);
  const [job, setJob] = useState<ApiImportJob | null>(null);
  const [rows, setRows] = useState<ApiImportRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [nonce, setNonce] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  useEffect(() => {
    setJob(null);
    setOffset(Number.isInteger(initialRow) && initialRow > 0 ? Math.floor((initialRow - 1) / PAGE_SIZE) * PAGE_SIZE : 0);
    setDownloadError(null);
  }, [id, initialRow]);

  useEffect(() => {
    if (!writer || !id) return;
    let cancelled = false;
    setError(null); setRows(null);
    Promise.all([api.getImport(id), api.listImportRows(id, PAGE_SIZE, offset)]).then(([detail, page]) => {
      if (cancelled) return;
      if (offset >= page.total && offset > 0) { setOffset(0); return; }
      setJob(detail.job); setRows(page.items); setTotal(page.total);
    }).catch((err: unknown) => { if (!cancelled) setError(err instanceof ApiError ? err.message : "Could not load the import report."); });
    return () => { cancelled = true; };
  }, [writer, id, offset, nonce]);

  async function download() {
    if (!id || !job || job.id !== id || job.status === "running" || downloading) return;
    setDownloading(true); setDownloadError(null);
    try {
      const lines = ["row,outcome,message,asset_id,source_row"];
      for (let start = 0; ; start += 200) {
        const page = await api.listImportRows(id, 200, start);
        lines.push(...page.items.map((row) => [row.rowNumber, row.outcome, row.message, row.assetId, row.raw].map(csvCell).join(",")));
        if (start + page.items.length >= page.total || page.items.length === 0) break;
      }
      const url = URL.createObjectURL(new Blob([lines.join("\r\n") + "\r\n"], { type: "text/csv;charset=utf-8" }));
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = `import-${job.id}-outcomes.csv`; anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) { setDownloadError(err instanceof ApiError ? err.message : "Could not download the report. Please try again."); }
    finally { setDownloading(false); }
  }

  if (!writer) return <p>Import reports require the technician or admin role.</p>;
  return <><Link to="/import" className="text-sm underline">Back to imports</Link><div className="mt-4 flex flex-wrap items-center justify-between gap-4"><div><h1 className="text-xl font-semibold tracking-tight">Import report</h1><p className="mt-1 break-all text-sm text-muted-foreground">{job?.filename ?? "Saved CSV import"}</p></div><Button variant="outline" onClick={() => void download()} disabled={!job || job.id !== id || job.status === "running" || downloading}><Download className="h-4 w-4" aria-hidden="true" />{downloading ? "Downloading..." : "Download outcomes CSV"}</Button></div>
    {job && <div className="mt-4 space-y-2 rounded-xl border border-border bg-card p-4"><div className="flex flex-wrap items-center gap-2"><Badge variant={job.mode === "commit" ? "default" : "muted"}>{job.mode === "commit" ? "Commit" : "Dry run"}</Badge><span className="text-sm">{job.status} - {formatDateTime(job.at)} - {job.actorEmail ?? "system"}</span></div>{job.status === "running" ? <div><p className="text-sm">This job has no completion record. It may still be processing or may have been interrupted. Saved rows show progress; outcomes are not final.</p><CountsLine job={job} /><Button variant="outline" size="sm" className="mt-2" onClick={() => setNonce((n) => n + 1)}>Refresh report</Button></div> : <CountsLine job={job} />}{job.status === "failed" && <p className="text-sm">This run failed. The report contains only the outcomes recorded before it stopped.</p>}{job.mode === "dry_run" && <p className="text-xs text-muted-foreground">This is a preview. No assets or exceptions were created.</p>}<p className="break-all font-mono text-xs text-muted-foreground">SHA-256: {job.fileHash}</p>{job.collisionCount > 0 && job.mode === "commit" && <Link to="/exceptions" className="block text-sm underline">Review identity exceptions</Link>}</div>}
    {error && <div role="alert" className="mt-4 flex flex-wrap items-center gap-2"><p className="text-sm text-destructive">{error}</p><Button variant="outline" size="sm" onClick={() => setNonce((n) => n + 1)}>Retry report</Button></div>}
    {downloadError && <p role="alert" className="mt-4 text-sm text-destructive">{downloadError}</p>}
    <div className="mt-6 rounded-xl border border-border bg-card px-4"><Table><TableHeader><TableRow><TableHead>Row</TableHead><TableHead>Outcome</TableHead><TableHead>Message / source</TableHead><TableHead>Asset</TableHead></TableRow></TableHeader><TableBody>
      {rows === null ? <TableRow><TableCell colSpan={4}>{error ? "Report unavailable." : "Loading..."}</TableCell></TableRow> : rows.length === 0 ? <TableRow><TableCell colSpan={4}>No rows recorded.</TableCell></TableRow> : rows.map((row) => <TableRow key={row.id} id={`row-${row.rowNumber}`} className={row.rowNumber === initialRow && params.has("row") ? "bg-muted" : undefined}><TableCell>{row.rowNumber}</TableCell><TableCell><OutcomeBadge outcome={row.outcome} /></TableCell><TableCell className="max-w-xl"><p className="whitespace-pre-wrap text-sm">{row.message ?? ""}</p>{row.raw && <details className="mt-1"><summary className="cursor-pointer text-xs text-muted-foreground">Source row</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs">{row.raw}</pre></details>}</TableCell><TableCell>{row.assetId && <Link to={`/assets/${row.assetId}`} className="text-sm underline">View asset</Link>}</TableCell></TableRow>)}
    </TableBody></Table></div><Pagination total={total} limit={PAGE_SIZE} offset={offset} onPage={setOffset} noun="rows" />
  </>;
}
