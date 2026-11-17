import { useState } from "react";
import { api, type Details } from "./api.ts";
import { ago, duration, gb, time } from "./format.ts";

/** What the instance says about itself: the main Claude Code session, auto-stop, load, memory, disk. */
export function DetailsCard({ details, error, onChange }: { details: Details | undefined; error: string | undefined; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();

  async function snooze(hours: number) {
    setBusy(true);
    setMessage(undefined);
    try {
      setMessage((await api<{ output: string }>("POST", "/autostop/snooze", { hours })).output);
      onChange();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const a = details?.autostop;
  return (
    <section className="card" data-testid="details-card">
      <header>
        <h2>Auto-stop and load</h2>
      </header>
      {error && <p className="error" role="alert">{error}</p>}
      {!details && !error && <p className="muted">Asking the instance…</p>}
      {details && (
        <>
          {a?.installed ? (
            <p className="stops" data-testid="autostop">
              {a.shutdownScheduled ? "Stops in " : "Stops in ~"}
              <strong>{duration(a.stopsAt - details.now)}</strong> (at {time(a.stopsAt)}), {a.reason}
              {a.snoozedUntil ? <span className="muted"> · snoozed until {time(a.snoozedUntil)}</span> : null}
            </p>
          ) : (
            <p className="muted">Auto-stop is not installed.</p>
          )}
          {a?.installed && (
            <div className="actions">
              <span className="muted">Snooze</span>
              {[1, 2, 4, 8].map((h) => (
                <button type="button" key={h} disabled={busy} onClick={() => snooze(h)} data-testid={`snooze-${h}`}>
                  {h}h
                </button>
              ))}
            </div>
          )}
          {message && <p className="muted">{message}</p>}
          <dl className="facts">
            <dt>Main session</dt>
            <dd data-testid="main-session">
              {details.claude.running ? "running" : "missing"}
              {details.claude.clients ? `, ${details.claude.clients} attached` : ""}
            </dd>
            {a?.installed && a.lastActivity && (
              <>
                <dt>Last activity</dt>
                <dd>{ago(a.lastActivity)}</dd>
              </>
            )}
            <dt>Up for</dt>
            <dd>{duration(details.now - details.bootTime)}</dd>
            <dt>Load</dt>
            <dd>{details.load.map((l) => l.toFixed(2)).join(" · ")}</dd>
            <dt>Memory</dt>
            <dd>
              {gb(details.memory.total - details.memory.available)} of {gb(details.memory.total)}
            </dd>
            <dt>Disk</dt>
            <dd>
              {gb(details.disk.used)} of {gb(details.disk.total)}
            </dd>
          </dl>
        </>
      )}
    </section>
  );
}
