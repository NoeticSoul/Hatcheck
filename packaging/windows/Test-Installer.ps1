#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$MsiPath,
    [Parameter(Mandatory = $true)][string]$UpgradeMsiPath,
    [Parameter(Mandatory = $true)][string]$ServerUrl,
    [string]$LogDirectory = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows -or -not [Environment]::Is64BitProcess) { throw 'Use 64-bit PowerShell on a dedicated Windows test machine.' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Installer smoke checks require an elevated test runner.' }
$MsiPath = (Resolve-Path -LiteralPath $MsiPath).Path
$UpgradeMsiPath = (Resolve-Path -LiteralPath $UpgradeMsiPath).Path
if (-not $LogDirectory) { $LogDirectory = Join-Path (Split-Path -Parent $MsiPath) 'installer-test-logs' }
New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
$LogDirectory = [IO.Path]::GetFullPath($LogDirectory)

$registryPath = 'Software\Hatcheck\Cloud'
$installDirectory = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'Hatcheck Cloud'
$launcher = Join-Path $installDirectory 'Hatcheck.exe'
$startShortcut = Join-Path ([Environment]::GetFolderPath('CommonPrograms')) 'Hatcheck/Hatcheck.lnk'
$desktopShortcut = Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'Hatcheck.lnk'
$userState = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) "Hatcheck/installer-tests/$([Guid]::NewGuid())/keep.txt"

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Open-Configuration {
    param([switch]$Writable)
    $machine = [Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine', 'Registry64')
    try { return $machine.OpenSubKey($registryPath, $Writable.IsPresent) } finally { $machine.Dispose() }
}

function Get-ServerUrl {
    $configuration = Open-Configuration
    if ($null -eq $configuration) { return $null }
    try { return $configuration.GetValue('ServerUrl', $null, 'DoNotExpandEnvironmentNames') } finally { $configuration.Dispose() }
}

function Get-MsiProperty {
    param([string]$Path, [string]$Name)
    if ($Name -notmatch '^[A-Za-z0-9_]+$') { throw 'Invalid MSI property query.' }
    $installer = New-Object -ComObject WindowsInstaller.Installer
    $database = $installer.OpenDatabase($Path, 0)
    $query = 'SELECT `Value` FROM `Property` WHERE `Property` = ''' + $Name + ''''
    $view = $database.OpenView($query)
    $view.Execute()
    try {
        $record = $view.Fetch()
        if ($null -eq $record) { return $null }
        return $record.StringData(1)
    } finally {
        $view.Close()
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($view)
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($database)
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($installer)
    }
}

function Invoke-Msi {
    param([string]$Step, [string[]]$MsiArguments, [int[]]$ExpectedExitCodes = @(0))
    $log = Join-Path $LogDirectory "$Step.log"
    $info = [Diagnostics.ProcessStartInfo]::new('msiexec.exe')
    $info.UseShellExecute = $false
    foreach ($argument in ($MsiArguments + @('/qn', '/norestart', '/l*v', $log))) { $info.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::Start($info)
    try {
        if (-not $process.WaitForExit(180000)) { $process.Kill(); throw "Installer timed out: $Step. See $log" }
        if ($process.ExitCode -notin $ExpectedExitCodes) { throw "Installer failed: $Step, exit $($process.ExitCode). See $log" }
    } finally { $process.Dispose() }
}

function Assert-Launcher {
    param([int]$ExpectedExitCode = 0)
    $process = Start-Process -FilePath $launcher -ArgumentList '--check-config' -PassThru
    try {
        if (-not $process.WaitForExit(30000)) { $process.Kill(); throw 'Launcher configuration check timed out.' }
        Assert-True ($process.ExitCode -eq $ExpectedExitCode) "Launcher exit $($process.ExitCode), expected $ExpectedExitCode."
    } finally { $process.Dispose() }
}

Assert-True (-not (Test-Path -LiteralPath $installDirectory)) 'Refusing to modify an existing Hatcheck installation. Use a disposable runner.'
$configuration = Open-Configuration
if ($null -ne $configuration) { $configuration.Dispose(); throw 'Refusing to modify existing Hatcheck registry configuration.' }
$upgradeCode = Get-MsiProperty -Path $MsiPath -Name 'UpgradeCode'
Assert-True ($upgradeCode -eq (Get-MsiProperty -Path $UpgradeMsiPath -Name 'UpgradeCode')) 'Upgrade codes differ.'
Assert-True ((Get-MsiProperty -Path $MsiPath -Name 'ProductCode') -ne (Get-MsiProperty -Path $UpgradeMsiPath -Name 'ProductCode')) 'Upgrade needs a distinct product code.'
Assert-True ([Version](Get-MsiProperty -Path $UpgradeMsiPath -Name 'ProductVersion') -gt [Version](Get-MsiProperty -Path $MsiPath -Name 'ProductVersion')) 'Upgrade version must be greater.'
Assert-True ((Get-MsiProperty -Path $MsiPath -Name 'ALLUSERS') -eq '1') 'Installer must use the per-machine context.'

New-Item -ItemType Directory -Path (Split-Path -Parent $userState) -Force | Out-Null
[IO.File]::WriteAllText($userState, 'installer must preserve user state')
try {
    Invoke-Msi -Step 'reject-http' -MsiArguments @('/i', $MsiPath, 'HATCHECKSERVERURL=http://invalid.example.test') -ExpectedExitCodes @(1603)
    Assert-True (-not (Test-Path -LiteralPath $launcher)) 'Invalid installation left an executable behind.'
    Invoke-Msi -Step 'install' -MsiArguments @('/i', $MsiPath)
    Assert-True ((Get-ServerUrl) -eq $ServerUrl) 'Packaged server address was not installed.'
    Assert-True (Test-Path -LiteralPath $startShortcut) 'Start menu shortcut missing.'
    Assert-True (Test-Path -LiteralPath $desktopShortcut) 'Desktop shortcut missing.'
    foreach ($name in @('LICENSE', 'NOTICE', 'DOTNET-LICENSE.txt', 'DOTNET-THIRD-PARTY-NOTICES.txt', 'WIX-LICENSE.txt')) {
        Assert-True (Test-Path -LiteralPath (Join-Path $installDirectory $name)) "Missing attribution file: $name"
    }
    Assert-Launcher

    $executable = [IO.File]::ReadAllBytes($launcher)
    $peOffset = [BitConverter]::ToInt32($executable, 0x3c)
    Assert-True ([BitConverter]::ToUInt16($executable, $peOffset + 24 + 68) -eq 2) 'Launcher must use the GUI subsystem, without a console.'
    $configuration = Open-Configuration -Writable
    try {
        $configuration.SetValue('ServerUrl', 'http://invalid.example.test', 'String')
        Assert-Launcher -ExpectedExitCode 2
        $configuration.DeleteValue('ServerUrl')
        Assert-Launcher -ExpectedExitCode 2
        $configuration.SetValue('ServerUrl', $ServerUrl, 'String')
    } finally { $configuration.Dispose() }

    Remove-Item -LiteralPath $launcher
    Invoke-Msi -Step 'repair' -MsiArguments @('/fa', $MsiPath)
    Assert-Launcher
    Assert-True ((Get-ServerUrl) -eq $ServerUrl) 'Repair changed the server address.'

    $managedUrl = 'https://managed.inventory.example.test/'
    Invoke-Msi -Step 'retarget' -MsiArguments @('/i', $MsiPath, 'REINSTALL=ALL', 'REINSTALLMODE=vomus', "HATCHECKSERVERURL=$managedUrl")
    Assert-True ((Get-ServerUrl) -eq $managedUrl) 'Explicit managed address did not take precedence.'
    Assert-Launcher
    Invoke-Msi -Step 'upgrade' -MsiArguments @('/i', $UpgradeMsiPath)
    Assert-True ((Get-ServerUrl) -eq $managedUrl) 'Upgrade replaced the existing managed address.'
    Assert-Launcher
    Assert-True ([IO.File]::ReadAllText($userState) -eq 'installer must preserve user state') 'Upgrade changed user state.'
    Invoke-Msi -Step 'reject-downgrade' -MsiArguments @('/i', $MsiPath) -ExpectedExitCodes @(1603, 1638)
    Assert-True ((Get-ServerUrl) -eq $managedUrl) 'Rejected downgrade changed configuration.'

    Invoke-Msi -Step 'uninstall' -MsiArguments @('/x', $UpgradeMsiPath)
    Assert-True (-not (Test-Path -LiteralPath $launcher)) 'Uninstall left the launcher behind.'
    Assert-True (-not (Test-Path -LiteralPath $startShortcut)) 'Uninstall left the Start menu shortcut behind.'
    Assert-True (-not (Test-Path -LiteralPath $desktopShortcut)) 'Uninstall left the desktop shortcut behind.'
    Assert-True ($null -eq (Get-ServerUrl)) 'Uninstall left machine configuration behind.'
    Assert-True ([IO.File]::ReadAllText($userState) -eq 'installer must preserve user state') 'Uninstall changed user state.'
    Write-Output 'Installer checks passed: install, URL policy, repair, retarget, upgrade, downgrade rejection, uninstall, and user-state preservation.'
} finally {
    foreach ($path in @($UpgradeMsiPath, $MsiPath)) {
        try { Invoke-Msi -Step ("cleanup-" + [IO.Path]::GetFileNameWithoutExtension($path)) -MsiArguments @('/x', $path) -ExpectedExitCodes @(0, 1605, 1614) } catch { Write-Warning $_ }
    }
    if (Test-Path -LiteralPath $userState) { Remove-Item -LiteralPath $userState }
    if (Test-Path -LiteralPath (Split-Path -Parent $userState)) { Remove-Item -LiteralPath (Split-Path -Parent $userState) }
}
