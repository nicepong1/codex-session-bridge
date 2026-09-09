using System;
using System.IO;
using System.Linq;
using System.Net.WebSockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

// Transport only. There is no model runtime, command execution, or fallback CLI here.
internal static class GuardTransport
{
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    public static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--version") { Console.WriteLine("codex-gpu-guard 0.5.0"); return 0; }
        if (!args.Contains("app-server")) { Console.Error.WriteLine("Only app-server transport is supported."); return 64; }
        try { return Run().GetAwaiter().GetResult(); }
        catch { Console.Error.WriteLine("GPU guard connection unavailable. No local execution fallback."); return 2; }
    }
    private static async Task<int> Run()
    {
        Uri endpoint;
        if (!Uri.TryCreate(Environment.GetEnvironmentVariable("CODEX_GPU_GUARD_URL"), UriKind.Absolute, out endpoint) ||
            endpoint.Scheme != "ws" || endpoint.Host != "127.0.0.1" || endpoint.Port < 1 ||
            endpoint.UserInfo.Length != 0 || endpoint.Query.Length != 0 || endpoint.Fragment.Length != 0 ||
            !Regex.IsMatch(endpoint.AbsolutePath, "^/[a-f0-9]{64}$")) throw new InvalidOperationException();
        Console.InputEncoding = Utf8; Console.OutputEncoding = Utf8;
        using (var ws = new ClientWebSocket())
        using (var cancel = new CancellationTokenSource())
        {
            cancel.CancelAfter(5000);
            await ws.ConnectAsync(endpoint, cancel.Token);
            cancel.CancelAfter(Timeout.Infinite);
            // Console.In may implement ReadLineAsync synchronously; keep it off the receive loop.
            Task input = Task.Run(() => PumpInput(ws, cancel.Token)), output = PumpOutput(ws, cancel.Token);
            Task finished = await Task.WhenAny(input, output);
            cancel.Cancel(); ws.Abort();
            await finished;
            return 0;
        }
    }
    private static async Task PumpInput(ClientWebSocket ws, CancellationToken cancel)
    {
        string line;
        while ((line = await Console.In.ReadLineAsync()) != null)
        {
            if (line.Length > 1024 * 1024) throw new InvalidDataException();
            byte[] bytes = Utf8.GetBytes(line);
            if (bytes.Length > 1024 * 1024) throw new InvalidDataException();
            await ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, cancel);
        }
    }
    private static async Task PumpOutput(ClientWebSocket ws, CancellationToken cancel)
    {
        byte[] buffer = new byte[16384];
        using (var message = new MemoryStream())
        {
            while (true)
            {
                WebSocketReceiveResult result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), cancel);
                if (result.MessageType == WebSocketMessageType.Close) return;
                if (result.MessageType != WebSocketMessageType.Text || message.Length + result.Count > 32 * 1024 * 1024) throw new InvalidDataException();
                message.Write(buffer, 0, result.Count);
                if (!result.EndOfMessage) continue;
                await Console.Out.WriteLineAsync(Utf8.GetString(message.ToArray()));
                await Console.Out.FlushAsync(); message.SetLength(0);
            }
        }
    }
}
