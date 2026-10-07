# Hatcheck

Self-hosted IT management for small IT teams: assets, locations, imaging
pipeline, knowledge base, and standards-enforced documentation -- API-first,
with an optional AI layer.

> The name "Hatcheck" is provisional, pending trademark and domain checks
> (see [CHARTER.md](CHARTER.md), Gate 0).

> **Status: pre-alpha.** Phases 0 and 1 are complete: auth, RBAC, the
> append-only audit log, dual-database support, assets and locations with
> check-in/check-out custody history, exception-first CSV import with
> dry-run, CSV export, and the web UI over all of it. Stabilization adds
> atomic audits, causal custody ordering, account administration, recovery,
> and a structured Doc Studio/Knowledge Base workflow. Phase 2 validation
> and export standards are recorded in [docs/SOP-STANDARDS.md](docs/SOP-STANDARDS.md). Scope,
> architecture, and roadmap live in [CHARTER.md](CHARTER.md).

## Planned features

| Module | Summary | Status |
| --- | --- | --- |
| Assets & Locations | Device/peripheral/license records, buildings/rooms, check-in/check-out, lifecycle states, CSV import/export | Shipped (Phase 1) |
| Doc Studio | Required SOP sections, immutable revisions, approval, Markdown/HTML/docx export | Implemented (Phase 2 validation) |
| Knowledge Base | Published document search and rendering, review-date tracking | Implemented (Phase 2 validation) |
| Imaging Pipeline | Per-device deployment state board with configurable stages and evidence | Planned (Phase 3) |
| Connectors | Read-only collectors: CSV first, then AD/LDAP, SCCM, Jamf, Intune | Planned (Phase 4) |
| Reporting & Exports | Saved views, CSV/XLSX export, scoped read-only API keys | Planned (Phase 4) |
| Admin & Audit | RBAC, OIDC + local auth, append-only audit log | Shipped (Phase 0) |

## Quickstart A -- Dev / standalone (SQLite)

Requires [Bun](https://bun.com) >= 1.3 (`curl -fsSL https://bun.com/install | bash`,
or `powershell -c "irm bun.com/install.ps1 | iex"` on Windows).

```sh
bun install
bun run seed   # creates the SQLite DB and the admin user; PRINTS the admin password
bun run dev    # starts API (:3000) and web dev server (:5173)
```

Open <http://localhost:5173> and sign in as `admin@hatcheck.test` with the
password the seed printed.

## Quickstart B -- Server mode (Docker + PostgreSQL)

Requires Docker with the compose plugin.

```sh
cp .env.example .env
# edit .env: set POSTGRES_PASSWORD, POSTGRES_OWNER_PASSWORD,
# POSTGRES_APP_PASSWORD and HATCHECK_SEED_ADMIN_PASSWORD
docker compose up --build
```

Open <http://localhost:3000> and sign in as `admin@hatcheck.test` with the
initial password you configured. The one-shot migration service initializes
the schema and first administrator; the app uses a separate DML-only role.
See [deployment, upgrades and recovery](docs/OPERATIONS.md) before upgrading
an existing Compose installation.

## Quickstart C -- Standalone executable (unsigned test build)

Single-file executables with the web UI, migrations, and SQLite engine
embedded — no runtime install on the target machine. Download
`hatcheck-windows-x64` or `hatcheck-linux-x64` from the artifacts of any
green CI run, or build locally:

```sh
bun run compile                        # linux-x64 + windows-x64 -> dist/bin/
bun run compile --target windows-x64   # one target
```

Build inputs and the generated embedded-file manifest are isolated from the
checkout, so compiling does not change the running development server's
manifest. If automatic cross-runtime download is unavailable, a single target
accepts `--compile-executable-path /path/to/bun.exe`; obtain the matching Bun
version from its official distribution and verify its package integrity first.

Run the executable from any folder. On first start it creates
`./data/hatcheck.db` next to your working directory and prints the
initial admin login **once** (set `HATCHECK_SEED_ADMIN_PASSWORD` and/or
`HATCHECK_INIT_ADMIN_EMAIL` beforehand to choose your own). Then open
<http://localhost:3000>. `PORT` and `HATCHECK_SQLITE_PATH` relocate the
listener and database.

These are **unsigned test builds** pulled forward from the Phase 3
roadmap by maintainer decision: expect SmartScreen/Gatekeeper warnings,
and verify the SHA-256 the compile step prints. The signed, attested
public release pipeline remains Phase 3 (see Release integrity below).

## Quickstart D -- Windows MSI + AWS-hosted server

The Windows MSI installs a small launcher and shortcuts for a shared HTTPS
Hatcheck deployment. Double-clicking the shortcut opens the site in your default
browser; the workstation runs no local server and holds no database credentials.
The app and inventory database run centrally in AWS using ECS Fargate and private
RDS PostgreSQL. Internet or company-network access to the deployment is required.

Prepare the deployment using [infra/aws/README.md](infra/aws/README.md). Then
build the unsigned pilot MSI on Windows with .NET and PowerShell:

```powershell
./scripts/package-windows.ps1 -ServerUrl https://hatcheck.example.test -Version 0.0.1
```

Replace the synthetic address with the deployed HTTPS address. CI also builds
and verifies MSI installation, repair, upgrades and uninstall; its workflow
input or repository `HATCHECK_SERVER_URL` variable selects the site. See
[Windows MSI delivery](docs/WINDOWS-MSI.md) for installation and verification.
This user-authorized packaging/hosting exception leaves the Phase 2 review
and other later workflows open. AWS resources are not created by tests or builds.

