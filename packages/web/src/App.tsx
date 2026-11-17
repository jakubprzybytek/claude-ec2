import { useCallback, useEffect, useState } from "react";
import { APP_VERSION, api, type Details, type Session, type Status } from "./api.ts";
import { currentSession, logout, type Session as UserSession } from "./auth.ts";
import { CommandCard } from "./CommandCard.tsx";
import { DetailsCard } from "./DetailsCard.tsx";
import { InstanceCard } from "./InstanceCard.tsx";
import { LoginForm } from "./LoginForm.tsx";
import { SessionsCard } from "./SessionsCard.tsx";
import { usePoll } from "./usePoll.ts";

export function App() {
  const [user, setUser] = useState<UserSession | null | undefined>(undefined);
  const check = useCallback(() => currentSession().then(setUser), []);
  useEffect(() => void check(), [check]);

  if (user === undefined) return null;
  if (user === null) return <LoginForm onSignedIn={check} />;
  return <Dashboard email={user.email} onLogout={() => logout().then(() => setUser(null))} />;
}

function Dashboard({ email, onLogout }: { email: string; onLogout: () => void }) {
  // EC2 state: often while it changes, else every 30 s.
  const [fast, setFast] = useState(false);
  const status = usePoll(() => api<Status>("GET", "/status"), fast ? 5_000 : 30_000);
  const state = status.data?.instance.state;
  const reachable = state === "running" && status.data?.ssmOnline === true;
  useEffect(() => setFast(state === "pending" || state === "stopping" || (state === "running" && !reachable)), [state, reachable]);

  // From the instance itself (SSM, a few seconds each): only while it is reachable.
  const details = usePoll(() => api<Details>("GET", "/status/details"), 60_000, reachable);
  const sessions = usePoll(() => api<{ sessions: Session[] }>("GET", "/sessions").then((r) => r.sessions), 15_000, reachable);

  return (
    <div className="page">
      <header className="top">
        <h1>Claude EC2</h1>
        <span className="muted small" data-testid="user-email">
          {email}
        </span>
        <button type="button" className="link" onClick={onLogout}>
          Sign out
        </button>
      </header>
      <main>
        <InstanceCard status={status.data} error={status.error} onChange={() => void status.reload()} />
        {reachable && (
          <>
            <SessionsCard sessions={sessions.data} error={sessions.error} onChange={() => void sessions.reload()} />
            <DetailsCard details={details.data} error={details.error} onChange={() => void details.reload()} />
            <CommandCard />
          </>
        )}
        {state === "stopped" && <p className="muted center">Start the instance to see its Claude Code sessions.</p>}
      </main>
      <footer className="muted small">
        {APP_VERSION} · <a href="https://github.com/jakubprzybytek/claude-ec2">source</a>
      </footer>
    </div>
  );
}
