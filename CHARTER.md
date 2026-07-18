# Hatcheck — Project Charter

| Field | Value |
| --- | --- |
| Project name | Hatcheck (provisional — pending trademark search and domain/org checks) |
| Version | Draft v0.2 |
| Date | 07/15/2026 |
| Author | Damien Clark |
| Status | Pre-Gate 0 (IP clearance not yet complete) |
| License | Apache-2.0 |

Hatcheck: an open-source, self-hosted IT management platform for small IT
teams. A hatcheck room takes custody of what you hand it, gives you a numbered
ticket, and returns it on demand -- which is asset check-in/check-out,
recordkeeping, and accountability in a single image. That is the product.

---

## 1. Vision

Give IT technicians and managers one modern, self-hosted platform for the
operational core of an IT department: assets, locations, imaging and
deployment tracking, knowledge base, and standards-enforced documentation --
with clean exports for leadership and an API for everything. Deployable by a
university department, a small business, or a homelab, from the same codebase.

## 2. Market context (verified July 2026)

- The all-in-one open-source options (GLPI, iTop) are feature-dense but carry
  dated UIs, steep learning curves, and heavy setup. GLPI 11 (2026) improved
  the UI but the complexity remains.
- The modern-feeling options (Snipe-IT, Shelf.nu, Zammad) each do one thing:
  assets only, tracking only, or tickets only. None handle imaging workflows
  or documentation authoring.
- No incumbent treats deployment/imaging pipelines, standards-enforced
  documentation, or AI/MCP integration as first-class features.

Hatcheck's position: the operational depth of GLPI's asset core, the UI bar
of Shelf.nu/Zammad, plus two modules nobody ships (imaging pipeline, doc
studio), built API-first with an optional AI layer.

## 3. Product principles

1. **Modern UI is a requirement, not a preference.** If a screen would look
   at home in 2010-era enterprise software, it is a bug.
2. **Exception-first data honesty.** Conflicting device identities are never
   force-merged; conflicts surface for human review. (Design philosophy
   carried over from prior work; no external code is imported.)
3. **API-first.** Every feature is a documented REST endpoint before it is a
   screen. The UI is just another API client.
4. **AI-optional, never AI-dependent.** All AI features are off by default,
   provider-agnostic (bring your own key, local models supported), and fully
   audited. The platform is complete without them.
5. **Same codebase, three audiences.** University department, company IT
   team, homelab -- differences are configuration, not forks.
6. **Integrate, don't rebuild.** Ticketing (TeamDynamix, Jira, Zammad, etc.)
   and MDM (Jamf, Intune) are integration targets, not modules.

## 4. Scope

### Modules (in scope)

| Module | Summary |
| --- | --- |
| Assets & Locations | Device/peripheral/license records, buildings/rooms, user assignment, check-in/check-out ("the ticket stub"), lifecycle states, audit trail |
| Doc Studio | Guided SOP/KB authoring with structurally enforced standards: required sections, escalation flags, change history, naming conventions; export to Markdown/HTML/docx/PDF |
| Knowledge Base | Searchable rendered library of Doc Studio output plus imported articles, with review-date tracking and stale-doc flagging |
| Imaging Pipeline | Per-device deployment state board (e.g., BIOS -> directory join -> network registration -> endpoint mgmt import -> app install), configurable stages, evidence attachments |
| Connectors | Pluggable read-only collectors: CSV import first; then AD/LDAP, SCCM AdminService, Jamf API, Intune Graph; ticketing links (TDX/Jira) |
| Reporting & Exports | Saved views, CSV/XLSX export, scoped read-only API keys for other departments and leadership |
| Admin & Audit | RBAC, OIDC + local auth, append-only audit log, instance settings |

### Non-goals (out of scope)

- A ticketing/helpdesk engine (integrate instead)
- Remote control / RMM agent functionality
- Acting as an MDM (Jamf/Intune remain the MDM; Hatcheck reads from them)
- Billing, procurement approvals, ERP territory
- Cloud/IaC resource discovery (Terraform state, cloud APIs)

## 5. Architecture

### Stack

| Layer | Choice | Rationale |
| --- | --- | --- |
| Language | TypeScript end-to-end | One language, strongest AI-assisted-development ecosystem |
| Runtime | Bun (Node-compatible) | Enables single-file executable distribution via `bun build --compile`; fast dev loop |
| API framework | Hono | Lightweight, runs on Bun and Node, first-class OpenAPI tooling |
| Frontend | React + Vite + Tailwind + shadcn/ui | Modern UI velocity; accessible component baseline |
| ORM | Drizzle | First-class support for BOTH PostgreSQL and SQLite (dual-DB is a hard requirement, see below) |
| Database | PostgreSQL (server mode) / SQLite (standalone mode) | See distribution shapes |
| Docs export | Existing Node docx/pptx generation patterns | Proven approach for Word/PowerPoint output |

**Hard constraint:** core schema and queries must remain portable across
PostgreSQL and SQLite from day one. No PG-only features (e.g., advanced JSONB
operators, LISTEN/NOTIFY) in core paths. Retrofitting dual-DB support later
is a rewrite; enforcing it from Phase 0 is a lint rule.

### Distribution shapes

1. **Server mode (canonical for organizations):** Docker Compose (app +
   PostgreSQL). Target: fresh machine to logged-in dashboard in under 10
   minutes using only the README.
2. **Standalone mode (homelab / evaluation / solo tech):** a single
   self-contained executable per platform, built with
   `bun build --compile --target=...` for at minimum: windows-x64,
   darwin-arm64, darwin-x64, linux-x64. Embedded SQLite database, launches
   the web UI at localhost on start. Expected binary size 50-100 MB
   (includes runtime). This is a self-contained server you double-click, not
   a native desktop GUI app.

