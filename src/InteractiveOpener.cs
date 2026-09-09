using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

// One authenticated local pipe, one owning worker, bounded lifetime.
// The only action is opening the fixed Codex URI for a validated task UUID.
internal static class InteractiveOpener
{
    private static readonly Regex Uuid = new Regex("^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$");
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint processId);
    public static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--version") { Console.WriteLine("codex-interactive-opener 0.9.0"); return 0; }
        int parentId, seconds;
        if (args.Length != 3 || !Regex.IsMatch(args[0], "^[a-f0-9]{64}$") ||
            !Int32.TryParse(args[1], out parentId) || !Int32.TryParse(args[2], out seconds) || seconds < 10 || seconds > 3600) return 64;
        string stage = "session";
        try
        {
            if (Process.GetCurrentProcess().SessionId == 0) return 65;
            using (var lifetime = new Timer(_ => Environment.Exit(0), null, seconds * 1000, Timeout.Infinite))
            {
                stage = "pipe";
                var security = new PipeSecurity();
                security.SetAccessRuleProtection(true, false);
                security.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User, PipeAccessRights.FullControl, AccessControlType.Allow));
                using (var pipe = new NamedPipeServerStream("codex-open-" + args[0], PipeDirection.InOut, 1,
                    PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 4096, 4096, security))
                {
                    var connected = pipe.BeginWaitForConnection(null, null);
                    stage = "connect";
                    if (!connected.AsyncWaitHandle.WaitOne(15000)) return 2;
                    pipe.EndWaitForConnection(connected);
                    uint clientPid;
                    stage = "client-identity";
                    if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle, out clientPid) || clientPid != (uint)parentId) return 65;
                    // The operating system closes this sole pipe when the worker
                    // exits. No cross-session Process access/elevation is needed.
                    using (var output = new StreamWriter(pipe, new UTF8Encoding(false), 1024, true))
                    {
                        output.AutoFlush = true;
                        output.WriteLine("READY 0.9.0 " + Process.GetCurrentProcess().Id);
                        var line = new StringBuilder();
                        int next;
                        while ((next = pipe.ReadByte()) != -1)
                        {
                            if (next == 10)
                            {
                                string id = line.ToString(); line.Clear();
                                if (id == "PING") { output.WriteLine("PONG"); continue; }
                                if (!Uuid.IsMatch(id)) return 64;
                                try
                                {
                                    using (var opened = Process.Start(new ProcessStartInfo("codex://threads/" + id) { UseShellExecute = true })) { }
                                    output.WriteLine("OPENED " + id);
                                }
                                catch { output.WriteLine("FAILED " + id); }
                            }
                            else
                            {
                                if (next < 32 || next > 126 || line.Length >= 64) return 64;
                                line.Append((char)next);
                            }
                        }
                    }
                }
            }
            return 0;
        }
        catch (Exception error)
        {
            try
            {
                string directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CodexSessionBridge", "bin");
                File.WriteAllText(Path.Combine(directory, "opener-failure-" + args[0] + ".txt"), stage + ":" + error.GetType().Name);
            }
            catch { }
            return 2;
        }
    }
}
