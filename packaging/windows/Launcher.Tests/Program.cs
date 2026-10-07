using Hatcheck.Launcher;

if (args.Length == 2 && args[0] == "--validate-url")
{
    return ServerUrlPolicy.TryValidate(args[1], out _) ? 0 : 1;
}
if (args.Length != 0)
{
    Console.Error.WriteLine("Usage: Launcher.Tests [--validate-url HTTPS_ORIGIN]");
    return 1;
}

var valid = new[]
{
    "https://hatcheck.example.test",
    "https://hatcheck.example.test/",
    "HTTPS://hatcheck.example.test:443/",
    "https://inventory.corp.internal/",
    "https://inventory",
    "https://xn--bcher-kva.example.test/",
};

var invalid = new string?[]
{
    null, "", " https://hatcheck.example.test", "https://hatcheck.example.test ",
    "http://hatcheck.example.test", "file:///C:/Windows/System32/cmd.exe", "javascript:alert(1)",
    "https://user:password@hatcheck.example.test", "https://hatcheck.example.test?token=secret",
    "https://hatcheck.example.test/#redirect", "https://hatcheck.example.test/path",
    "https://hatcheck.example.test:8443", "https://localhost", "https://localhost.",
    "https://server.localhost", "https://127.0.0.1", "https://[::1]", "https://10.0.0.1",
    "https://2130706433", "https://-bad.example.test",
    "https://bad-.example.test", "https://bad..example.test", "https://bad_name.example.test",
    "https://hatcheck.example.test\\@evil.example.test", "https://hatcheck.example.test\n",
    "https://b\u00fccher.example.test", "https://hatcheck.example.test/../", "https://hatcheck.example.test/#",
    "https://hatcheck.example.test/?", new string('a', 2049),
};

var failures = new List<string>();
foreach (var value in valid)
{
    if (!ServerUrlPolicy.TryValidate(value, out var parsed) || parsed is null)
    {
        failures.Add($"Rejected valid server URL: {value}");
    }
}
foreach (var value in invalid)
{
    if (ServerUrlPolicy.TryValidate(value, out _))
    {
        failures.Add($"Accepted unsafe server URL: {value}");
    }
}
foreach (var failure in failures)
{
    Console.Error.WriteLine(failure);
}
Console.WriteLine($"Server URL policy: {valid.Length + invalid.Length} cases, {failures.Count} failures.");
return failures.Count == 0 ? 0 : 1;
