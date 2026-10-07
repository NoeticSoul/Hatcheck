# Security Policy

Hatcheck is pre-release software. There is no supported
production release yet; security fixes land on the main branch.

## Supported versions

| Version | Supported |
| --- | --- |
| main (unreleased) | Yes |

Once versioned releases exist, this table will list the supported release
lines.

## Reporting a vulnerability

Please do not open a public issue for security problems.

- Preferred: use GitHub's private vulnerability reporting ("Report a
  vulnerability" under the repository's Security tab) once the repository
  is public.
- Otherwise: email the maintainer at damienclark22@yahoo.com with the
  subject line "Hatcheck security report".

Include what you can: affected component or endpoint, reproduction steps,
impact, and any suggested fix. Reports in plain text are fine; no template
required.

## What to expect

- Acknowledgement within 7 days.
- An assessment (accepted / not a vulnerability / needs more info) within
  30 days.
- Credit in the release notes for the fix, unless you ask not to be named.

This is a volunteer-maintained project; there is no bug bounty program.

## Scope notes

- Hatcheck is self-hosted. Vulnerabilities in a particular deployment's
  configuration (weak passwords, exposed ports, unpatched hosts) are the
  operator's responsibility, but hardening suggestions are welcome as
  regular issues.
- Secrets are expected to be provided via environment variables only. Any
  code path that reads or stores secrets elsewhere is itself a valid
  security report.
- AI features are optional and off by default. Any way to trigger an AI
  provider call without explicit configuration, or any AI call that
  bypasses the audit log, is a valid security report.

## Deployment boundaries

Set `APP_URL` to the public app origin. Browser writes accept that exact
origin; development mode also accepts localhost/127.0.0.1 port 5173 for Vite.
Other origins, including sibling subdomains, are rejected even when browser
cookies use SameSite. Non-browser clients without Origin/Fetch Metadata may
use session-authenticated requests. CSV uploads require `text/csv`.

`HATCHECK_TRUST_PROXY=true` requires `HATCHECK_TRUSTED_PROXIES`, a comma-separated
list of literal connecting proxy IPs or explicit subnet CIDRs. Only those peers may supply the final
`X-Forwarded-For` address. The proxy must append the actual client address;
deny direct access at the network boundary when deploying behind it. No
forwarded hostname/protocol headers determine cookie or origin policy.

AWS deployment keeps PostgreSQL private to the application security group,
requires verified TLS to RDS, and separates runtime, migration-owner and
database-bootstrap secrets. The Windows MSI stores only the shared HTTPS app
address. Initial-admin passwords supplied through secret injection are not
printed to server logs; generated local credentials retain a one-time handoff.

OIDC login requires a verified email claim and binds accounts to the exact
issuer and subject, never email alone. New account provisioning defaults off;
`OIDC_AUTO_PROVISION=true` requires `OIDC_ALLOWED_EMAIL_DOMAINS` and assigns
readonly. Email collisions and legacy accounts without an issuer fail closed.
Before enabling login for a legacy account, an administrator must verify its
original issuer/subject and explicitly migrate that identity in a separate
audited database migration; never bind all legacy subjects to a new issuer.
Login and callback attempts are rate limited, with bounded in-memory limiter
state per instance.

See [OPERATIONS.md](docs/OPERATIONS.md) for database roles, backups and upgrades.
