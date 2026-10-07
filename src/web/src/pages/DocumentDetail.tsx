import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { canWrite, useCurrentUser } from "../components/layout";
import { DocumentForm } from "../components/document-form";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import { ApiError } from "../lib/api";
import { DOCUMENT_SECTIONS, documentsApi, sectionLabels, type DocumentDetail, type DocumentRevision } from "../lib/documents";

export function DocumentDetailPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const selected = params.get("revision");
  const revision = selected === null ? undefined : Number(selected);
  const user = useCurrentUser();
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [history, setHistory] = useState<{ items: DocumentRevision[]; total: number } | null>(null);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [nonce, setNonce] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"edit" | "publish" | "archive" | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false; setDetail(null); setError(null); setDialog(null);
    documentsApi.get(id, revision).then((result) => { if (!cancelled) setDetail(result); })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof ApiError ? err.message : "Could not load document."); });
    return () => { cancelled = true; };
  }, [id, revision, nonce]);
  useEffect(() => {
    let cancelled = false; setHistory(null); setHistoryError(null);
    documentsApi.history(id, historyOffset).then((result) => { if (!cancelled) setHistory(result); })
      .catch((err: unknown) => { if (!cancelled) setHistoryError(err instanceof ApiError ? err.message : "Could not load revision history."); });
    return () => { cancelled = true; };
  }, [id, historyOffset, nonce]);

  function open(kind: "edit" | "publish" | "archive") { setFormError(null); setDialog(kind); }
  function saved() { setDialog(null); setParams({}); setHistoryOffset(0); setNonce((n) => n + 1); }
  async function transition(action: "publish" | "archive") {
    if (!detail || busy) return;
    setBusy(true); setFormError(null);
    try { await documentsApi.transition(id, detail.document.latestRevision, action); saved(); }
    catch (err) { setFormError(err instanceof ApiError ? err.message : "Could not update document."); }
    finally { setBusy(false); }
  }

  return <>
    <Link to="/documents" className="text-sm text-muted-foreground hover:underline">Back to documents</Link>
    {error && <div role="alert" className="mt-4 flex items-center gap-3"><p>{error}</p><Button variant="outline" onClick={() => setNonce((n) => n + 1)}>Retry</Button></div>}
    {!detail ? <p className="mt-6">{error ? "Document unavailable." : "Loading..."}</p> : <>
      <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div><p className="text-sm font-medium">{detail.document.code} | <span className="capitalize">{detail.document.status}</span></p><h1 className="mt-1 text-2xl font-semibold">{detail.revision.title}</h1><p className="mt-2 text-sm text-muted-foreground">Revision {detail.revision.revision} | Review date: {detail.revision.reviewDate}</p>{detail.stale && <p role="status" className="mt-2 font-semibold text-destructive">Overdue for review</p>}</div>
        <div className="flex flex-wrap gap-2">
          {canWrite(user) && detail.document.status !== "archived" && <Button onClick={() => open("edit")}>{detail.revision.revision === detail.document.latestRevision ? "Edit document" : "Restore as new revision"}</Button>}
          {user.role === "admin" && detail.document.status !== "archived" && <><Button variant="outline" onClick={() => open("publish")} disabled={detail.revision.revision !== detail.document.latestRevision || detail.document.publishedRevision === detail.document.latestRevision}>Publish revision</Button><Button variant="outline" onClick={() => open("archive")}>Archive</Button></>}
        </div>
      </div>
      {canWrite(user) && detail.document.status === "published" && detail.document.publishedRevision !== detail.document.latestRevision && <p className="mt-4 rounded-md border border-border p-3 text-sm">Revision {detail.document.publishedRevision} remains visible to readers until an administrator publishes revision {detail.document.latestRevision}.</p>}
      {detail.revision.revision !== detail.document.latestRevision && canWrite(user) && <p className="mt-4 text-sm">Viewing a historical revision. <Link to={`/documents/${id}`} className="underline">View latest revision</Link></p>}
      <div aria-label="Export selected revision" className="mt-4 flex flex-wrap gap-4 text-sm">{(["md", "html", "docx"] as const).map((format) => <a key={format} href={documentsApi.exportUrl(id, detail.revision.revision, format)} download className="underline">Export {format === "md" ? "Markdown" : format.toUpperCase()}</a>)}</div>
      <article className="mt-6 rounded-xl border border-border bg-card p-5 sm:p-8">
        {DOCUMENT_SECTIONS.map((key) => <section key={key} className="mb-6 last:mb-0"><h2 className="mb-2 border-b border-border pb-2 text-lg font-semibold">{sectionLabels[key]}</h2><p className="whitespace-pre-wrap break-words text-sm leading-6">{detail.revision.sections[key]}</p></section>)}
      </article>
      <p className="mt-4 text-sm text-muted-foreground">Author: {detail.revision.actorEmail} | {new Date(detail.revision.createdAt).toISOString()}<br />Change summary: {detail.revision.changeSummary}</p>
      <section className="mt-8"><h2 className="text-lg font-semibold">Revision history</h2>
        {historyError && <div role="alert" className="mt-2 flex items-center gap-3"><p>{historyError}</p><Button variant="outline" onClick={() => setNonce((n) => n + 1)}>Retry history</Button></div>}
        {history ? <><ul className="mt-3 space-y-3">{history.items.map((item) => <li key={item.revision} className="rounded-md border border-border p-3"><Link to={`/documents/${id}?revision=${item.revision}`} className="font-medium underline">Revision {item.revision}</Link>{item.revision === detail.document.publishedRevision && <span className="ml-2 text-xs">Published</span>}<p className="mt-1 whitespace-pre-wrap break-words text-sm">{item.changeSummary}</p><p className="mt-1 text-xs text-muted-foreground">{item.actorEmail} | {new Date(item.createdAt).toISOString()}</p></li>)}</ul><div className="mt-3 flex gap-2"><Button variant="outline" disabled={historyOffset === 0} onClick={() => setHistoryOffset(Math.max(0, historyOffset - 25))}>Previous revisions</Button><Button variant="outline" disabled={historyOffset + history.items.length >= history.total} onClick={() => setHistoryOffset(historyOffset + 25)}>Next revisions</Button></div></> : <p className="mt-3 text-sm">{historyError ? "History unavailable." : "Loading history..."}</p>}
      </section>
      <Dialog open={dialog !== null} onClose={() => { if (!busy) setDialog(null); }} title={dialog === "edit" ? (detail.revision.revision === detail.document.latestRevision ? "Edit document" : "Restore historical content") : dialog === "publish" ? "Publish revision" : "Archive document"} className={dialog === "edit" ? "max-w-3xl" : undefined}>
        {dialog === "edit" ? <><p className="mb-4 text-sm text-muted-foreground">{detail.revision.revision === detail.document.latestRevision ? "Saving creates a new immutable revision." : `Copy revision ${detail.revision.revision} into a new draft after revision ${detail.document.latestRevision}. Review the content and review date before saving. The published revision stays available until an administrator approves the new draft.`}</p><DocumentForm code={detail.document.code} initial={{ title: detail.revision.title, reviewDate: detail.revision.reviewDate, sections: detail.revision.sections, changeSummary: detail.revision.revision === detail.document.latestRevision ? "" : `Restore revision ${detail.revision.revision} content` }} busy={busy} error={formError} onCancel={() => setDialog(null)} onSubmit={async (input) => {
          setBusy(true); setFormError(null);
          try { await documentsApi.revise(id, detail.document.latestRevision, input); saved(); }
          catch (err) { setFormError(err instanceof ApiError ? err.message : "Could not save revision."); }
          finally { setBusy(false); }
        }} /></> : <div className="space-y-4"><p className="text-sm">{dialog === "publish" ? `Make revision ${detail.document.latestRevision} available to all readers?` : "Archive this document? Readers will no longer see it in the knowledge base. Staff retain its complete history."}</p>{formError && <p role="alert" className="text-destructive">{formError}</p>}<div className="flex gap-2"><Button disabled={busy} onClick={() => void transition(dialog === "publish" ? "publish" : "archive")}>{busy ? "Saving..." : dialog === "publish" ? "Confirm publish" : "Confirm archive"}</Button><Button variant="outline" disabled={busy} onClick={() => setDialog(null)}>Cancel</Button></div></div>}
      </Dialog>
    </>}
  </>;
}
