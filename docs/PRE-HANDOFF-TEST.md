# Review Hatcheck before the sysadmin handoff

You can review the application without an AWS account. Start with a fresh local
SQLite database, then optionally test the MSI against a local HTTPS site on
Windows. AWS account networking, RDS and company SSO still need acceptance on
the actual deployment.

Use the current review source package, extracted into a new folder, or a fresh
GitHub checkout containing this guide and `packaging/windows/Installer.wxs`.
The review ZIP contains source and build instructions, with no node_modules,
databases, environment secrets, Terraform state or AWS keys.

## 1. Review the application locally

On Windows, install [Bun](https://bun.com/docs/installation) and open PowerShell
in the extracted source folder containing `package.json`. Bun 1.3.14 is the
version used for the recorded checks. This trial uses Bun's built-in SQLite
and password implementation, so Node native-addon builds are unnecessary.

```powershell
bun install --frozen-lockfile --ignore-scripts
bun run build

$env:NODE_ENV = "production"
$env:HATCHECK_DB = "sqlite"
$env:HATCHECK_SQLITE_PATH = "./data/review.db"
$env:HATCHECK_SKIP_MIGRATIONS = "false"
$env:HATCHECK_SKIP_BOOTSTRAP = "false"
$env:HATCHECK_INIT_ADMIN_EMAIL = "admin@hatcheck.test"
$env:PORT = "3000"
$env:APP_URL = "http://localhost:3000"

# Keep this fresh trial independent of inherited cloud/SSO settings.
"HATCHECK_SEED_ADMIN_PASSWORD", "OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_REDIRECT_URI", "OIDC_AUTO_PROVISION", "OIDC_ALLOWED_EMAIL_DOMAINS" | ForEach-Object {
    Remove-Item -LiteralPath "Env:$_" -ErrorAction SilentlyContinue
}
bun run start
```

Open <http://localhost:3000>. Sign in as `admin@hatcheck.test` with the generated
password printed once in the server terminal. Keep the terminal running. A
fresh installation starts empty; do not point this review at a real database.
The server may listen on other interfaces: no Windows firewall exception is
needed for this localhost review. Keep external access blocked.

If port 3000 is occupied, choose another port and change `APP_URL` to match.
Press Ctrl+C to stop. Restart with `bun run start` in the same terminal to
retain settings and verify the review data persists. Keep your test password;
the initial password is not printed again for an existing database.

## 2. Manual application checklist

Use invented people and inventory only. Record pass/fail and any reproduction
steps before handing the results to the sysadmin.

- [ ] Create a location and a manual asset with tag `REVIEW-MANUAL-001`.
- [ ] Check that asset out, then check it in. Confirm both events remain in
      custody history and the current holder/status update correctly.
- [ ] Import [review-assets.csv](fixtures/review-assets.csv). Preview first,
      inspect the two valid rows, commit, and view the saved import report.
- [ ] Reimport the same CSV. Confirm no duplicate assets are created.
- [ ] Create a technician and readonly user through Users. Check each role
      in a separate browser profile; readonly users cannot change inventory.
- [ ] Inspect Audit for the actor and before/after state of your changes.
- [ ] Create `SOP-TEST-001`, complete purpose, scope, prerequisites, procedure,
      verification and escalation, and publish revision 1 as administrator.
- [ ] Save revision 2 as a draft. Confirm the readonly user still sees only
      published revision 1 and cannot access the private draft.
- [ ] Set a past review date such as `2000-01-01`, publish it, and confirm the
      overdue review flag/dashboard link appears.
- [ ] Export a selected revision as Markdown, HTML and DOCX. Open the DOCX in
      Word and complete the [manual standards checklist](SOP-STANDARDS.md).
- [ ] Restart the server and confirm users, inventory, custody, imports and
      document revisions remain. Check logout and password change as well.

## 3. Optional: test the real MSI locally on Windows

The cloud MSI only opens a configured HTTPS site. It does not start the local
review server. The sample URL in packaging documentation is not a live service,
and `http://localhost:3000` is intentionally rejected by the launcher.

To exercise the actual shortcut before AWS exists, use a loopback HTTPS test
site named `hatcheck.test`. This requires Windows administrator permission for
the hosts entry, certificate trust and MSI installation, plus PowerShell 7,
the .NET SDK pinned in `packaging/windows/global.json`, and
[Caddy](https://caddyserver.com/docs/install). Use a disposable Windows VM if
your company device restricts these changes.

1. Add this one line to the Windows hosts file using an elevated editor:
   `127.0.0.1 hatcheck.test`. The file is
   `C:\Windows\System32\drivers\etc\hosts`; preserve its other entries.
2. Stop the review backend with Ctrl+C. In its original terminal, set
   `$env:PORT = "3000"` and `$env:APP_URL = "https://hatcheck.test"`, then run
   `bun run start` again. If port 3000 is unavailable, change the Caddyfile's
   `reverse_proxy` port to your chosen backend port instead.
3. In another normal-user terminal in the source folder, run:

   ```powershell
   caddy run --config packaging/windows/Caddyfile.test --adapter caddyfile
   ```

   The proxy binds to loopback port 443 and keeps its temporary test CA/storage
   under this extracted folder's `data/msi-https`. It does not publish a service.
4. With Caddy still running, use an elevated terminal to trust this test CA:

   ```powershell
   caddy trust --address 127.0.0.1:2029
   ```

   Open <https://hatcheck.test> and confirm login works without a certificate
   warning. Do not bypass certificate validation. The Caddy admin address is
   loopback-only and reserved for this test instance.
5. Build the installer from the source folder:

   ```powershell
   pwsh -File scripts/package-windows.ps1 -ServerUrl https://hatcheck.test -Version 0.0.1 -OutputDirectory dist/windows
   ```

   Install `dist/windows/Hatcheck-Cloud-0.0.1-win-x64-unsigned.msi`. The artifact
   is unsigned; your Windows/device policy determines whether it can run.
   Open Hatcheck through its Start menu and desktop shortcuts. Confirm a normal
   user can launch it, the browser reaches the test site, and your review data
   is still present.
6. Check Repair, then uninstall the client. Confirm shortcuts are removed and
   the backend's review database remains. Automated two-version installer
   checks are documented in [Windows MSI delivery](WINDOWS-MSI.md) and run on a
   dedicated Windows CI runner; the harness refuses existing installations.
7. Clean up the HTTPS test: while Caddy is running, remove its test trust with
   elevated `caddy untrust --address 127.0.0.1:2029`. Remove only the hosts line
   you added, then stop Caddy and the review backend. Keep the isolated review
   folder if you want its test records; do not hand its passwords/database/CA
   private keys to others.

This proves the application and launcher workflow locally. It does not verify
the organization's AWS permissions, network, RDS instance, certificates or SSO.
The sysadmin handoff remains [infra/aws/README.md](../infra/aws/README.md).
