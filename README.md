# Hatcheck

Self-hosted IT management for small IT teams: assets, locations, imaging
pipeline, knowledge base, and standards-enforced documentation -- API-first,
with an optional AI layer.

> The name "Hatcheck" is provisional, pending trademark and domain checks
> (see [CHARTER.md](CHARTER.md), Gate 0).

> **Status: pre-alpha.** Phase 0 (foundation) is in progress: auth, RBAC,
> audit log, dual-database support, and the CI/e2e scaffolding. No feature
> modules exist yet. Scope, architecture, and roadmap live in
> [CHARTER.md](CHARTER.md).

## Planned features

| Module | Summary | Status |
| --- | --- | --- |
| Assets & Locations | Device/peripheral/license records, buildings/rooms, check-in/check-out, lifecycle states | Planned (Phase 1) |
| Doc Studio | Guided SOP/KB authoring with enforced standards; export to Markdown/HTML/docx/PDF | Planned (Phase 2) |
| Knowledge Base | Searchable library of rendered docs with review-date tracking | Planned (Phase 2) |
| Imaging Pipeline | Per-device deployment state board with configurable stages and evidence | Planned (Phase 3) |
| Connectors | Read-only collectors: CSV first, then AD/LDAP, SCCM, Jamf, Intune | Planned (Phase 4) |
| Reporting & Exports | Saved views, CSV/XLSX export, scoped read-only API keys | Planned (Phase 4) |
| Admin & Audit | RBAC, OIDC + local auth, append-only audit log | In progress (Phase 0) |

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
# edit .env: set POSTGRES_PASSWORD (compose refuses to start without it)
docker compose up --build
docker compose exec app bun run seed   # once, in a second terminal
```

Open <http://localhost:3000> and sign in as `admin@hatcheck.test` with the
password the seed printed.

## Environment variables

All configuration is environment-only; see [.env.example](.env.example) for
the annotated template. No secrets in files or the database, ever.

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development` / `test` / `production` |
| `PORT` | `3000` | API server port |
| `APP_URL` | `http://localhost:$PORT` | Public base URL |
| `HATCHECK_DB` | `sqlite` | `sqlite` or `postgres` |
| `DATABASE_URL` | -- | PostgreSQL connection string (required for `postgres`) |
| `HATCHECK_SQLITE_PATH` | `./data/hatcheck.db` | SQLite file location |
| `SESSION_TTL_HOURS` | `12` | Session lifetime |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | unset | OIDC SSO; set all three or none |
| `OIDC_REDIRECT_URI` | `$APP_URL/api/v1/auth/oidc/callback` | OIDC callback override |
| `HATCHECK_AI_PROVIDER` | unset | `anthropic` / `openai` / `ollama`; unset = AI off |
| `HATCHECK_SEED_ADMIN_PASSWORD` | random | Admin password used by the seed script |
| `POSTGRES_PASSWORD` | -- | Compose-only: password for the bundled PostgreSQL |

## Scripts

| Script | What it does |
| --- | --- |
| `bun run dev` | API + web dev servers together, prefixed output |
| `bun run dev:server` | API only, watch mode |
| `bun run dev:web` | Vite dev server only |
| `bun run build` | Build the production web bundle |
| `bun run start` | Run the production server |
| `bun run test` | Unit/integration tests (Vitest) |
| `bun run typecheck` | `tsc --noEmit` (strict) |
| `bun run db:generate` | Regenerate Drizzle migrations for both engines |
| `bun run seed` | Create schema + synthetic seed data, print admin password |
| `bun run e2e` | Playwright end-to-end tests |

## Testing

- `bun run test` runs the Vitest suite against SQLite by default.
- PostgreSQL integration tests self-skip unless `HATCHECK_TEST_PG_URL` is
  set to a reachable PostgreSQL URL (a throwaway database; tests may write
  to it).
- CI runs the full suite twice -- once per database engine -- plus a
  dependency vulnerability audit. Both legs must be green.
- `bun run e2e` seeds a scratch SQLite database, boots the production
  server, and drives a real browser through login/logout.

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
