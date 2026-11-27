import { useCallback, useEffect, useState } from "react";
import { APP_VERSION, api, type CostsAnswer, type Details, type Instance, type Session, type Status } from "./api.ts";
import { currentSession, logout, type Session as UserSession } from "./auth.ts";
import { CommandCard } from "./CommandCard.tsx";
import { COSTS_CACHE_KEY, costsFresh } from "./costsCache.ts";
import { CostsCard } from "./CostsCard.tsx";
import { DetailsCard } from "./DetailsCard.tsx";
import { InstanceCard } from "./InstanceCard.tsx";
import { LoginCard } from "./LoginCard.tsx";
import { LoginForm } from "./LoginForm.tsx";
import { SessionsCard } from "./SessionsCard.tsx";
import { Spinner } from "./ui.tsx";
import { clearCache, usePoll } from "./usePoll.ts";

export function App() {
  const [user, setUser] = useState<UserSession | null | undefined>(undefined);
  const check = useCallback(() => currentSession().then(setUser), []);
  useEffect(() => void check(), [check]);

  if (user === undefined)
    return (
      <div className="splash">
        <Spinner label="Signing in" />
      </div>
    );
  if (user === null) return <LoginForm onSignedIn={check} />;
  return (
    <Dashboard
      email={user.email}
      onLogout={() => {
        clearCache();
        void logout().then(() => setUser(null));
      }}
    />
  );
}

function Dashboard({ email, onLogout }: { email: string; onLogout: () => void }) {
  // EC2 state: often while it changes, else every 30 s. Shown at once from the last visit's answer, then refreshed.
  const [fast, setFast] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const status = usePoll(() => api<Status>("GET", "/status"), fast ? 4_000 : 30_000, true, "status");
  const state = status.data?.instance.state;
  const reachable = state === "running" && status.data?.ssmOnline === true;
  useEffect(() => setFast(state === "pending" || state === "stopping" || (state === "running" && !reachable)), [state, reachable]);

  // From the instance itself (SSM, a second or two each): only while it is reachable. When the last visit found it
  // reachable, these start together with the status instead of after it.
  const details = usePoll(() => api<Details>("GET", "/status/details"), 60_000, reachable, "details");
  const sessions = usePoll(() => api<{ sessions: Session[] }>("GET", "/sessions").then((r) => r.sessions), 15_000, reachable, "sessions");

  // An action's answer (pending, stopping, the new type) shows at once; the next load confirms it.
  function onInstanceChange(instance: Instance) {
    if (status.data) status.set({ ...status.data, instance, ssmOnline: false });
    void status.reload();
  }

  // Cost Explorer data changes a few times a day and costs $0.01 a request: the last answer is kept in this browser
  // (localStorage) and used for COSTS_FRESH_MS; then once per visit, and on request (the card's refresh button).
  const costs = usePoll(() => api<CostsAnswer>("GET", "/costs"), undefined, true, COSTS_CACHE_KEY, costsFresh);

  return (
    <div className="page">
      <header className="top">
        <h1>Claude EC2</h1>
        <span className="muted small email" data-testid="user-email">
          {email}
        </span>
        <button type="button" className="link" onClick={onLogout}>
          Sign out
        </button>
      </header>
      <main>
        <InstanceCard status={status} onChange={onInstanceChange} />
        {reachable && (
          <>
            {details.data?.auth && (
              <LoginCard
                auth={details.data.auth}
                now={details.data.now + (details.fetchedAt ? (Date.now() - details.fetchedAt) / 1000 : 0)}
                open={loginOpen}
                onClose={() => setLoginOpen(false)}
                onLoggedIn={() => {
                  void details.reload();
                  // The main session restarts and registers with Remote Control within a few seconds.
                  setTimeout(() => void sessions.reload(), 5_000);
                }}
              />
            )}
            <SessionsCard sessions={sessions} />
            <DetailsCard details={details} onRenewLogin={() => setLoginOpen(true)} />
            <CommandCard />
          </>
        )}
        {state === "stopped" && !status.stale && <p className="muted center">Start the instance to see its Claude Code sessions.</p>}
        <CostsCard costs={costs} />
      </main>
      <footer className="muted small">
        {APP_VERSION} · <a href="https://github.com/jakubprzybytek/claude-ec2">source</a>
      </footer>
    </div>
  );
}
