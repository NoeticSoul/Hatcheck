# Security Policy

Hatcheck is pre-release software (Gate 0 / Phase 0). There is no supported
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
