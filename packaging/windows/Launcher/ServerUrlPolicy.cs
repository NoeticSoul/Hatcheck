namespace Hatcheck.Launcher;

/// <summary>The client accepts a canonical HTTPS application origin, never a database URL.</summary>
public static class ServerUrlPolicy
{
    public static bool TryValidate(string? value, out Uri? serverUrl)
    {
        serverUrl = null;
        if (string.IsNullOrEmpty(value) || value.Length > 2048 || value != value.Trim())
        {
            return false;
        }

        // Require an ASCII URL. IDNs can be supplied using their explicit punycode DNS name.
        if (value.Any(character => character < 0x21 || character > 0x7e || character == '\\'))
        {
            return false;
        }

        if (!value.StartsWith("https://", StringComparison.OrdinalIgnoreCase)
            || value.IndexOfAny(['@', '?', '#']) >= 0)
        {
            return false;
        }
        var pathStart = value.IndexOf('/', "https://".Length);
        if (pathStart >= 0 && pathStart != value.Length - 1)
        {
            return false;
        }

        if (!Uri.TryCreate(value, UriKind.Absolute, out var parsed)
            || parsed.Scheme != Uri.UriSchemeHttps
            || parsed.HostNameType != UriHostNameType.Dns
            || !parsed.IsDefaultPort
            || !string.IsNullOrEmpty(parsed.UserInfo)
            || !string.IsNullOrEmpty(parsed.Query)
            || !string.IsNullOrEmpty(parsed.Fragment)
            || parsed.AbsolutePath != "/")
        {
            return false;
        }

        // Internal company DNS and VPN hosts are allowed. Localhost and literal IPs are not.
        var host = parsed.IdnHost.TrimEnd('.');
        if (host.Equals("localhost", StringComparison.OrdinalIgnoreCase)
            || host.EndsWith(".localhost", StringComparison.OrdinalIgnoreCase)
            || host.Length > 253
            || host.Split('.').Any(label => label.Length is < 1 or > 63
                || label[0] == '-' || label[^1] == '-'
                || label.Any(character => !char.IsAsciiLetterOrDigit(character) && character != '-')))
        {
            return false;
        }

        serverUrl = parsed;
        return true;
    }
}
