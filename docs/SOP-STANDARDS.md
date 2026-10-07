# SOP authoring and publication standards

Doc Studio and the knowledge base use one structured document model. Each
saved version is an immutable revision with a full content snapshot, author
ID and email, creation timestamp, review date, and change summary. Saving
and the matching audit entry commit together. There is no revision update
or deletion endpoint.

## Author a document

1. Open Documents and select New document. Admins and technicians can author.
2. Assign a unique code such as `SOP-LAB-001`. The enforced format is
   `SOP-AREA-NNN`: 2-16 uppercase letters or digits for the area, followed by
   3-6 digits. The code never changes between revisions.
3. Give the procedure an actionable title and a valid calendar review date.
   A document becomes overdue after its review date, evaluated in UTC. A
   review date of today is due today and becomes overdue tomorrow.
4. Fill every required section with plain text:

   | Section | Required content |
   | --- | --- |
   | Purpose | The outcome and why this procedure exists. |
   | Scope | Which systems, situations, and exclusions apply. |
   | Prerequisites | Access, approvals, tools, inputs, and safe starting conditions. |
   | Procedure | Ordered, actionable steps, including stop conditions. |
   | Verification | Observable evidence that the outcome was achieved. |
   | Escalation | What to retain and who should review an unsuccessful or unsafe result. |

5. Record a change summary and create the draft. Text is trimmed and empty
   sections are rejected. Unsupported XML control characters are rejected
   so office exports remain valid.
6. An administrator reviews the exact latest revision and selects Publish
   revision. Publication is an explicit approval action and is audit logged.

Read-only accounts can search, render, and export only a document's current
approved revision. They cannot discover unapproved content through search,
revision history, direct revision URLs, or exports. Saving a new draft of a
published document leaves the last approved revision available until an
administrator approves the new revision.

The dashboard's overdue-document link searches approved snapshots for every
role. Writers can also select Approved only in Documents. This keeps an
overdue approved procedure visible while a replacement draft awaits approval.

## Revision and retention behavior

Revision history is paginated and records the original actor and change
summary. Authoring and approval requests carry `expectedRevision`; a stale
editor receives HTTP 409 instead of overwriting another author's work. The
editor must reload and reconcile the intervening changes.

To restore older content, open that revision from history and select Restore
as new revision. Review the copied content and review date, then save a new
draft with an explicit restore change summary. The API supports the same
operation by appending the copied content with the current `expectedRevision`.
The previous revisions remain intact. Historical exports always select an
explicit immutable revision number.

An administrator can archive a document. Archiving hides it from read-only
accounts and preserves every revision for staff review and export. Archived
documents cannot be edited or republished. Retention is deliberate: there
is no document deletion or unarchive endpoint in this workflow.

## Rendering and exports

The KB renders text through React text nodes. User content is never evaluated
as HTML, images, or links. HTML export escapes text and sends an attachment
with a restrictive Content Security Policy. Markdown export puts authored
content in literal fenced blocks, including malicious-looking markup. DOCX
export writes text runs, fixed section headings, and revision metadata.

All three formats export a selected authorized revision. Repeated export of
the same revision produces identical output; DOCX core properties use the
revision timestamp and ZIP entry dates are fixed rather than using download
time. Names identify both the SOP code and revision, for example
`SOP-LAB-001-r1.docx`.

## Manual DOCX standards checklist

Automated checks inspect the generated ZIP, document XML, core metadata,
required sections, literal content, revision identifiers, dates, and repeat
export determinism. A human must also open an actual exported DOCX in the
office application used by the team. Automated XML checks do not complete
this manual presentation gate.

- [ ] Record SOP code, revision, export filename, office application/version,
      reviewer, and review date.
- [ ] The file opens with no repair, corruption, compatibility, or security
      prompt attributable to the export.
- [ ] The title and SOP code match the selected revision in Hatcheck.
- [ ] Revision number, review date, and author identity are present and correct.
- [ ] Purpose, Scope, Prerequisites, Procedure, Verification, and Escalation
      appear in that order with clear headings.
- [ ] Procedure steps preserve line breaks, order, punctuation, and any
      intentional whitespace; long lines wrap within the page margins.
- [ ] Page breaks and headings remain readable for a multi-page procedure.
- [ ] The change summary is visible and describes this revision.
- [ ] Symbols and Unicode in a representative document display correctly.
- [ ] Text that resembles HTML or a dangerous link displays as literal text;
      the export introduces no external links, scripts, macros, or images.
- [ ] A reader can follow the procedure and its verification and escalation
      paths without relying on knowledge absent from the SOP.

Record any manual deviations before calling the Phase 2 gate closed. A
synthetic lab SOP authored end to end is suitable development evidence; the
production adoption gate still requires the team's real reviewed procedure.

## Verification evidence

`src/server/documents.test.ts` covers required-section and naming validation,
back-dated review flags, server search and pagination, RBAC, publication
isolation, concurrent edits, archive retention, restore-by-new-revision,
audit failure rollback, safe rendering/export, deterministic DOCX structure,
and generated OpenAPI endpoints. The shared test-store fixture runs these
tests on SQLite or PostgreSQL, selected with `HATCHECK_TEST_DB`.

`tests/e2e/documents.spec.ts` exercises browser authoring, publishing,
revision history, exports, and the overdue flag with a synthetic operational
SOP. No real organization details or credentials belong in fixtures.

On 2026-10-06, the exported recovery SOP (revision 1) opened and rendered in
LibreOfficeDev 26.8.0.0.alpha0. Visual inspection confirmed its title, code,
revision, author, review date, all six headings in order, readable wrapped
procedure steps, and change summary. A supplementary four-page export
confirmed page wrapping, literal HTML/link-like text, Greek/accented/CJK text,
and an emoji; ZIP inspection found no macros or external relationships.
This is development rendering evidence. The human checklist above remains
open for the office application used by the team; Phase 2 is not declared
closed on the strength of this evidence alone.
