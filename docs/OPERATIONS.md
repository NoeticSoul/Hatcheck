# Operating Hatcheck

Hatcheck supports one SQLite writer process for a workstation or small local
installation, or PostgreSQL for server deployments. Keep the database, the
matching application revision/image, and a copy of non-secret configuration
requirements in your recovery inventory. Protect `.env`, bootstrap logs and
backups as administrative data. Backups contain account password hashes,
session records, document contents and asset history; store them encrypted
outside the application machine with a defined retention period.

## PostgreSQL startup and privileges

Copy `.env.example` to `.env` and supply distinct random values for
`POSTGRES_PASSWORD`, `POSTGRES_OWNER_PASSWORD`, and `POSTGRES_APP_PASSWORD`.
Single-quote values in the Compose env file to preserve literal `$`, `#`, and
other special characters. Do not run `docker compose config` in shared logs:
its expanded output includes secrets.

```sh
docker compose up --build -d
docker compose ps
docker compose logs migrate
```

On a network using a private TLS certificate authority, provide its verified
CA bundle as an optional BuildKit secret during the image build:
`docker build --secret id=network_ca,src=/path/to/trusted-ca-bundle.pem -t
hatcheck-local .`. The install step adds that CA to trust without disabling
certificate verification; the bundle is not embedded in the image. Configure
your Compose image override to use the resulting image. Runtime outbound
OIDC connections need their own trusted CA mount/settings when applicable.

The migration service performs schema upgrades, creates the first administrator
on an empty database, then exits successfully. A generated administrator
password is logged once for a local operator; change it after login. A supplied
`HATCHECK_SEED_ADMIN_PASSWORD` is never printed. Set it securely through `.env`
or the deployment's secret injection to choose that password instead.
Starting a non-empty database does not recreate or reset accounts.

The bundled PostgreSQL init script runs only when the data volume is empty:

| Role | Purpose | Privileges |
| --- | --- | --- |
| `postgres` | PostgreSQL initialization and recovery | Bootstrap superuser; never used by the application |
| `hatcheck_owner` | Migration service | Owns the database/schema; cannot create roles or databases and is not a superuser |
| `hatcheck_app` | Running API | Data access; no schema changes and no update/delete/truncate of audit, custody, or document revision history |

The API uses discrete `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, and `PGPASSWORD`
settings. Runtime URL construction encodes credentials, including passwords
containing `/`, `#`, `?`, `@`, `%`, or `:`. `DATABASE_URL` remains supported for
external PostgreSQL deployments; when set, it takes precedence and must already
encode its credentials. Compose clears a copied `DATABASE_URL` and supplies
the correct discrete fields itself. It also removes bootstrap/migration
passwords from the running API environment.

`HATCHECK_SKIP_MIGRATIONS=true` and `HATCHECK_SKIP_BOOTSTRAP=true` make worker
startup read-only with respect to initialization. Compose sets these on the
API and runs one migration service before it starts. Direct PostgreSQL startup
serializes initialization with a PostgreSQL advisory lock. Do not run unrelated
migration tools concurrently. Direct SQLite installations run one process;
stop that process before upgrading the schema.

For external PostgreSQL, provision the owner/runtime roles through your database
administrator, initialize using owner credentials, and set
`POSTGRES_RUNTIME_ROLE` to the runtime role while running
`bun scripts/migrate.ts`. That command grants data access and protects the
history tables. Run the API with runtime credentials and both skip flags set.
The owner account is still trusted to manage history; a database administrator
can alter it. Database privileges complement application audit guarantees.

## AWS server and Windows MSI

For a shared team installation, host Hatcheck centrally in AWS and use the
Windows MSI to open its HTTPS site. Workstations do not run a local backend or
database; all users share the RDS PostgreSQL inventory. See
[AWS deployment](../infra/aws/README.md) and
[Windows MSI delivery](WINDOWS-MSI.md) for the build and deployment steps.

Remote PostgreSQL connections should use `HATCHECK_PG_SSL_MODE=verify-full`.
Set `HATCHECK_PG_SSL_ROOT_CERT` to the verified CA bundle path when the issuer is
not in the system trust store. The same certificate and hostname checks apply
to runtime connections, migrations and initialization locks. The default
`inherit` keeps existing local/URI transport behavior; it is not the AWS preset.

Behind an AWS Application Load Balancer, restrict the task security group to
the ALB security group. `HATCHECK_TRUSTED_PROXIES` can list the ALB's explicit
subnet CIDRs so changing ALB socket addresses still produce the correct audit
and login-limit client IP. The final appended `X-Forwarded-For` address is used
only for trusted socket peers. Do not trust arbitrary VPC or internet ranges.
The initial deployment runs one task; login counters are per process, including
brief overlap during rolling replacements. Reassess rate limits before scaling.

## Health and shutdown

