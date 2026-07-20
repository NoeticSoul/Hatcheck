# CLAUDE.md — Hatcheck

Hatcheck is an open-source, self-hosted IT management platform (assets,
locations, imaging pipeline, knowledge base, doc studio) for small IT teams.
CHARTER.md is the authoritative source for scope, architecture, and roadmap.
If a request conflicts with the charter, say so before implementing.

## Current phase

Phase 2 — Doc Studio + Knowledge Base. Phase 1 gate is CLOSED: all four
criteria are verified by automated tests and by green CI on both database
engines. Do not build ahead of Phase 2 gate criteria. Update this section
as phases close.

### Phase 1 gate record (closed)

1. 500 synthetic assets imported via CSV in one run with a per-row result
   report — src/server/imports.test.ts gate suite, including an
   idempotent re-run that creates nothing at the same scale.
2. Every mutating action on assets, locations, and assignments writes an
   audit record with actor, timestamp, and before/after state — asserted
   across the API suites, including assets persisted by an import run
   that aborts mid-way (fault-injection test in
   src/modules/imports/service.test.ts).
3. The check-out -> check-in round trip preserves complete custody
   history — API gate test in src/server/custody.test.ts plus a
   Playwright flow through the real UI (tests/e2e/assets.spec.ts).
4. CI green on both PostgreSQL and SQLite, including the import and
   custody-history suites (dual-engine matrix in .github/workflows).

Phase 1 shipped: assets/locations/custody/import/exceptions APIs with
OpenAPI, the web UI over them, audit views, and basic CSV export of a
filtered asset list.

Maintainer decision (2026-07-20): the standalone compile target
(scripts/compile.ts, `bun run compile`, CI artifacts) is pulled forward
from Phase 3 as an UNSIGNED TEST BUILD so Phase 1 can be exercised on
real machines. This does not open Phase 3: the release pipeline —
published SHA256SUMS, attestations, code signing, clean-machine
verification — remains Phase 3 scope and its gate is untouched.

### Phase 2 scope (from CHARTER.md section: Phase 2)

Structured authoring (enforced sections, flags, change history, naming),
Markdown/HTML/docx export, KB rendering and search, review-date tracking.
Everything lands API-first, as before: schema and migration -> endpoints
with tests and OpenAPI -> UI.

### Phase 2 gate criteria (work is not done until all pass)

1. A real SOP authored end-to-end in the tool.
2. An exported docx passes a manual standards checklist.
3. The stale-doc flag fires on a back-dated article.

### Standing Phase 1 domain rules (shipped code; still binding)

- **Custody is an append-only event stream.** Check-out and check-in create
  custody events; current holder is derived state, never a mutable field
  that erases history. This is the product's core metaphor — the ticket
  stub. Treat it with the same rigor as the audit log.
- **Asset identity is multi-key.** Serial number, asset tag, system UUID,
  and MAC address are distinct attributes; none is assumed globally unique
  or universally present. MAC addresses are per-interface and can repeat
  across records (docks); never use MAC as a primary matching key.
- **CSV import never force-merges.** Rows that collide with existing assets
  on identity fields become exception records for human review, per the
  exception-first invariant. Import must be idempotent: re-running the same
  file creates no duplicates.
- **Import has a dry-run mode.** Preview with per-row validation results
  before commit. Partial failures do not abort the whole import; failed
  rows are reported with reasons.
- **Locations are a hierarchy** (site -> building -> room), modeled so
  homelab users can use a single flat level without ceremony.
- **Lifecycle states, not hard deletes.** Assets move through states (e.g.,
  in-stock, deployed, in-repair, retired). Retirement is a state change
  plus audit entry; hard deletion is admin-only and still audit-logged.
- **Search is server-side and paginated** from the start; no
  load-everything-then-filter UI patterns, even at seed-data scale.

### Explicitly NOT in Phase 2 (defer, even if adjacent)

Imaging pipeline and standalone binary builds (Phase 3), connectors of any
kind including AD/LDAP (Phase 4), reporting/saved views/XLSX export and
scoped API keys (Phase 4), AI features (Phase 3+, adapter stays a stub).
If a Phase 2 task seems to need one of these, stop and flag it.

## Stack (do not substitute without discussion)

- Runtime: Bun (keep Node compatibility; no Bun-only APIs in core logic
  without a documented reason)
- API: Hono, with OpenAPI spec generated from route definitions
- Frontend: React + Vite + Tailwind + shadcn/ui
- ORM: Drizzle
- Databases: PostgreSQL (server mode) AND SQLite (standalone mode)
- Tests: Vitest (unit/integration), Playwright (e2e)
- License: Apache-2.0

## Hard rules

1. **Dual-DB portability.** Every schema change and query must work on both
   PostgreSQL and SQLite. No PG-only features (JSONB operators,
   LISTEN/NOTIFY, ILIKE-dependent logic, PG-specific types) in core paths.
   If a feature genuinely needs one engine, flag it for discussion first.
2. **Never fabricate APIs.** Do not invent package names, functions,
   endpoints, or config options. If unsure a library API exists, check
   node_modules types or the package docs, or say you are unsure.
3. **API-first.** New functionality lands as a documented, tested REST
   endpoint before any UI is built on it. Keep the OpenAPI spec in sync in
   the same PR.
4. **Exception-first correlation.** Nothing force-merges conflicting device
   identities — not imports, not future connectors. Conflicts become
   exception records for human review. This is an architectural invariant,
   not a preference.
5. **Security invariants.** RBAC checks live at the API layer, never only in
   the UI. Every mutating action and every AI call writes an audit record.
   No secrets in code, config files, fixtures, or tests — environment
   variables only.
6. **Synthetic data only.** Never add real organization names, hostnames,
   MAC addresses, usernames, or network details to seeds, fixtures, tests,
   or docs. Seed data is invented.
7. **AI features are optional.** Anything touching the AI adapter must
   degrade cleanly when no provider is configured. Off by default.

## Code style

- TypeScript strict mode; no `any` without an inline justification comment
- ASCII characters only in source files; straight quotes, never curly;
  UTF-8 encoding
- Small modules over god files; colocate tests next to source
- Conventional commit messages (feat:, fix:, chore:, docs:, test:)

## Workflow expectations

- For any multi-file change, present a plan before editing
- Tests accompany features in the same commit; do not mark work complete
  with failing or skipped tests
- Run the test suite before declaring a task done; report actual results,
  not assumed ones
- CI must pass against both database engines
- When asked to double-check work, treat it as a real verification pass:
  re-derive from source, run the code, and report specific defects found or
  explicitly confirm none

## Repository layout (target)

- `src/server/` — Hono app, routes, middleware
- `src/db/` — Drizzle schema, migrations, seed
- `src/modules/<name>/` — feature modules (assets, locations, docs,
  pipeline, connectors, admin)
- `src/web/` — React app
- `src/ai/` — provider-agnostic adapter (stub until Phase 3+)
- `tests/` — e2e; unit tests colocated in src
- `scripts/` — build, release, compile targets
- `CHARTER.md`, `CLAUDE.md`, `LICENSE`, `NOTICE`, `SECURITY.md`,
  `CONTRIBUTING.md` at root

## Out of scope (do not build, even if asked casually)

Ticketing/helpdesk engine, remote control/RMM, MDM functionality, billing or
procurement, cloud/IaC discovery. These are integration targets or
permanent non-goals per CHARTER.md section 4.