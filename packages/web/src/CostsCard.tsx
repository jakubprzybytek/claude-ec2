import { useState } from "react";
import type { Costs, CostsAnswer } from "./api.ts";
import { time } from "./format.ts";
import { CardHeader, Skeleton } from "./ui.tsx";
import type { Polled } from "./usePoll.ts";

/** The Claude Code instance's costs this month (Cost Explorer): month to date, by part and by day. */
export function CostsCard({ costs: polled }: { costs: Polled<CostsAnswer> }) {
  const { data, error } = polled;
  const c = data && "unavailable" in data ? undefined : data;
  const unavailable = data && "unavailable" in data ? data.unavailable : undefined;
  const [hover, setHover] = useState<number>();

  const money = (n: number) => new Intl.NumberFormat(undefined, { style: "currency", currency: c?.currency ?? "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
  const monthName = c ? new Date(`${c.month}-01T00:00:00Z`).toLocaleDateString([], { month: "long", year: "numeric", timeZone: "UTC" }) : "";
  const dayName = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString([], { day: "numeric", month: "short", timeZone: "UTC" });

  return (
    <section className={`card${polled.stale ? " stale" : ""}`} data-testid="costs-card" aria-busy={polled.loading}>
      <CardHeader title={c ? `Claude Code instance · ${monthName}` : "Claude Code instance costs"} polled={polled} />
      {/* Secondary to the instance: a failure here is a note, not an alarm (e.g. no Cost Explorer access yet). */}
      {error && <p className="muted small" data-testid="costs-error">{error}</p>}
      {unavailable && !error && (
        <p className="muted small" data-testid="costs-unavailable">
          {unavailable}
        </p>
      )}
      {!data && !error && <Skeleton lines={4} label="Loading the costs" />}
      {c && (
        <>
          <div className="figures">
            <div>
              <div className="muted small">Month to date</div>
              <div className="figure" data-testid="costs-total">
                {money(c.total)}
              </div>
            </div>
          </div>

          <DailyBars days={c.days} money={money} dayName={dayName} hover={hover} setHover={setHover} />

          <table className="services" data-testid="costs-parts">
            <caption className="sr-only">The instance's costs by part, month to date</caption>
            <thead className="sr-only">
              <tr>
                <th>Part</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {c.parts.map((p) => (
                <tr key={p.name}>
                  <td>
                    <span className="service-name">{p.name}</span>
                    <span className="share" aria-hidden="true">
                      <span style={{ width: `${c.total > 0 ? Math.max(1, (p.amount / c.total) * 100) : 0}%` }} />
                    </span>
                  </td>
                  <td className="amount">{money(p.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">
            The instance's running time, disk and public IPv4 address, before tax; today's costs are partial. Cost Explorer, as of{" "}
            {time(c.updatedAt / 1000)}.
          </p>
        </>
      )}
    </section>
  );
}

/** Daily costs as bars: one series, so no legend; hover, focus or tap a bar for its value. */
function DailyBars({
  days,
  money,
  dayName,
  hover,
  setHover,
}: {
  days: Costs["days"];
  money: (n: number) => string;
  dayName: (d: string) => string;
  hover: number | undefined;
  setHover: (i: number | undefined) => void;
}) {
  if (days.length === 0) return null;
  const max = Math.max(...days.map((d) => d.amount), 0.01);
  const shown = hover !== undefined ? days[hover] : undefined;
  return (
    <figure className="daily" onMouseLeave={() => setHover(undefined)}>
      <figcaption className="small">
        {shown ? (
          <>
            <strong>{dayName(shown.date)}</strong>: {money(shown.amount)}
            {shown.estimated ? <span className="muted"> (estimate, so far)</span> : null}
          </>
        ) : (
          <span className="muted">By day · highest {money(max)}</span>
        )}
      </figcaption>
      <div className="bars">
        {days.map((d, i) => (
          <button
            type="button"
            key={d.date}
            className={`bar${d.estimated ? " estimated" : ""}${hover === i ? " on" : ""}`}
            aria-label={`${dayName(d.date)}: ${money(d.amount)}${d.estimated ? ", estimate" : ""}`}
            onMouseEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            onClick={() => setHover(i)}
          >
            <span className="stack" style={{ height: `${Math.max(d.amount > 0 ? 2 : 0, (d.amount / max) * 100)}%` }} />
          </button>
        ))}
      </div>
      <div className="axis muted small" aria-hidden="true">
        <span>{dayName(days[0]!.date)}</span>
        <span>{dayName(days.at(-1)!.date)}</span>
      </div>
    </figure>
  );
}