`GET /api/v1/live` reports that the HTTP process is serving requests without
querying the database. `GET /api/v1/ready` and the existing
`GET /api/v1/health` perform a database query. They return `503 not_ready` when
that query fails and retain the existing successful health response shape.
Docker checks readiness. Point a load balancer at readiness and a process
supervisor at liveness.

`SIGTERM` and `SIGINT` stop new HTTP connections, drain active requests for up
to 15 seconds, finish the active expired-session sweep, close the store and
remove extracted temporary migrations. Compose allows 25 seconds for shutdown.
For custom supervisors use a grace period longer than 15 seconds. `bun run dev`
also terminates its watcher/server process groups on POSIX and child trees on
Windows. The supervisor grace period is the final limit for stalled
application transactions; PostgreSQL driver cleanup allows five seconds once
queued store operations have drained.

## SQLite backup and restore

Run these commands with the application revision that will read the restored
database. An explicit last argument overrides `HATCHECK_SQLITE_PATH`:

```sh
bun scripts/recovery.ts sqlite backup /secure-backups/hatcheck-20261006.db ./data/hatcheck.db
bun scripts/recovery.ts sqlite restore /secure-backups/hatcheck-20261006.db ./data/hatcheck-restored.db
```

Backup uses SQLite `VACUUM INTO`, reads committed WAL pages, and can run while
the source application is running. Copying only a live `.db` file is not a
backup. The helper checks integrity and recognizable schema, writes inside a
private temporary directory, then publishes a complete file with mode `0600`.
Existing destinations are refused.

Restore checks integrity, copies into a private temporary database, applies
the checked-out revision's migrations, checks integrity again and publishes
the new database. It refuses an existing target or SQLite sidecar files and
never overwrites the source backup. Stop the application, set
`HATCHECK_SQLITE_PATH` to the restored path, restart, and verify readiness,
login, representative assets, custody history, audit history and documents.
Keep the previous database untouched until verification is complete.

## PostgreSQL backup and restore

These commands run from the checkout containing `docker-compose.yml` with its
normal environment file. Native tools run inside the database container;
no host PostgreSQL installation is required. The database must be running.

```sh
bun scripts/recovery.ts postgres backup /secure-backups/hatcheck-20261006.dump
bun scripts/recovery.ts postgres restore /secure-backups/hatcheck-20261006.dump hatcheck_recovered
```

`pg_dump --format=custom --no-owner --no-acl` takes a consistent database
snapshot. Output is published only after a successful dump with mode `0600`.
Backup includes every application schema and the migration history. Roles and
environment credentials are provisioned separately and are not in the dump.
When `HATCHECK_PG_DATABASE` is configured, backup selects that database.

Restore creates a **new** database owned by `hatcheck_owner`. Existing names,
system databases, and the configured live database are refused.
`pg_restore --single-transaction --exit-on-error` restores all contents or none,
then the migration service upgrades schema and restores runtime privileges
without creating a new administrator. A failed restore/migration can leave
an unused destination database for diagnosis; it never changes the live one.

After a successful restore, stop the API, set
`HATCHECK_PG_DATABASE=hatcheck_recovered` in `.env`, and start it again:

```sh
docker compose stop app
docker compose up -d --force-recreate migrate app
```

Verify readiness, an existing account login, and representative asset/custody,
audit, import and document records before admitting traffic. Keep the original
database until this check passes. Restore drills should use a separate Compose
project or machine and synthetic data; never test by replacing the live volume.

## Upgrades and rollback

1. Schedule a maintenance window, stop the API, and take a backup. Verify that
   the backup can restore in an isolated deployment before a significant
   upgrade. Record the application revision/image and PostgreSQL major version.
2. Install frozen dependencies/build the chosen application revision. Keep
   PostgreSQL on its current major version during an application upgrade.
3. Run the migration owner once: `docker compose run --rm migrate` for Compose,
   or `bun scripts/migrate.ts` with owner credentials for direct deployments.
   SQLite migrations require the old writer to be stopped.
4. Start workers and check readiness, login, asset/custody transitions, imports,
   audit history, and document revision/export behavior. Migration failure
   leaves workers stopped; diagnose it before restarting.
5. Rollback means restoring the pre-upgrade backup into a new database and
   running the matching old application revision. Schema down-migrations are
   not provided; do not point an old binary at a migrated database.

PostgreSQL major upgrades need PostgreSQL's supported `pg_upgrade` or
dump/restore procedure. Changing `postgres:17` to a newer major against the
same volume is not an upgrade procedure.

### Existing deployments using the old Compose superuser account

The init script does not retrofit roles on an existing volume. The former
Compose setup used `hatcheck` as the PostgreSQL superuser; merely replacing
the Compose file would not create `postgres`, `hatcheck_owner`, or
`hatcheck_app`. Use a fresh deployment and a verified dump/restore instead:

1. With the **old** Compose file still selected, stop the old API and dump its
   database with `docker compose exec -T db pg_dump -U hatcheck -d hatcheck
   --format=custom --no-owner --no-acl > /secure-backups/legacy.dump`.
   Set a restrictive shell umask, check the command's exit status, and keep the
   old volume. PostgreSQL credentials remain in environment settings.
