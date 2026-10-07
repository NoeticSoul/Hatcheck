# Windows cloud client

This is an unsigned pilot MSI for a central Hatcheck HTTPS application. The
Windows executable opens that application in the default browser. It does not
start the Bun server, include a database, use AWS credentials, or connect to RDS.
Browser authentication, including configured OIDC, remains on the shared server.

Supported clients are Windows 10/11 x64. The launcher has an `asInvoker`
manifest; MSI installation needs administrator rights, ordinary launching does
not. The self-contained .NET 10 runtime is bundled, so users need no SDK/runtime.
Windows support and installer acceptance must be checked on real Windows;
cross-publishing the executable on Linux is not that acceptance.

## Build

Install the .NET SDK pinned in `global.json`. On Windows, from the repository root:

```powershell
pwsh -File scripts/package-windows.ps1 `
  -ServerUrl https://hatcheck.example.test `
  -Version 0.0.1 -OutputDirectory dist/windows
```

Use the actual AWS deployment's HTTPS origin when preparing the real package.
The example address is synthetic and does not provide a working deployment.
WiX 4.0.6 and its UI extension are restored at pinned versions. Downloads retain
normal TLS and NuGet validation. Outputs include the self-contained executable,
an unsigned MSI, SHA256SUMS, and a download README. The Apache license, project
notice, .NET runtime license/third-party notices, and WiX UI license are included
in the installer. WiX UI source is available at the pinned v4.0.6 source:
<https://github.com/wixtoolset/wix/tree/v4.0.6/src/ext/UI>.

The URL must be an ASCII HTTPS DNS origin, using port 443 and no subpath, query,
fragment, credentials, or localhost/literal IP. Company DNS through a VPN is
allowed. Use explicit punycode for international DNS names. This matches
Hatcheck's root-based UI/API routing; a reverse-proxy subpath is not supported.

## Configuration and upgrades

Configuration is the 64-bit machine registry string:
`HKLM\Software\Hatcheck\Cloud\ServerUrl`. An explicit installation property
takes precedence over the existing value; an upgrade otherwise preserves the
existing value, then falls back to the address packaged in the MSI.

```powershell
msiexec.exe /i Hatcheck-Cloud-0.0.1-win-x64-unsigned.msi /qn /norestart `
  HATCHECKSERVERURL=https://hatcheck.example.test
```

To retarget an existing same-version installation, add `REINSTALL=ALL` and
`REINSTALLMODE=vomus`. The launcher strictly validates the resulting value
before invoking the browser, including values changed through registry policy.
The MSI uses a basic URL launch condition without executing custom scripts.
Missing or malformed configuration produces a normal Windows error dialog.

The MSI installs to Program Files, adds Start menu and shared Desktop shortcuts,
supports repair, preserves configuration through major upgrades, and rejects
downgrades. MSI installation never launches the client as an elevated process.
Uninstall removes the client and machine configuration; browser profiles and
server data are retained because the installer never owns those locations.

## Validation

The policy harness requires no test-framework packages and runs on Linux or Windows:

```sh
dotnet run --project packaging/windows/Launcher.Tests/Launcher.Tests.csproj -c Release
```

Cross-publish from Linux with the pinned SDK:

```sh
dotnet publish packaging/windows/Launcher/Launcher.csproj -c Release -o dist/windows/launcher
```

Create version 0.0.1 and 0.0.2 installers, with distinct packaged URLs, then run
the actual MSI checks on an elevated, disposable Windows runner:

```powershell
pwsh -File packaging/windows/Test-Installer.ps1 `
  -MsiPath dist/windows/Hatcheck-Cloud-0.0.1-win-x64-unsigned.msi `
  -UpgradeMsiPath dist/windows/Hatcheck-Cloud-0.0.2-win-x64-unsigned.msi `
  -ServerUrl https://hatcheck.example.test
```

The harness refuses an existing installation. It checks install, actual launcher
configuration exit codes, GUI executable format, repair, explicit retargeting,
upgrade preservation, rejected downgrade, uninstall, and user-state retention.
It retains MSI logs and cleans up only its own installation/temporary sentinel.
It does not open an interactive browser or authenticate to a live AWS deployment.
Manual acceptance must also confirm browser launching, Windows error dialogs,
first-login behavior, and company device-management installation policy.

These artifacts are unsigned pilot builds. Signing, certificate ownership,
production Windows acceptance, and public release publication are separate
release steps; no signing identity or cloud credentials are embedded here.
