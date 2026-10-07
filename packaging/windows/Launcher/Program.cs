using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Microsoft.Win32;

namespace Hatcheck.Launcher;

[SupportedOSPlatform("windows")]
internal static class Program
{
    private const string RegistryPath = @"Software\Hatcheck\Cloud";
    private const string WindowTitle = "Hatcheck - unsigned pilot build";

    [STAThread]
    private static int Main(string[] args)
    {
        // A headless mode lets installer checks exercise the actual published executable.
        var checkOnly = args.Length == 1 && args[0] == "--check-config";
        if (args.Length > 0 && !checkOnly)
        {
            return 2;
        }

        try
        {
            using var machine = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);
            using var configuration = machine.OpenSubKey(RegistryPath, writable: false);
            var configuredUrl = configuration?.GetValue("ServerUrl", null,
                RegistryValueOptions.DoNotExpandEnvironmentNames) as string;

            if (!ServerUrlPolicy.TryValidate(configuredUrl, out var serverUrl))
            {
                if (!checkOnly)
                {
                    ShowError("Hatcheck does not have a valid HTTPS server address.\n\n"
                        + "Ask your IT administrator to repair the Hatcheck Cloud installation with the correct address. "
                        + "This client does not start a local server or store the inventory database.");
                }
                return 2;
            }

            if (checkOnly)
            {
                return 0;
            }

            Process.Start(new ProcessStartInfo(serverUrl!.AbsoluteUri) { UseShellExecute = true });
            return 0;
        }
        catch (Exception error) when (error is System.ComponentModel.Win32Exception
            or UnauthorizedAccessException or System.Security.SecurityException or IOException)
        {
            if (!checkOnly)
            {
                ShowError("Windows could not open Hatcheck.\n\n"
                    + "Check that a default web browser is installed and contact your IT administrator if this continues.");
            }
            return 3;
        }
    }

    private static void ShowError(string message)
    {
        _ = MessageBox(IntPtr.Zero, message, WindowTitle, 0x00000010);
    }

    [DllImport("user32.dll", EntryPoint = "MessageBoxW", CharSet = CharSet.Unicode)]
    private static extern int MessageBox(IntPtr window, string text, string caption, uint type);
}
