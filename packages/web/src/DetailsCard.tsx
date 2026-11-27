import { useState } from "react";
import { api, type Details } from "./api.ts";
import { ago, duration, gb, time } from "./format.ts";
import { expiresIn } from "./LoginCard.tsx";
import { BusyButton, CardHeader, Skeleton } from "./ui.tsx";
import { type Polled, useTick } from "./usePoll.ts";

/** What the instance says about itself: the main Claude Code session, auto-stop, load, memory, disk. */
export function DetailsCard({ details: polled, onRenewLogin }: { details: Polled<Details>; onRenewLogin: () => void }) {
  const [busy, setBusy] = useState<number>();
  const [message, setMessage] = useState<string>();
  const { data: details, error } = polled;
  // The countdown runs between loads (once a minute): the instance's clock at load time plus the time since.
  useTick(15_000);
  const now = details && polled.fetchedAt ? details.now + (Date.now() - polled.fetchedAt) / 1000 : (details?.now ?? 0);

  async function snooze(hours: number) {
    setBusy(hours);
    setMessage(undefined);
    try {
      setMessage((await api<{ output: string }>("POST", "/autostop/snooze", { hours })).output);
      void polled.reload();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  const a = details?.autostop;
  return (
    <section className={`card${polled.stale ? " stale" : ""}`} data-testid="details-card" aria-busy={polled.loading}>
      <CardHeader title="Auto-stop and load" polled={polled} />
      {error && <p className="error" role="alert">{error}</p>}
      {!details && !error && <Skeleton lines={5} label="Asking the instance" />}
      {details && (
        <>
          {a?.installed ? (
            <p className="stops" data-testid="autostop">
              {a.shutdownScheduled ? "Stops in " : "Stops in ~"}
              <strong>{duration(a.stopsAt - now)}</strong> (at {time(a.stopsAt)}), {a.reason}
              {a.snoozedUntil ? <span className="muted"> · snoozed until {time(a.snoozedUntil)}</span> : null}
            </p>
          ) : (
            <p className="muted">Auto-stop is not installed.</p>
          )}
          {a?.installed && (
            <div className="actions">
              <span className="muted">Snooze</span>
              {[1, 2, 4, 8].map((h) => (
                <BusyButton key={h} busy={busy === h} disabled={busy !== undefined} onClick={() => snooze(h)} data-testid={`snooze-${h}`}>
                  {h}h
                </BusyButton>
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
            {details.auth && (
              <>
                <dt>Claude login</dt>
                <dd data-testid="claude-login">
                  {details.auth.loggedIn === null
                    ? "unknown"
                    : !details.auth.loggedIn
                      ? "not logged in"
                      : details.auth.expiresAt
                        ? `expires ${expiresIn(details.auth.expiresAt, now)}`
                        : "logged in"}
                  {details.auth.loggedIn && (
                    <>
                      {" · "}
                      <button type="button" className="link" onClick={onRenewLogin} data-testid="renew-login">
                        renew
                      </button>
                    </>
                  )}
                </dd>
              </>
            )}
            {a?.installed && a.lastActivity && (
              <>
                <dt>Last activity</dt>
                <dd>{ago(a.lastActivity)}</dd>
              </>
            )}
            <dt>Up for</dt>
            <dd>{duration(now - details.bootTime)}</dd>
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