2. Start the new checkout as a distinct Compose project with a fresh volume
   and the three configured role passwords. Keep the old API stopped so its
   published port is available. The new migration service initializes roles
   and schema before the API starts.
3. Restore `legacy.dump` to `hatcheck_recovered` with the new recovery helper,
   select it using `HATCHECK_PG_DATABASE`, then verify the restored instance.
   Runtime grants are applied by the migration service. Keep the previous
   application revision and old volume available for rollback.

Do not run the init script blindly against a populated old database or delete
the old volume to make startup succeed.

### Legacy custody and OIDC identities

Migration 0003 assigns legacy custody sequences in the historical `(at,id)`
order. It preserves records but cannot reconstruct the original commit order
of events that were already misordered by clock rollback or independent
writers. Before admitting traffic, check the restored instance for consecutive
events of the same type and disagreements between its latest custody event
and lifecycle state. These portable queries identify records for review:

```sql
WITH ordered AS (
  SELECT asset_id, sequence, type,
    lag(type) OVER (PARTITION BY asset_id ORDER BY sequence) AS previous_type
  FROM custody_events
)
SELECT asset_id, sequence, type FROM ordered
WHERE (sequence = 1 AND type <> 'check_out') OR type = previous_type;

SELECT a.id, a.name, a.status, e.type, e.sequence
FROM assets a LEFT JOIN custody_events e
  ON e.asset_id = a.id AND e.sequence = (
    SELECT max(last_event.sequence) FROM custody_events last_event
    WHERE last_event.asset_id = a.id
  )
WHERE (a.status = 'deployed' AND (e.type IS NULL OR e.type <> 'check_out'))
   OR (a.status <> 'deployed' AND e.type = 'check_out');
```

Preserve the backup and compare flagged records against audit snapshots and
operator evidence. Do not silently rewrite timestamps or reorder history.
If a valid check-in/out can reconcile current state, use the audited UI/API
with an explanatory note. Otherwise keep the affected record out of use and
resolve the evidence before resuming its custody workflow. Fresh transitions
use sequence order regardless of the wall clock or generated ID.

Legacy OIDC accounts have no recorded issuer and intentionally fail closed.
There is no automatic binding by matching email. After verifying the previous
issuer and each subject against identity-provider records, an administrator
with migration-owner access may bind the verified issuer during maintenance.
Record an `identity.migrate` audit with actor, reason and before/after identity
in the same transaction as the update, then test sign-in on the restored copy.
If that evidence is unavailable, keep the account disabled and use a local
administrator; changing the configured issuer never transfers an old role to
a reused subject.

## Recovering a lost local administrator password

Use this explicit offline procedure when no working administrator can reset
another local administrator through the account page. It requires operating
system/database owner access and an existing **local admin** account; it never
creates an account, promotes a technician, or changes an identity provider.

1. Stop every API worker and take a verified backup. Use the application
   revision matching the existing database schema; this command performs no
   migrations or first-run initialization.
2. Configure the existing database as usual. For PostgreSQL, use the migration
   owner credential through the secure environment bindings. For SQLite, set
   `HATCHECK_SQLITE_PATH` to the existing database and run as its filesystem
   owner.
3. Supply `HATCHECK_RECOVERY_EMAIL` and `HATCHECK_RECOVERY_PASSWORD` securely in
   the recovery process environment, then run `bun scripts/reset-admin.ts`.
   The password must contain at least twelve characters. Do not put its value
   in command arguments, checked-in files, shell history, or shared logs.
4. After success, unset `HATCHECK_RECOVERY_PASSWORD` and
   `HATCHECK_RECOVERY_EMAIL`, restore the normal API runtime credentials, and
   restart the API. Sign in with the recovered account and check its
   `user.offline_recovery` audit entry.

Recovery resets the account password, reactivates that local administrator,
revokes every session for it, and records sanitized before/after state in one
transaction. Audit failure rolls the entire operation back. The command prints
no password or hash. Identity-provider administrators must recover credentials
with their provider instead. An absent SQLite database is refused.

## Recovery checks to retain

An import interrupted by process termination can retain `running` status
because no completion record was written. Its saved row outcomes and counters
reflect committed progress. Inspect those rows, then preview the original CSV
again before retrying; identity matching makes unchanged rows idempotent and
routes changed or conflicting identities to human review. Do not infer that a
job is actively executing from its persisted status alone.

The automated SQLite drill keeps the source open with a non-empty WAL and
verifies restored account/password hashes, sessions, assets/interfaces, custody
events and audit records. A deployment drill should additionally verify
representative document revisions and imports through the API. Check that the
runtime role can create an audited inventory change, cannot rewrite history,
and cannot create a table. Repeat a restore drill after migration or database
major-version changes and periodically according to your recovery objective.
