import { type FormEvent, useState } from "react";
import { api, type CommandResult } from "./api.ts";
import { BusyButton, CardHeader, Spinner } from "./ui.tsx";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs a command as ubuntu on the instance (like `claude-ec2 exec`) and shows its output. */
export function CommandCard() {
  const [command, setCommand] = useState("");
  const [result, setResult] = useState<CommandResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!command.trim()) return;
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      const { commandId } = await api<{ commandId: string }>("POST", "/commands", { command });
      for (let i = 0; i < 600; i++) {
        await sleep(i < 4 ? 500 : i < 10 ? 1000 : 2000);
        const r = await api<CommandResult>("GET", `/commands/${commandId}`);
        setResult(r);
        if (r.done) break;
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" data-testid="command-card">
      <CardHeader title="Run a command" />
      <form className="inline" onSubmit={submit}>
        <input className="mono grow" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="df -h; tmux ls" aria-label="Command" data-testid="command" />
        <BusyButton type="submit" busy={busy} busyText="Running…" disabled={!command.trim()}>
          Run
        </BusyButton>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
      {busy && !result && (
        <p className="muted small">
          <Spinner /> Sending…
        </p>
      )}
      {result && (
        <>
          <p className="muted small">
            {result.done ? (
              `${result.status}, exit ${result.exitCode}`
            ) : (
              <>
                <Spinner /> {result.status}
              </>
            )}
          </p>
          {(result.stdout || result.stderr) && (
            <pre className="output" data-testid="command-output">
              {result.stdout}
              {result.stderr && <span className="stderr">{result.stderr}</span>}
            </pre>
          )}
        </>
      )}
    </section>
  );
}
