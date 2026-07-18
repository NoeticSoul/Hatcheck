# Contributing to Hatcheck

Thanks for your interest. Hatcheck is early (Gate 0 / Phase 0 — see
CHARTER.md for the roadmap), so the most useful contributions right now are
bug reports, portability fixes, and feedback on the foundation.

## Ground rules

These mirror CHARTER.md and CLAUDE.md and are enforced in review:

1. **Dual-database portability.** Every schema change and query must work
   on both PostgreSQL and SQLite. No PG-only features in core paths. CI
   runs against both engines and must be green on both.
2. **API-first.** New functionality lands as a documented, tested REST
   endpoint before any UI is built on it. Keep the OpenAPI spec in sync in
   the same PR.
3. **Security invariants.** RBAC checks live at the API layer, never only
   in the UI. Every mutating action writes an audit record. No secrets in
   code, config, fixtures, or tests — environment variables only.
4. **Synthetic data only.** Never add real organization names, hostnames,
   MAC addresses, usernames, or network details to seeds, fixtures, tests,
   or docs.
5. **Scope.** Ticketing engines, RMM/remote control, MDM, billing, and
   cloud discovery are out of scope (CHARTER.md section 4). PRs building
   these will be declined regardless of quality.

## Development setup

Prerequisites: [Bun](https://bun.sh) 1.3+ (Node 20+ kept compatible),
and optionally Docker for PostgreSQL server mode.

```sh
bun install
bun run dev        # API on :3000 and Vite dev server on :5173
bun run test       # unit + integration tests (SQLite)
bun run typecheck
```

See README.md for environment variables and PostgreSQL mode.

## Pull requests

- Use conventional commit messages: `feat:`, `fix:`, `chore:`, `docs:`,
  `test:`.
- Tests accompany features in the same PR. Do not submit work with
  failing or skipped tests.
- TypeScript strict mode; no `any` without an inline justification
  comment.
- ASCII characters only in source files; straight quotes; UTF-8.
- Small modules over god files; colocate unit tests next to source.

## Reporting security issues

See SECURITY.md — please do not open public issues for vulnerabilities.

## License

By contributing, you agree that your contributions are licensed under the
Apache License 2.0 (see LICENSE), per section 5 of that license.
