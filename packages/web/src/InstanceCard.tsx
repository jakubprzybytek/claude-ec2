import { useState } from "react";
import { api, type Instance, type Status } from "./api.ts";
import { time } from "./format.ts";

const BADGE: Record<string, string> = { running: "ok", pending: "busy", stopping: "busy", stopped: "off" };

/** EC2 state and the actions on the instance itself: start, stop, resize. */
export function InstanceCard({ status, error, onChange }: { status: Status | undefined; error: string | undefined; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [type, setType] = useState("");
  const i = status?.instance;

  async function act(path: string, body?: unknown, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    setActionError(undefined);
    try {
      await api<{ instance: Instance }>("POST", path, body);
      onChange();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" data-testid="instance-card">
      <header>
        <h2>Instance</h2>
        {i && (
          <span className={`badge ${BADGE[i.state] ?? "off"}`} data-testid="instance-state">
            {i.state}
            {i.state === "running" && !status.ssmOnline ? " · connecting" : ""}
          </span>
        )}
      </header>
      {error && <p className="error" role="alert">{error}</p>}
      {!i && !error && <p className="muted">Loading…</p>}
      {i && (
        <>
          <dl className="facts">
            <dt>ID</dt>
            <dd className="mono">{i.id}</dd>
            <dt>Type</dt>
            <dd data-testid="instance-type">{i.type}</dd>
            <dt>Zone</dt>
            <dd>{i.zone}</dd>
            {i.state === "running" && i.launchTime && (
              <>
                <dt>Started</dt>
                <dd>{time(Date.parse(i.launchTime) / 1000)}</dd>
              </>
            )}
          </dl>
          <div className="actions">
            {(i.state === "stopped" || i.state === "pending") && (
              <button type="button" className="primary" disabled={busy || i.state === "pending"} onClick={() => act("/instance/start")} data-testid="start">
                {i.state === "pending" ? "Starting…" : "Start"}
              </button>
            )}
            {(i.state === "running" || i.state === "stopping") && (
              <button
                type="button"
                className="danger"
                disabled={busy || i.state === "stopping"}
                onClick={() => act("/instance/stop", undefined, "Stop the instance? Every Claude Code session on it ends (conversations are kept).")}
                data-testid="stop"
              >
                {i.state === "stopping" ? "Stopping…" : "Stop"}
              </button>
            )}
            {i.state === "stopped" && (
              <span className="inline">
                <select value={type || i.type} onChange={(e) => setType(e.target.value)} aria-label="Instance type">
                  {status.instanceTypes.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
                <button type="button" disabled={busy || !type || type === i.type} onClick={() => act("/instance/resize", { type })}>
                  Resize
                </button>
              </span>
            )}
          </div>
          {actionError && <p className="error" role="alert">{actionError}</p>}
        </>
      )}
    </section>
  );
}
