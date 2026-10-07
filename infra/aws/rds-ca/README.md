# Amazon RDS trust roots

The image reads `/app/infra/aws/rds-ca/global-bundle.pem` and connects with
`HATCHECK_PG_SSL_MODE=verify-full`. Certificate-chain **and hostname**
verification stay enabled; there is no insecure fallback.

Canonical AWS source:
<https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem>.
AWS explains certificate rotation here:
<https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html>.

Fetch with `python3 scripts/aws/fetch-rds-ca.py` before the first AWS image
build. This downloads through HTTPS with normal host trust, validates PEM with
OpenSSL, and records `global-bundle.sha256`. Review certificate subjects and
expiry, then retain the bundle/checksum in the reviewed release. The
deployment helper refuses to build/push when either file is absent or the
checksum differs.

The current preparation environment received HTTP 403 from the AWS truststore
host, including an allowed network escalation. Therefore no certificate
bundle or invented expected checksum is checked in at this point. The
operator must fetch it from the official source on an allowed network before
AWS deployment. This does not change SQLite/local development.

For a future AWS CA rotation, archive both reviewed files, fetch again, inspect
the new certificates and digest, rebuild the immutable image, then perform a
tested maintenance deployment. Do not silently overwrite an existing bundle.