Cross-compilation for all targets runs from a single CI job (verified: Bun
supports cross-target compilation, including Windows metadata such as icon,
publisher, and version stamping).

## 6. Security baseline (Phase 0, non-negotiable)

- OIDC (covers Entra ID, Okta, Keycloak, Authentik, Google) plus local
  accounts with Argon2id hashing
- RBAC enforced at the API layer (admin / technician / read-only minimum)
- Append-only audit log for all mutating actions and all AI calls
- Rate limiting on auth and API endpoints
- Secrets via environment variables only; no secrets in config files or DB
- Dependency scanning in CI (Dependabot + audit step); lockfile committed
- SECURITY.md with a responsible-disclosure policy from the first public
  commit
- Signed, immutable release tags

## 7. API and AI layer

- **API:** REST with an OpenAPI 3 spec generated from route definitions;
  scoped API keys (read-only export keys for non-IT stakeholders); versioned
  from v1.
- **AI adapter:** a single internal interface with pluggable providers
  (Anthropic, OpenAI, local via Ollama). Off by default. Every call writes an
  audit record (feature, provider, data scope). First shipped features
  (Phase 3+): Doc Studio drafting assistant, natural-language asset queries.
- **MCP server:** ships alongside the app so any AI assistant can query
  assets, check pipeline state, or draft documents under the calling user's
  permissions. Differentiator no incumbent offers.

## 8. Release integrity and supply chain

- All release artifacts built in CI (GitHub Actions), never on a developer
  machine.
- A `SHA256SUMS` file published with every release; README documents
  verification (`sha256sum -c` / `Get-FileHash` on Windows /
  `shasum -a 256` on macOS).
- GitHub artifact attestations enabled so provenance is verifiable with
  `gh attestation verify`.
- Honest signing status documented in the README:
  - Unsigned Windows binaries trigger SmartScreen warnings; unsigned macOS
    binaries are blocked by Gatekeeper until right-click > Open. Hash
    verification proves integrity but does not remove these warnings.
  - Roadmap items: Apple Developer ID signing + notarization (USD 99/year)
    and a Windows code-signing route (verify current Azure Trusted Signing
    eligibility and pricing at the time); target once the project has users.

## 9. License

Apache-2.0 (decided 07/15/2026). Rationale: maximizes adoption, is
university- and enterprise-friendly, and includes an explicit patent grant.
Accepted trade-off: permits closed-source and hosted forks without
contribution back. Formalize by adding LICENSE and NOTICE files at Gate 0.

## 10. Roadmap and gates

### Gate 0 — IP and naming clearance (blocks everything)

- [ ] Review employer IP policy for personal open-source work; obtain
      written clarity if any ambiguity remains
- [ ] Confirm the project is developed on personal time and hardware, with
      synthetic data only
- [ ] USPTO trademark search for "Hatcheck" in software classes; check
      GitHub org, npm scope, and domain availability
- [ ] Choose license; add LICENSE, SECURITY.md, CONTRIBUTING.md

### Phase 0 — Foundation

Repo scaffold (Bun + Hono + React + Drizzle), OIDC + local auth, RBAC, audit
log, OpenAPI skeleton, AI adapter stub, dual-DB CI matrix (Postgres +
SQLite), Docker Compose, seed script with synthetic data, tests (Vitest +
Playwright), dependency scanning.
**Gate:** fresh machine to logged-in dashboard in under 10 minutes via
README, in both server and dev modes; CI green on both databases.

### Phase 1 — Assets & Locations

Asset CRUD, locations, assignment, check-in/check-out with full history, CSV
import, search, audit views.
**Gate:** 500 synthetic assets imported via CSV; every mutation visible in
the audit log; check-out/check-in round-trip preserves history.

### Phase 2 — Doc Studio + Knowledge Base

Structured authoring (enforced sections, flags, change history, naming),
Markdown/HTML/docx export, KB rendering and search, review-date tracking.
**Gate:** author a real SOP end-to-end in the tool; exported docx passes a
manual standards checklist; stale-doc flag fires on a back-dated article.

### Phase 3 — Imaging Pipeline + first standalone release

Configurable pipeline stages, device board, evidence attachments. First
public binary release: cross-compiled executables + SHA256SUMS +
attestations.
**Gate:** one full synthetic deployment tracked stage-by-stage; binaries
verified on clean Windows 11 and macOS machines by hash before first run.

### Phase 4 — Connectors + Reporting + AI v1

AD/LDAP and one endpoint-management connector (read-only), saved views,
CSV/XLSX export, scoped API keys, Doc Studio AI assistant, MCP server.
**Gate:** connector sync is idempotent and surfaces identity conflicts as
exceptions (never merges); an external tool completes a read-only workflow
via API key only.

## 11. Open questions

1. Final name confirmation after trademark/domain/org checks (Gate 0).
2. Standalone-mode auth default: local-only, or OIDC also configurable?
3. Whether imaging pipeline stages ship with opinionated defaults
   (AD-join-style flow) or start fully generic.
4. Windows code signing route and timing (depends on current program
   eligibility; re-verify at Phase 3).
5. Community infrastructure timing: issue templates, discussions, roadmap
   visibility -- at first public release or after Phase 1?

## 12. Change history

| Version | Date | Summary of changes |
| --- | --- | --- |
| Draft v0.1 | 07/15/2026 | Initial charter: verified market context, stack decision, dual distribution shapes, security baseline, release integrity plan, gated roadmap - Damien Clark |
| Draft v0.2 | 07/15/2026 | License decided: Apache-2.0; removed license open question - Damien Clark |
