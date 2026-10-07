import { useState, type FormEvent } from "react";
import { DOCUMENT_SECTIONS, sectionLabels, type DocumentInput } from "../lib/documents";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";

const blank: DocumentInput = { title: "", reviewDate: "", changeSummary: "Initial revision", sections: { purpose: "", scope: "", prerequisites: "", procedure: "", verification: "", escalation: "" } };
export function DocumentForm({ initial = blank, code, busy, error, onSubmit, onCancel }: { initial?: DocumentInput; code?: string; busy: boolean; error: string | null; onSubmit: (input: DocumentInput, code: string) => Promise<void>; onCancel: () => void }) {
  const [input, setInput] = useState(initial);
  const [newCode, setNewCode] = useState(code ?? "");
  async function submit(event: FormEvent) { event.preventDefault(); await onSubmit(input, newCode); }
  return <form onSubmit={submit} className="space-y-4">
    <div><Label htmlFor="document-code">SOP code</Label><Input id="document-code" value={newCode} disabled={code !== undefined || busy} onChange={(e) => setNewCode(e.target.value)} required pattern="SOP-[A-Z0-9]{2,16}-[0-9]{3,6}" placeholder="SOP-LAB-001" className="mt-1" /><p className="mt-1 text-xs text-muted-foreground">Use SOP-AREA-001. The code stays with every revision.</p></div>
    <div><Label htmlFor="document-title">Title</Label><Input id="document-title" value={input.title} onChange={(e) => setInput({ ...input, title: e.target.value })} required maxLength={200} disabled={busy} className="mt-1" /></div>
    <div><Label htmlFor="document-review-date">Review date</Label><Input id="document-review-date" type="date" value={input.reviewDate} onChange={(e) => setInput({ ...input, reviewDate: e.target.value })} required disabled={busy} className="mt-1" /><p className="mt-1 text-xs text-muted-foreground">Shown as overdue after this date, using UTC.</p></div>
    <p className="text-sm text-muted-foreground">All six sections are required. Enter plain text; put each procedure step on a new line.</p>
    {DOCUMENT_SECTIONS.map((key) => <div key={key}><Label htmlFor={`document-${key}`}>{sectionLabels[key]}</Label><Textarea id={`document-${key}`} value={input.sections[key]} onChange={(e) => setInput({ ...input, sections: { ...input.sections, [key]: e.target.value } })} required maxLength={20000} rows={key === "procedure" ? 6 : 3} disabled={busy} className="mt-1" /></div>)}
    <div><Label htmlFor="document-summary">Change summary</Label><Textarea id="document-summary" value={input.changeSummary} onChange={(e) => setInput({ ...input, changeSummary: e.target.value })} required maxLength={2000} rows={2} disabled={busy} className="mt-1" /></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex gap-2"><Button type="submit" disabled={busy}>{busy ? "Saving..." : code ? "Save new revision" : "Create draft"}</Button><Button type="button" variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button></div>
  </form>;
}
