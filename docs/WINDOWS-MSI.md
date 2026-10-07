# Windows MSI for the shared Hatcheck server

The installer delivers a small Windows launcher, a Start menu shortcut and a
desktop shortcut. Opening Hatcheck starts the default browser at the company's
configured HTTPS address. The inventory, accounts and document revisions live
on the central server. Windows clients run no Hatcheck listener, SQLite database
or PostgreSQL connection and contain no AWS/database credentials.

This is an unsigned pilot delivery path authorized separately from later imaging
and connector work. It requires access to the server over the internet or the
company network/VPN. It does not provide offline inventory access.

## Prepare the shared server

Follow [AWS deployment](../infra/aws/README.md) to review the ECS Fargate/private
RDS configuration. Choose the AWS region, DNS name, validated ACM certificate,
allowed client networks and initial administrator. Provisioning creates billed
AWS resources and requires a reviewed Terraform plan; the repository's tests
and build jobs never create them. Verify login and readiness over HTTPS before
distributing a launcher for that address.

The launcher accepts an HTTPS DNS origin on port 443, with an optional final
slash. It rejects credentials, query strings, fragments, localhost, literal IP
addresses and subpaths. Company DNS names reached through a VPN are supported.
Use the application's canonical origin, matching its `APP_URL`.

## Build on Windows

Requires 64-bit Windows, PowerShell 7 and the .NET SDK version pinned in
`packaging/windows/global.json`. The build restores the pinned WiX tool locally
and publishes a self-contained launcher; end-user PCs do not need .NET or Bun.

```powershell
./scripts/package-windows.ps1 -ServerUrl https://hatcheck.example.test -Version 0.0.1 -OutputDirectory dist/windows
```

Replace the example with your deployed URL. Outputs include the versioned MSI,
its SHA-256 manifest and a pilot notice. The Apache license and attribution are
installed with the launcher. Build outputs are ignored by Git.

The CI Windows job is gated on application tests and dependency audit. It builds
two versions and runs installation, invalid-URL rejection, repair, URL retarget,
upgrade, downgrade refusal and uninstall checks against the real MSI and
published GUI executable. It uploads the verified package as
`hatcheck-windows-msi-unsigned`. Set the repository `HATCHECK_SERVER_URL` variable
or supply `server_url` when manually running CI. Unconfigured push/PR builds use
a synthetic test address and are not ready for staff deployment.

## Install and configure

Double-click the MSI and follow the installer. Installation requires administrator
permission because it installs under Program Files and adds machine-wide
configuration. Launching the installed shortcut uses ordinary user permissions;
the installer does not start a browser under its elevated account.

For managed deployment or to override the packaged URL:

```powershell
msiexec.exe /i .\Hatcheck-Cloud-0.0.1-win-x64-unsigned.msi HATCHECKSERVERURL="https://hatcheck.example.test" /qn /norestart
```

The public server address is stored in the 64-bit registry at
`HKLM\Software\Hatcheck\Cloud\ServerUrl`. A supplied installer property wins over
existing configuration; an upgrade without that property preserves the current
address. Installing a newer MSI upgrades the client; older versions are refused.
Server upgrades and data migrations are managed centrally, independently of
launcher updates. Uninstall removes the client and shortcuts; it leaves server
data and the user's browser profile untouched.

If the address is missing or malformed, the launcher displays an error directing
the user to IT. If the server is unreachable, the browser reports the connection
problem. Internet connectivity, DNS, VPN and server availability remain necessary.

## Verify and release

Check the installer hash against `SHA256SUMS` using `Get-FileHash -Algorithm SHA256`.
Hashes establish integrity; they do not provide publisher identity. The current
MSI and launcher are unsigned and can trigger SmartScreen or organization policy.
Choose an approved signing service/certificate and sign both artifacts before
public distribution. Keep signing keys outside source control and build inputs.

Linux validation cross-compiles the Windows executable and exercises the URL
policy. MSI linking and real install/upgrade behavior require Windows. Do not
claim those Windows checks passed until the CI job or a clean Windows test
machine has actually completed them. Test interactive launch, standard-user
permissions and company deployment policy on a Windows 11 pilot before rollout.
