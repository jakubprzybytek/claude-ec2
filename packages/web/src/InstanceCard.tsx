import { useState } from "react";
import { api, type Instance, type Status } from "./api.ts";
import { time } from "./format.ts";
import { BusyButton, CardHeader, Skeleton } from "./ui.tsx";
import type { Polled } from "./usePoll.ts";

const BADGE: Record<string, string> = { running: "ok", pending: "busy", stopping: "busy", stopped: "off" };

/** EC2 state and the actions on the instance itself: start, stop, resize. */
export function InstanceCard({ status, onChange }: { status: Polled<Status>; onChange: (instance: Instance) => void }) {
  const [busy, setBusy] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [type, setType] = useState("");
  const { data, error } = status;
  const i = data?.instance;

  async function act(action: string, body?: unknown, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(action);
    setActionError(undefined);
    try {
      onChange((await api<{ instance: Instance }>("POST", `/instance/${action}`, body)).instance);
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <section className={`card${status.stale ? " stale" : ""}`} data-testid="instance-card" aria-busy={status.loading}>
      <CardHeader title="Instance" polled={status}>
        {i && (
          <span className={`badge ${BADGE[i.state] ?? "off"}`} data-testid="instance-state">
            {i.state}
            {i.state === "running" && !data.ssmOnline ? " · connecting" : ""}
          </span>
        )}
      </CardHeader>
      {error && <p className="error" role="alert">{error}</p>}
      {!i && !error && <Skeleton lines={3} label="Loading the instance" />}
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
              <BusyButton className="primary" busy={busy === "start" || i.state === "pending"} busyText="Starting…" disabled={!!busy || status.stale} onClick={() => act("start")} data-testid="start">
                Start
              </BusyButton>
            )}
            {(i.state === "running" || i.state === "stopping") && (
              <BusyButton
                className="danger"
                busy={busy === "stop" || i.state === "stopping"}
                busyText="Stopping…"
                disabled={!!busy || status.stale}
                onClick={() => act("stop", undefined, "Stop the instance? Every Claude Code session on it ends (conversations are kept).")}
                data-testid="stop"
              >
                Stop
              </BusyButton>
            )}
            {i.state === "stopped" && (
              <span className="inline">
                <select value={type || i.type} onChange={(e) => setType(e.target.value)} aria-label="Instance type">
                  {data.instanceTypes.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
                <BusyButton busy={busy === "resize"} busyText="Resizing…" disabled={!!busy || status.stale || !type || type === i.type} onClick={() => act("resize", { type })}>
                  Resize
                </BusyButton>
              </span>
            )}
          </div>
          {actionError && <p className="error" role="alert">{actionError}</p>}
        </>
      )}
    </section>
  );
}
