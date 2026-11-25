import { useState } from "react";
import type { Costs, CostsAnswer } from "./api.ts";
import { time } from "./format.ts";
import { CardHeader, Skeleton } from "./ui.tsx";
import type { Polled } from "./usePoll.ts";

/** The app's services named under its figure; the rest are summed up. */
const APP_TOP = 3;

/** Services shown by name; the rest are summed up as "Other". */
const TOP = 6;

/** The AWS account's costs this month (Cost Explorer): month to date, forecast, the Claude Code instance's share, by day and by service. */
export function CostsCard({ costs: polled }: { costs: Polled<CostsAnswer> }) {
  const { data, error } = polled;
  const c = data && "unavailable" in data ? undefined : data;
  const unavailable = data && "unavailable" in data ? data.unavailable : undefined;
  const [all, setAll] = useState(false);
  const [hover, setHover] = useState<number>();

  const money = (n: number) => new Intl.NumberFormat(undefined, { style: "currency", currency: c?.currency ?? "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
  const monthName = c ? new Date(`${c.month}-01T00:00:00Z`).toLocaleDateString([], { month: "long", year: "numeric", timeZone: "UTC" }) : "";
  const dayName = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString([], { day: "numeric", month: "short", timeZone: "UTC" });

  return (
    <section className={`card${polled.stale ? " stale" : ""}`} data-testid="costs-card" aria-busy={polled.loading}>
      <CardHeader title={c ? `AWS costs · ${monthName}` : "AWS costs"} polled={polled} />
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
            {c.forecast !== null && (
              <div>
                <div className="muted small">Forecast for the month</div>
                <div className="figure muted-figure" data-testid="costs-forecast">
                  {money(c.forecast)}
                </div>
              </div>
            )}
            <div>
              <div className="muted small">
                <span className="swatch instance" aria-hidden="true" />
                Claude Code instance
              </div>
              <div className="figure" data-testid="costs-instance">
                {money(c.instance.amount)}
              </div>
              {c.instance.parts.length > 0 && (
                <div className="muted small" data-testid="costs-instance-parts">
                  {c.instance.parts.map((p) => `${p.name} ${money(p.amount)}`).join(" · ")}
                </div>
              )}
            </div>
            {c.app && (
              <div>
                <div className="muted small">{c.app.name} app (tagged resources)</div>
                <div className="figure" data-testid="costs-app">
                  {money(c.app.amount)}
                </div>
                <div className="muted small" data-testid="costs-app-services">
                  {c.app.services.length === 0
                    ? "No tagged costs yet"
                    : [
                        ...c.app.services.slice(0, APP_TOP).map((s) => `${shortService(s.name)} ${money(s.amount)}`),
                        ...(c.app.services.length > APP_TOP
                          ? [`other ${money(c.app.services.slice(APP_TOP).reduce((t, s) => t + s.amount, 0))}`]
                          : []),
                      ].join(" · ")}
                </div>
              </div>
            )}
          </div>

          <DailyBars days={c.days} money={money} dayName={dayName} hover={hover} setHover={setHover} />

          <table className="services" data-testid="costs-services">
            <caption className="sr-only">Costs by service, month to date</caption>
            <thead className="sr-only">
              <tr>
                <th>Service</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {serviceRows(c.services, all).map((s) => (
                <tr key={s.name}>
                  <td>
                    <span className="service-name">{s.name}</span>
                    <span className="share" aria-hidden="true">
                      <span style={{ width: `${c.total > 0 ? Math.max(1, (s.amount / c.total) * 100) : 0}%` }} />
                    </span>
                  </td>
                  <td className="amount">{money(s.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {c.services.length > TOP + 1 && (
            <button type="button" className="link small" onClick={() => setAll((v) => !v)}>
              {all ? "Show fewer" : `Show all ${c.services.length} services`}
            </button>
          )}
          <p className="muted small">
            The whole AWS account, tax included; today's costs are partial. The app's figure counts its resources tagged{" "}
            <code>sst:app</code> (every stage), only while they carried the tag: the Claude Code instance since 25 Nov 2026. Cost
            Explorer, as of {time(c.updatedAt / 1000)}.
          </p>
        </>
      )}
    </section>
  );
}

/** "Amazon Elastic Compute Cloud - Compute" → "Elastic Compute Cloud - Compute", "AWS Lambda" → "Lambda". */
function shortService(name: string) {
  return name.replace(/^(Amazon|AWS)\s+/, "");
}

function serviceRows(services: Costs["services"], all: boolean) {
  if (all || services.length <= TOP + 1) return services;
  const rest = services.slice(TOP);
  return [...services.slice(0, TOP), { name: `Other (${rest.length} services)`, amount: rest.reduce((s, x) => s + x.amount, 0) }];
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
            <strong>{dayName(shown.date)}</strong>: {money(shown.amount)}, instance {money(shown.instance)}
            {shown.estimated ? <span className="muted"> (estimate, so far)</span> : null}
          </>
        ) : (
          <span className="muted">
            By day · highest {money(max)} · <span className="swatch instance" aria-hidden="true" />
            instance <span className="swatch rest" aria-hidden="true" />
            the rest
          </span>
        )}
      </figcaption>
      <div className="bars">
        {days.map((d, i) => (
          <button
            type="button"
            key={d.date}
            className={`bar${d.estimated ? " estimated" : ""}${hover === i ? " on" : ""}`}
            aria-label={`${dayName(d.date)}: ${money(d.amount)}, instance ${money(d.instance)}${d.estimated ? ", estimate" : ""}`}
            onMouseEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            onClick={() => setHover(i)}
          >
            <span className="stack" style={{ height: `${Math.max(d.amount > 0 ? 2 : 0, (d.amount / max) * 100)}%` }}>
              <span className="instance" style={{ height: `${d.amount > 0 ? Math.min(100, (d.instance / d.amount) * 100) : 0}%` }} />
            </span>
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
