# CLAUDE.md — Hatcheck

Hatcheck is an open-source, self-hosted IT management platform (assets,
locations, imaging pipeline, knowledge base, doc studio) for small IT teams.
CHARTER.md is the authoritative source for scope, architecture, and roadmap.
If a request conflicts with the charter, say so before implementing.

## Current phase

Gate 0 / Phase 0 — foundation. Do not build ahead of the current phase's
gate criteria. Update this line as phases close.

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
4. **Exception-first correlation.** Connector sync never force-merges
   conflicting device identities. Conflicts become exception records for
   human review. This is an architectural invariant, not a preference.
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
