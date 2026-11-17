import { type FormEvent, useState } from "react";
import { api, type Conversation, type Session } from "./api.ts";
import { ago, shortPath, slug, time } from "./format.ts";
import { usePoll } from "./usePoll.ts";

/** Claude Code sessions on the instance: open them in claude.ai, close spawned ones, start new ones. */
export function SessionsCard({ sessions, error, onChange }: { sessions: Session[] | undefined; error: string | undefined; onChange: () => void }) {
  const [closing, setClosing] = useState<string>();
  const [closeError, setCloseError] = useState<string>();
  const [showNew, setShowNew] = useState(false);

  async function close(name: string) {
    if (!window.confirm(`Close session ${name}? The conversation is kept and can be forked later.`)) return;
    setClosing(name);
    setCloseError(undefined);
    try {
      await api("DELETE", `/sessions/${encodeURIComponent(name)}`);
      onChange();
    } catch (e) {
      setCloseError((e as Error).message);
    } finally {
      setClosing(undefined);
    }
  }

  return (
    <section className="card" data-testid="sessions-card">
      <header>
        <h2>Claude Code sessions</h2>
        <button type="button" className="primary" onClick={() => setShowNew((v) => !v)} data-testid="new-session">
          {showNew ? "Cancel" : "New session"}
        </button>
      </header>
      {showNew && (
        <NewSession
          taken={(sessions ?? []).map((s) => s.name)}
          onStarted={() => {
            setShowNew(false);
            onChange();
          }}
        />
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {!sessions && !error && <p className="muted">Asking the instance…</p>}
      {sessions && sessions.length === 0 && <p className="muted">No Claude Code sessions.</p>}
      <ul className="sessions">
        {(sessions ?? []).map((s) => (
          <li key={s.name} data-testid="session">
            <div className="row">
              <strong>{s.main ? "main" : s.name}</strong>
              <span className={`badge ${s.state === "busy" ? "busy" : s.state === "idle" ? "ok" : "off"}`}>{s.state}</span>
            </div>
            <div className="muted small">
              {shortPath(s.folder)} · started {time(s.created)}
              {s.attached ? ` · ${s.attached} attached` : ""}
            </div>
            <div className="actions">
              {s.url ? (
                <a className="button" href={s.url} target="_blank" rel="noreferrer" data-testid="open-session">
                  Open in claude.ai
                </a>
              ) : (
                <span className="muted small">{s.main ? "Remote Control not on (/remote-control in the session)" : "Connecting to claude.ai…"}</span>
              )}
              {!s.main && (
                <button type="button" className="danger" disabled={closing === s.name} onClick={() => close(s.name)}>
                  {closing === s.name ? "Closing…" : "Close"}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {closeError && <p className="error" role="alert">{closeError}</p>}
    </section>
  );
}

function NewSession({ taken, onStarted }: { taken: string[]; onStarted: () => void }) {
  const lists = usePoll(() => api<{ conversations: Conversation[]; folders: string[] }>("GET", "/conversations?days=14"), undefined);
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("/home/ubuntu");
  const [fork, setFork] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const forked = lists.data?.conversations.find((c) => c.id === fork);
  const suggested = slug(forked?.title ?? (folder === "/home/ubuntu" ? "session" : (folder.split("/").pop() ?? "session")));
  let defaultName = suggested || "session";
  for (let n = 2; taken.includes(defaultName); n++) defaultName = `${suggested}-${n}`;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api("POST", "/sessions", { name: name.trim() || defaultName, folder, ...(fork ? { fork } : {}), ...(prompt.trim() ? { prompt: prompt.trim() } : {}) });
      onStarted();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="new-session" onSubmit={submit} data-testid="new-session-form">
      <label className="field">
        <span>Start from</span>
        <select
          value={fork}
          onChange={(e) => {
            setFork(e.target.value);
            const c = lists.data?.conversations.find((x) => x.id === e.target.value);
            if (c?.folder) setFolder(c.folder);
          }}
          data-testid="fork"
        >
          <option value="">A new conversation</option>
          {(lists.data?.conversations ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              Fork: {c.title ?? c.firstPrompt?.slice(0, 60) ?? c.id} · {shortPath(c.folder)} · {ago(c.modified)}
            </option>
          ))}
        </select>
      </label>
      {forked && (
        <p className="muted small">
          {forked.lastPrompt ? `Last prompt: ${forked.lastPrompt}` : forked.firstPrompt}
          {forked.url && (
            <>
              {" · "}
              <a href={forked.url} target="_blank" rel="noreferrer">
                original
              </a>
            </>
          )}
        </p>
      )}
      <label className="field">
        <span>Folder</span>
        <select value={folder} onChange={(e) => setFolder(e.target.value)} data-testid="folder">
          {[...new Set([...(lists.data?.folders ?? ["/home/ubuntu"]), folder])].map((f) => (
            <option key={f} value={f}>
              {shortPath(f)}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Name</span>
        <input value={name} placeholder={defaultName} onChange={(e) => setName(e.target.value)} pattern="[A-Za-z0-9][A-Za-z0-9_\-]{0,39}" maxLength={40} data-testid="session-name" />
      </label>
      <label className="field">
        <span>First prompt (optional)</span>
        <textarea value={prompt} rows={3} maxLength={10000} onChange={(e) => setPrompt(e.target.value)} data-testid="session-prompt" />
      </label>
      {lists.error && <p className="error">{lists.error}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="primary" disabled={busy} data-testid="spawn">
        {busy ? "Starting…" : "Start session"}
      </button>
    </form>
  );
}
