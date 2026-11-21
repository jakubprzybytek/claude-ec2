// Small pieces every card uses to show that something is loading.

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { time } from "./format.ts";
import type { Polled } from "./usePoll.ts";

export function Spinner({ label }: { label?: string }) {
  return label ? <span className="spinner" role="img" aria-label={label} /> : <span className="spinner" aria-hidden="true" />;
}

/** A button that shows a spinner while its action runs. */
export function BusyButton({ busy, busyText, children, ...props }: { busy: boolean; busyText?: string; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" {...props} disabled={busy || props.disabled} aria-busy={busy}>
      {busy && <Spinner />}
      {busy && busyText ? busyText : children}
    </button>
  );
}

/** A card's title with its loading state: a spinner while loading, else a refresh button that says how old the data is. */
export function CardHeader({ title, polled, children }: { title: string; polled?: Pick<Polled<unknown>, "loading" | "fetchedAt" | "reload">; children?: ReactNode }) {
  return (
    <header>
      <h2>{title}</h2>
      <span className="header-tools">
        {polled &&
          (polled.loading ? (
            <span className="refresh" data-testid="loading">
              <Spinner label="Loading" />
            </span>
          ) : (
            <button
              type="button"
              className="refresh"
              onClick={() => void polled.reload()}
              title={polled.fetchedAt ? `Updated ${time(polled.fetchedAt / 1000)}. Refresh` : "Refresh"}
              aria-label="Refresh"
            >
              ↻
            </button>
          ))}
        {children}
      </span>
    </header>
  );
}

/** Grey placeholder lines in the shape of the content to come. */
export function Skeleton({ lines = 3, label = "Loading…" }: { lines?: number; label?: string }) {
  return (
    <div className="skeleton" role="status" aria-label={label}>
      {Array.from({ length: lines }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder lines, never reordered.
        <span key={i} style={{ width: `${[72, 55, 64, 40, 80][i % 5]}%` }} />
      ))}
    </div>
  );
}
