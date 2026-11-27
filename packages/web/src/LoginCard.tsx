import { type FormEvent, useState } from "react";
import { api, type Auth } from "./api.ts";
import { BusyButton } from "./ui.tsx";

/** Warn this many days before Claude Code's login on the instance expires. */
export const LOGIN_WARN_DAYS = 7;

/** "in 3 days", "in 5 hours", "now". */
export function expiresIn(expiresAt: number, nowSeconds: number): string {
  const s = expiresAt - nowSeconds;
  if (s <= 0) return "now";
  if (s >= 2 * 86_400) return `in ${Math.floor(s / 86_400)} days`;
  const h = Math.max(1, Math.floor(s / 3600));
  return `in ${h} hour${h === 1 ? "" : "s"}`;
}

/** Whether the login card should be shown: logged out, or the login expires soon. */
export function loginNeedsAttention(auth: Auth | undefined, nowSeconds: number): boolean {
  if (!auth) return false;
  if (auth.loggedIn === false) return true;
  return auth.loggedIn === true && auth.expiresAt !== null && auth.expiresAt !== undefined && auth.expiresAt - nowSeconds < LOGIN_WARN_DAYS * 86_400;
}

interface CodeAnswer {
  loggedIn: boolean;
  loginExpiresAt: string | null;
  mainRestarted: boolean;
}

/**
 * Claude Code's login on the instance: says when it is missing or expires soon, and logs in without a terminal
 * (remote/login.sh runs `claude auth login`: open its sign-in URL, sign in, paste the code claude.ai shows).
 */
export function LoginCard({ auth, now, open, onClose, onLoggedIn }: { auth: Auth; now: number; open: boolean; onClose: () => void; onLoggedIn: () => void }) {
  const [url, setUrl] = useState<string>();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"start" | "code" | "cancel">();
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();

  async function start() {
    setBusy("start");
    setError(undefined);
    setDone(undefined);
    try {
      setUrl((await api<{ url: string }>("POST", "/login")).url);
      setCode("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy("code");
    setError(undefined);
    try {
      const r = await api<CodeAnswer>("POST", "/login/code", { code: code.trim() });
      setUrl(undefined);
      if (r.loggedIn) {
        setDone(r.mainRestarted ? "Logged in. The main session has been restarted." : "Logged in.");
        onLoggedIn();
      } else {
        setError("The login ended, but Claude Code still says it is not logged in. Try again.");
      }
    } catch (err) {
      // A refused code ends the login on the instance: a new one needs a new URL.
      setError((err as Error).message);
      setUrl(undefined);
    } finally {
      setBusy(undefined);
    }
  }

  async function cancel() {
    setBusy("cancel");
    try {
      await api("DELETE", "/login");
    } catch {
      /* it ends by itself after 15 minutes */
    } finally {
      setUrl(undefined);
      setError(undefined);
      setBusy(undefined);
      onClose();
    }
  }

  const loggedOut = auth.loggedIn === false;
  if (!open && !loggedOut && !url && !error && !done && !loginNeedsAttention(auth, now)) return null;

  return (
    <section className={`card notice ${loggedOut ? "danger" : "warn"}`} data-testid="login-card" role={loggedOut ? "alert" : undefined}>
      <header>
        <h2>{loggedOut ? "Claude Code is not logged in" : "Claude Code login"}</h2>
      </header>
      {done ? (
        <p data-testid="login-done">{done}</p>
      ) : loggedOut ? (
        <p>No Claude Code session can start on the instance until it is logged in again.</p>
      ) : (
        auth.expiresAt && (
          <p>
            Its login on the instance expires <strong>{expiresIn(auth.expiresAt, now)}</strong> ({new Date(auth.expiresAt * 1000).toLocaleString()}).
            {auth.expiresAt - now < LOGIN_WARN_DAYS * 86_400 ? " Renew it now so the sessions keep working." : " Renewing it starts a new login period; running sessions keep going."}
          </p>
        )
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!url && !done && (
        <div className="actions">
          <BusyButton className="primary" busy={busy === "start"} busyText="Starting the login" onClick={start} data-testid="login-start">
            {error ? "Start again" : loggedOut ? "Log in" : "Renew login"}
          </BusyButton>
          {open && !loggedOut && (
            <button type="button" onClick={onClose}>
              Close
            </button>
          )}
        </div>
      )}
      {done && (
        <div className="actions">
          <button
            type="button"
            onClick={() => {
              setDone(undefined);
              onClose();
            }}
          >
            Close
          </button>
        </div>
      )}
      {url && (
        <form onSubmit={submit} className="login-steps">
          <ol>
            <li>
              <a href={url} target="_blank" rel="noopener noreferrer" data-testid="login-url">
                Open the claude.ai sign-in page
              </a>{" "}
              and sign in with the account Claude Code should use.
            </li>
            <li>Copy the code it shows and paste it here.</li>
          </ol>
          <label className="field">
            <span>Code</span>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              required
              data-testid="login-code"
            />
          </label>
          <div className="actions">
            <BusyButton type="submit" className="primary" busy={busy === "code"} busyText="Logging in" disabled={!code.trim() || busy !== undefined}>
              Log in
            </BusyButton>
            <BusyButton busy={busy === "cancel"} disabled={busy !== undefined} onClick={cancel}>
              Cancel
            </BusyButton>
          </div>
        </form>
      )}
    </section>
  );
}
