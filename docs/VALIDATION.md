# Stabilization and pilot validation

Local verification on 2026-10-06 covers the first three audit recommendations:
accountability stabilization, pilot operations, and one complete Doc Studio/KB
workflow. Later imaging, connectors, scoped keys, AI, reporting, and public
signed/attested releases remain deferred. These results describe local
verification; source publication does not deploy an organization or publish
a signed binary release.

## Implemented behavior

- Application mutations and audits commit together. Imports commit each row's
  mutation, audit, result and progress together while retaining partial runs.
- Per-asset custody sequences establish transition order. Shared database
  locks serialize last-admin and location hierarchy checks across writers.
- Browser writes require an approved origin; CSV requires `text/csv`. OIDC
  identities bind issuer and subject, require verified email and explicit
  admission. Failed transaction finalization discards session cookie effects.
- Account administration, local password rotation/recovery, paged import
  investigation, useful dashboard links and mobile dialog/error handling are
  implemented. Hard-delete audits retain the complete asset custody ledger.
- Migration ownership, restricted runtime roles, readiness, shutdown,
  backups, restore, upgrade and rollback are documented in OPERATIONS.md.
- Documents enforce six SOP sections, immutable revisions, optimistic edits,
  administrator publication, approved-snapshot privacy, historical restore,
  archives, search, overdue review flags and selected-revision exports.
- Standalone compilation copies its inputs and generates its embedded manifest
  outside the checkout. Concurrent targets retain the development manifest
  and production web output unchanged.

## Checks completed

| Check | Result |
| --- | --- |
| Strict TypeScript typecheck | Passed |
| Full SQLite API/unit/integration run with PG contracts enabled | Follow-up: 34 files, 528 passed, no skips |
| Full PostgreSQL API/unit/integration run | Follow-up: 34 files, 528 passed, no skips |
| Chromium browser suite | 14 passed |
| Production web build | Passed |
| Full dependency audit | No vulnerabilities found |
| Whitespace check | Passed |
| SQLite recovery | Open-WAL backup and refusal-to-overwrite restore passed |
| PostgreSQL recovery | Native backup/restore into a new DB; accounts/hashes, sessions, inventory/interfaces, custody, audits and document revisions matched; restored readiness/login passed |
| PostgreSQL startup/roles | Concurrent initialization produced one admin/audit; runtime data writes passed and schema/history modification was denied |
| Container runtime | Bun user, SQLite and PostgreSQL readiness/UI, secret separation, and SIGTERM exit 0 passed |
| Standalone compilation | Linux and Windows x64 compiled concurrently without changing source manifest or web output |
| Linux standalone execution | Clean-directory readiness, login, embedded UI/migrations, SOP authoring, overdue flag and DOCX export passed |
| DOCX rendering | Recovery SOP and a four-page Unicode/literal-markup sample opened and rendered in LibreOfficeDev; visual review passed |

The final document/dashboard approved-snapshot regression also passed on both
engines and in the browser. The browser SOP flow authors, publishes, revises,
restores historical content, exports revision 1 in all formats, verifies
read-only draft isolation, and follows the dashboard overdue filter.

Tests used Bun 1.3.14, Node 24.19, PostgreSQL 17, disposable fixture databases
and synthetic data. API tests choose their database through
`HATCHECK_TEST_DB`; PostgreSQL requires `HATCHECK_TEST_PG_URL` pointing to a
disposable service with database/role administration permission. CI runs the
same database matrix and gates unsigned build artifacts on tests and audit.
Check GitHub-hosted CI for the exact source commit before rollout; the results
recorded here are from local verification.

## Limits and remaining review

The complete Dockerfile BuildKit dependency step was blocked by connection
failures in this cloud environment. TLS verification remained enabled.
Frozen dependency installation and the web build passed inside a Docker
container; those verified outputs built through the identical runtime stage
and passed both database modes and the PostgreSQL recovery drill. A normal
end-to-end BuildKit build should still be checked on the deployment network.

The automatic Windows cross-runtime download was incomplete. Compilation
passed using Bun's supported executable-path override with the official
matching-version Windows package, verified against registry SHA-512. Windows
execution and macOS builds were not tested.

The team's human DOCX review remains open in SOP-STANDARDS.md. LibreOffice
rendering evidence does not close that office-application acceptance gate.
Naming/IP clearance is still a maintainer decision.

