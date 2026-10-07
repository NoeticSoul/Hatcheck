import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { canWrite, useCurrentUser } from "../components/layout";
import { DocumentForm } from "../components/document-form";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { ApiError } from "../lib/api";
import { documentsApi, type DocumentPage, type DocumentStatus } from "../lib/documents";

export function DocumentsPage() {
  const user = useCurrentUser();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<DocumentStatus | "">("");
  const [stale, setStale] = useState(params.get("overdue") === "true");
  const [published, setPublished] = useState(params.get("published") === "true");
  const [offset, setOffset] = useState(0);
  const [nonce, setNonce] = useState(0);
  const [page, setPage] = useState<DocumentPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPage(null); setError(null);
    documentsApi.list({ limit: 25, offset, q, status: published ? undefined : status || undefined, stale, published })
      .then((result) => { if (!cancelled) setPage(result); })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof ApiError ? err.message : "Could not load documents."); });
    return () => { cancelled = true; };
  }, [offset, q, status, stale, published, nonce]);

  function submitSearch(event: FormEvent) { event.preventDefault(); setOffset(0); setQ(search.trim()); }
  return <>
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div><h1 className="text-xl font-semibold">Documents</h1><p className="mt-1 text-sm text-muted-foreground">Search SOPs and review their approved instructions.</p></div>
      {canWrite(user) && <Button onClick={() => { setFormError(null); setCreating(true); }}>New document</Button>}
    </div>
    <form onSubmit={submitSearch} className="mt-6 flex flex-wrap items-center gap-3">
      <Input aria-label="Search documents" placeholder="Search code, title, or content" value={search} onChange={(e) => setSearch(e.target.value)} maxLength={200} className="w-full sm:w-72" />
      <Button type="submit" variant="outline">Search</Button>
      {canWrite(user) && <><Select aria-label="Document status" disabled={published} value={status} onChange={(e) => { setStatus(e.target.value as DocumentStatus | ""); setOffset(0); }} className="w-40"><option value="">All statuses</option><option value="draft">Draft</option><option value="published">Published</option><option value="archived">Archived</option></Select><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={published} onChange={(e) => { setPublished(e.target.checked); setOffset(0); }} />Approved only</label></>}
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={stale} onChange={(e) => { setStale(e.target.checked); setOffset(0); }} />Overdue for review</label>
    </form>
    {error && <div role="alert" className="mt-4 flex items-center gap-3"><p>{error}</p><Button variant="outline" onClick={() => setNonce((n) => n + 1)}>Retry</Button></div>}
    <div className="mt-6 space-y-3">
      {page === null ? <p className="text-sm text-muted-foreground">{error ? "Documents unavailable." : "Loading..."}</p> : page.items.length === 0 ? <p>No documents match these filters.</p> : page.items.map((item) => <Link key={item.id} to={`/documents/${item.id}${published ? `?revision=${item.visibleRevision}` : ""}`} className="block rounded-xl border border-border bg-card p-4 hover:bg-accent">
        <div className="flex flex-wrap items-center gap-3"><span className="text-xs font-medium">{item.code}</span><span className="text-xs capitalize">{item.status === "published" && item.visibleRevision !== item.publishedRevision ? `Published revision ${item.publishedRevision}; draft revision ${item.visibleRevision}` : item.status}</span>{item.stale && <span className="text-xs font-semibold text-destructive">Overdue for review</span>}</div>
        <h2 className="mt-2 font-semibold">{item.title}</h2><p className="mt-1 text-sm text-muted-foreground">Revision {item.visibleRevision} | Review date: {item.reviewDate}</p>
      </Link>)}
    </div>
    {page && <div className="mt-6 flex flex-wrap items-center gap-3"><span className="text-sm">{page.total} document(s)</span><Button variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 25))}>Previous</Button><Button variant="outline" disabled={offset + page.items.length >= page.total} onClick={() => setOffset(offset + 25)}>Next</Button></div>}
    <Dialog open={creating} onClose={() => { if (!busy) setCreating(false); }} title="New structured SOP" className="max-w-3xl">
      {creating && <DocumentForm busy={busy} error={formError} onCancel={() => setCreating(false)} onSubmit={async (input, code) => {
        setBusy(true); setFormError(null);
        try { const result = await documentsApi.create(code, input); navigate(`/documents/${result.document.id}`); }
        catch (err) { setFormError(err instanceof ApiError ? err.message : "Could not create document."); }
        finally { setBusy(false); }
      }} />}
    </Dialog>
  </>;
}
