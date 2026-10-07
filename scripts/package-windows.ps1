#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ServerUrl,
    [string]$Version = '0.0.1',
    [string]$OutputDirectory = 'dist/windows',
    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'WiX MSI linking requires Windows. The launcher policy tests and Windows cross-publish can run on Linux.' }
if ($Version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') {
    throw 'Version must contain three integer components: major.minor.patch.'
}
$parsedVersion = [Version]$Version
if ($parsedVersion.Major -gt 255 -or $parsedVersion.Minor -gt 255 -or $parsedVersion.Build -gt 65535) {
    throw 'Windows MSI versions require major <= 255, minor <= 255, and patch <= 65535.'
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$packagingDirectory = Join-Path $repositoryRoot 'packaging/windows'
$output = if ([IO.Path]::IsPathRooted($OutputDirectory)) { $OutputDirectory } else { Join-Path $repositoryRoot $OutputDirectory }
$output = [IO.Path]::GetFullPath($output)
$publishDirectory = Join-Path $output "launcher-$Version"
$installerPath = Join-Path $output "Hatcheck-Cloud-$Version-win-x64-unsigned.msi"

function Invoke-Dotnet {
    param([string[]]$Arguments)
    & dotnet @Arguments
    if ($LASTEXITCODE -ne 0) { throw "dotnet failed ($LASTEXITCODE): $($Arguments -join ' ')" }
}

Push-Location $packagingDirectory
try {
    if ((& dotnet --version).Trim() -ne '10.0.401') { throw 'Install the SDK pinned in packaging/windows/global.json.' }
    Invoke-Dotnet -Arguments @('run', '--project', 'Launcher.Tests/Launcher.Tests.csproj', '-c', 'Release', '--', '--validate-url', $ServerUrl)
    if (-not $SkipTests) {
        Invoke-Dotnet -Arguments @('run', '--project', 'Launcher.Tests/Launcher.Tests.csproj', '-c', 'Release')
    }
    New-Item -ItemType Directory -Path $output -Force | Out-Null
    Invoke-Dotnet -Arguments @('publish', 'Launcher/Launcher.csproj', '-c', 'Release', '-o', $publishDirectory,
        "-p:Version=$Version", "-p:FileVersion=$Version.0")
    $licenseRtf = Join-Path $output 'LICENSE.rtf'
    $license = [IO.File]::ReadAllText((Join-Path $repositoryRoot 'LICENSE'))
    $escapedLicense = $license.Replace('\', '\\').Replace('{', '\{').Replace('}', '\}').Replace("`r", '').Replace("`n", '\par ')
    [IO.File]::WriteAllText($licenseRtf, '{\rtf1\ansi\deff0{\fonttbl{\f0 Consolas;}}\f0\fs16 ' + $escapedLicense + '}', [Text.Encoding]::ASCII)
    $pilotNotice = Join-Path $output 'PILOT-NOTICE.txt'
    [IO.File]::WriteAllText($pilotNotice, @"
Hatcheck Cloud $Version - UNSIGNED PILOT BUILD

This client opens $ServerUrl in your default browser.
The shared server holds the inventory database. This client does not run a local
server, contain database or AWS credentials, or store inventory data.
The executable and MSI are unsigned test artifacts. Production code signing and
clean-machine acceptance are required before public distribution.
Server address: HKLM\Software\Hatcheck\Cloud\ServerUrl (64-bit registry).
Uninstalling the client leaves browser profiles and all server data untouched.
"@, [Text.Encoding]::ASCII)
    Invoke-Dotnet -Arguments @('tool', 'restore')
    Invoke-Dotnet -Arguments @('tool', 'run', 'wix', '--', 'extension', 'add', 'WixToolset.UI.wixext/4.0.6')
    Invoke-Dotnet -Arguments @('tool', 'run', 'wix', '--', 'build', 'Installer.wxs', '-arch', 'x64',
        '-ext', 'WixToolset.UI.wixext/4.0.6', '-d', "ProductVersion=$Version", '-d', "ServerUrl=$ServerUrl",
        '-d', "PublishDirectory=$publishDirectory", '-d', "RepositoryRoot=$repositoryRoot", '-d', "LicenseRtf=$licenseRtf",
        '-d', "PilotNotice=$pilotNotice", '-o', $installerPath)
    $checksum = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText("$installerPath.sha256", "$checksum  $([IO.Path]::GetFileName($installerPath))`n", [Text.Encoding]::ASCII)
    $launcherHash = (Get-FileHash -LiteralPath (Join-Path $publishDirectory 'Hatcheck.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText((Join-Path $output 'SHA256SUMS'),
        "$checksum  $([IO.Path]::GetFileName($installerPath))`n$launcherHash  launcher-$Version/Hatcheck.exe`n", [Text.Encoding]::ASCII)
    [IO.File]::WriteAllText((Join-Path $output 'README.txt'), @"
Hatcheck Cloud $Version - UNSIGNED PILOT BUILD

Install Hatcheck-Cloud-$Version-win-x64-unsigned.msi on Windows 10/11 x64,
then open Hatcheck from the Start menu or desktop. Administrator rights are
required for installation; ordinary launching opens the default web browser.

Packaged server address: $ServerUrl
An existing managed address is preserved during upgrade unless explicitly
overridden with the public HATCHECKSERVERURL MSI property.

The shared HTTPS server contains the application and database. This download
does not start a local server or contain database or AWS credentials.
The executable and installer are unsigned pilot artifacts. Validate the
publisher, checksums, deployment address, and Windows acceptance before use.
SHA256SUMS contains SHA-256 hashes for the MSI and launcher executable.
Uninstalling preserves browser state and all shared server data.
"@, [Text.Encoding]::ASCII)
    Write-Output "Built unsigned pilot MSI: $installerPath"
} finally {
    Pop-Location
}
