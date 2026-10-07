#!/usr/bin/env python3
"""Fetch AWS's public RDS trust roots, validate PEM, and record provenance.

This intentionally refuses to overwrite an existing reviewed bundle. CA
rotation is a separate reviewed update: archive/remove both files first.
"""
import hashlib
from pathlib import Path
import subprocess
import tempfile
import urllib.request

URL = "https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem"
DIRECTORY = Path(__file__).resolve().parents[2] / "infra" / "aws" / "rds-ca"
TARGET = DIRECTORY / "global-bundle.pem"


def main():
    if TARGET.exists() or TARGET.with_suffix(".sha256").exists():
        raise SystemExit("A CA bundle/checksum already exists; review rotation rather than overwriting it")
    with urllib.request.urlopen(URL, timeout=30) as response:
        if response.geturl() != URL:
            raise SystemExit("Refusing an unexpected CA download redirect")
        bundle = response.read(1024 * 1024 + 1)
    if len(bundle) > 1024 * 1024 or b"-----BEGIN CERTIFICATE-----" not in bundle:
        raise SystemExit("Unexpected RDS CA response")
    DIRECTORY.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=DIRECTORY, suffix=".pem") as candidate:
        candidate.write(bundle)
        candidate.flush()
        subprocess.run(["openssl", "crl2pkcs7", "-nocrl", "-certfile", candidate.name, "-outform", "PEM"], check=True, stdout=subprocess.DEVNULL)
    digest = hashlib.sha256(bundle).hexdigest()
    # Exclusive creation prevents a concurrent update replacing the bundle.
    with TARGET.open("xb") as destination:
        destination.write(bundle)
    with TARGET.with_suffix(".sha256").open("x", encoding="ascii") as destination:
        destination.write(f"{digest}  global-bundle.pem\n")
    print(f"Official RDS CA downloaded from {URL}")
    print(f"SHA256 {digest}; review certificate subjects/expiry and commit both files with provenance")


if __name__ == "__main__":
    main()