Legacy custody sequences preserve historical timestamp/ID order; already
misordered history needs evidence-based review. Legacy issuer-less OIDC
accounts need an explicit verified identity migration. OPERATIONS.md covers
both upgrade constraints. PostgreSQL mutations deliberately use a coarse
application lock suitable for the current small-team scope; large deployment
load and hosted identity providers were not validated.

## Windows MSI and AWS connection follow-up (2026-10-07)

The user authorized MSI delivery and preparation of a new AWS deployment, then
clarified that the system administrator will supply the region, domain and
certificate later. Those remain explicit inputs; no AWS account access or
resources were used. The MSI launches a shared HTTPS application, so workstation
users need no local Hatcheck server, inventory database or database credentials.

- A self-contained Windows GUI executable was cross-published with .NET
  10.0.401/10.0.12. The launcher URL policy passed 36 cases and both PowerShell
  scripts passed syntax parsing. WiX 4.0.6 is pinned; runtime/tool licensing
  notices are included. MSI linking and actual installation require Windows
  and have not run in this Linux environment. CI now builds two MSI versions
  and checks installation, repair, retargeting, upgrade, downgrade refusal,
  uninstall and user-state preservation before uploading pilot artifacts.
- Verified PostgreSQL TLS passed under Node 24.19 and Bun 1.3.14 with a disposable
  PostgreSQL 17 server. Both reject an unknown CA and a hostname mismatch. All
  runtime, migration and startup-lock connections use the same TLS options.
  A driver fallback to localhost for IP endpoints was discovered and fixed
  by binding certificate verification to the configured database hostname.
- A local RDS-style nonsuperuser master initialized owner/runtime roles, then
  reran safely. Passwords with quotes, backslashes and dollars authenticated;
  SQL uses SCRAM verifiers rather than plaintext credentials. Concurrent owner
  initialization produced one administrator/audit. Restricted runtime writes
  succeeded while schema/role creation and rewriting history were denied.
  Inherited runtime privileges were refused. These checks approximate RDS
  permissions locally; they are not a connection to the organization's AWS.
- Supplied bootstrap passwords stay out of server logs. ALB proxy subnet CIDRs
  are validated and only matching socket peers may supply a final forwarded IP.
  AWS configuration pairs these ranges with ALB-only task security-group ingress.
- Terraform formatting/validation and two fully mocked safety scenarios passed.
  Ten Python failure-path tests passed without AWS calls, including stopped-task
  exit checks, draining tasks, secret cleanup, CA mismatch and activation gates.
  The full application suites passed 528 tests per database; Chromium passed
  14 tests again. Typecheck, production build and dependency audit also passed.
- The new Docker runtime stage, assembled with previously verified frozen
  dependencies, passed a nonroot/read-only filesystem check with an anonymous
  writable volume at `/app/runtime-tmp`. The image's declared volume ownership
  permits Bun's temporary migration files without granting root access. Actual
  Fargate volume and task behavior still require deployment acceptance.

The official AWS RDS truststore host returned HTTP 403 in this cloud environment.
No certificate bundle or invented digest was substituted. The sysadmin must run
the verified HTTPS fetch and review the public CA bundle on an allowed network
before building the AWS image; deployment preflight fails if the bundle is
missing or its checksum differs. Live AWS IAM/network/Fargate acceptance and
native Windows MSI acceptance remain open. No AWS resources were provisioned
and no signed binary releases were published during this preparation.

See [Windows MSI instructions](WINDOWS-MSI.md) and the
[AWS handoff/runbook](../infra/aws/README.md).

## Pre-handoff review package

The current source was packaged as `dist/review/hatcheck-review-source.zip`,
excluding dependencies, build output, databases, environment secrets, Terraform
state and machine caches. Archive integrity and required-file checks passed.
A separate extracted copy passed frozen dependency installation with lifecycle
scripts disabled, production build, fresh SQLite bootstrap, readiness, served
web UI, administrator login, and the review CSV preview/commit/reimport flow.
The reimport created no duplicate assets. This smoke ran on Bun/Linux; native
Windows acceptance remains open.

[PRE-HANDOFF-TEST.md](PRE-HANDOFF-TEST.md) provides Windows instructions, an
isolated SQLite trial and manual checklist. Its optional local MSI test uses
a loopback Caddy HTTPS proxy with separate test CA storage, a Windows hosts
entry and explicit certificate trust/removal. Caddy directives were checked
against official documentation/source; the Windows HTTPS/MSI flow has not
been executed in this environment.