To review the application before the sysadmin handoff, follow
[the local test guide](docs/PRE-HANDOFF-TEST.md). It includes an isolated SQLite
trial, a manual feature checklist and optional local HTTPS/MSI checks without
an AWS account.

## Environment variables

All configuration is environment-only; see [.env.example](.env.example) for
the annotated template. Keep plaintext credentials out of source control;
password hashes and session-token hashes are stored in the database.

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development` / `test` / `production` |
| `PORT` | `3000` | API server port |
| `APP_URL` | `http://localhost:$PORT` | Public base URL |
| `HATCHECK_DB` | `sqlite` | `sqlite` or `postgres` |
| `DATABASE_URL` | -- | PostgreSQL URI, or use `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` for correctly encoded credentials |
| `HATCHECK_PG_SSL_MODE` / `HATCHECK_PG_SSL_ROOT_CERT` | `inherit` / unset | Remote PostgreSQL verified TLS and optional CA bundle; AWS uses `verify-full` |
| `HATCHECK_SQLITE_PATH` | `./data/hatcheck.db` | SQLite file location |
| `SESSION_TTL_HOURS` | `12` | Session lifetime |
| `HATCHECK_TRUST_PROXY` / `HATCHECK_TRUSTED_PROXIES` | `false` / unset | Trust forwarded IPs only from listed literal peer addresses or explicit CIDRs |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | unset | OIDC SSO; set all three or none |
| `OIDC_REDIRECT_URI` | `$APP_URL/api/v1/auth/oidc/callback` | OIDC callback override |
| `OIDC_AUTO_PROVISION` / `OIDC_ALLOWED_EMAIL_DOMAINS` | `false` / unset | Explicit admission of verified-email SSO users; see SECURITY.md |
| `HATCHECK_SKIP_MIGRATIONS` / `HATCHECK_SKIP_BOOTSTRAP` | `false` | Runtime workers skip initialization after the migration owner completes it |
| `HATCHECK_AI_PROVIDER` | unset | `anthropic` / `openai` / `ollama`; unset = AI off |
| `HATCHECK_SEED_ADMIN_PASSWORD` | random | Admin password used by the seed script |
| `POSTGRES_PASSWORD` / `POSTGRES_OWNER_PASSWORD` / `POSTGRES_APP_PASSWORD` | -- | Compose bootstrap, migration-owner, and runtime role passwords |

## Scripts

| Script | What it does |
| --- | --- |
| `bun run dev` | API + web dev servers together, prefixed output |
| `bun run dev:server` | API only, watch mode |
| `bun run dev:web` | Vite dev server only |
| `bun run build` | Build the production web bundle |
| `bun run package:windows -ServerUrl https://hatcheck.example.test` | Build the Windows cloud-launcher MSI using PowerShell/.NET/WiX |
| `bun run start` | Run the production server |
| `bun run test` | Unit/integration tests (Vitest) |
| `bun run typecheck` | `tsc --noEmit` (strict) |
| `bun run db:generate` | Regenerate Drizzle migrations for both engines |
| `bun run seed` | Create schema + synthetic seed data, print admin password |
| `bun run e2e` | Playwright end-to-end tests |
| `bun scripts/migrate.ts` | Apply migrations/bootstrap using the configured owner credentials |
| `bun scripts/recovery.ts` | Backup or restore SQLite / Compose PostgreSQL; see docs/OPERATIONS.md |
| `bun scripts/reset-admin.ts` | Audited offline recovery of an existing local administrator using explicit secure environment bindings |

## Testing

- `bun run test` runs the Vitest suite against SQLite by default.
- Set `HATCHECK_TEST_DB=postgres` and `HATCHECK_TEST_PG_URL` to run API and
  integration suites on PostgreSQL. Use a disposable server with permission
  to create and remove test databases and roles; fixtures isolate and remove
  their databases. The startup-privilege test provisions temporary roles.
  PostgreSQL contract tests self-skip when the URL is absent.
- CI runs the full suite twice -- once per database engine -- plus a
  dependency vulnerability audit. Both legs must be green.
- `bun run e2e` seeds a scratch SQLite database, boots the production
  server, and drives a browser through inventory, import investigation,
  account management, mobile dialogs, and SOP authoring/export.

Use the Users and Account pages to manage a team and change local passwords.
Saved import reports include paged source rows and a complete outcomes CSV.
Retire assets to retain their readable custody history; admin hard deletion
preserves the full ledger in its deletion audit. Document archival retains
all revisions for staff and removes the article from readers' searches.

## API docs

The REST API is versioned under `/api/v1`. With the server running:

- Swagger UI: `/api/v1/docs`
- OpenAPI spec: `/api/v1/openapi.json`

## Security

See [SECURITY.md](SECURITY.md) for the disclosure policy. Baseline
invariants (charter section 6): secrets via environment variables only,
RBAC enforced at the API layer, an append-only audit log covering every
mutating action and every AI call, and AI features off by default.

## Release integrity

No binary releases exist yet. From the first release (Phase 3), all
artifacts are built in CI, published with a `SHA256SUMS` file, and covered
by GitHub artifact attestations (`gh attestation verify`). Unsigned
binaries will trigger SmartScreen/Gatekeeper warnings until code signing
lands; hash verification proves integrity regardless. Details in
[CHARTER.md](CHARTER.md), section 8.

## License

[Apache-2.0](LICENSE). See also [NOTICE](NOTICE) and
[CONTRIBUTING.md](CONTRIBUTING.md).
