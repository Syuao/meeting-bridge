using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading.Tasks;

public static class HostLauncher
{
    private static string Quote(string value)
    {
        if (value.Length == 0) return "\"\"";
        return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
    }

    public static int Main(string[] args)
    {
        const string nodePath = "__NODE__";
        const string bridgePath = "__BRIDGE__";
        var info = new ProcessStartInfo
        {
            FileName = nodePath,
            Arguments = Quote(bridgePath) + " " + string.Join(" ", args.Select(Quote)),
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        using (var child = Process.Start(info))
        {
            if (child == null) return 1;
            // Chrome keeps the native-host stdin pipe open for the entire session;
            // waiting for this copy task would deadlock shutdown after the bridge
            // process has already exited.
            _ = Task.Run(() => Console.OpenStandardInput().CopyTo(child.StandardInput.BaseStream));
            var output = Task.Run(() => child.StandardOutput.BaseStream.CopyTo(Console.OpenStandardOutput()));
            var error = Task.Run(() => child.StandardError.BaseStream.CopyTo(Console.OpenStandardError()));
            child.WaitForExit();
            try { child.StandardInput.Close(); } catch { }
            try { Task.WaitAll(new[] { output, error }, TimeSpan.FromSeconds(5)); } catch { }
            return child.ExitCode;
        }
    }
}
