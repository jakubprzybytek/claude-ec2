// The AWS account's costs for the current month, from Cost Explorer: month to date by service and by day, and the
// month-end forecast, and the Claude Code instance's share. Cost Explorer charges $0.01 a request and refreshes its data a few times a day, so the answer is
// kept in the function's memory for CACHE_MS: one page load costs two requests at most, usually none.

import { CostExplorerClient, GetCostAndUsageCommand, GetCostForecastCommand } from "@aws-sdk/client-cost-explorer";
import { HttpError } from "./instance.ts";

/** Cost Explorer has a single endpoint, in us-east-1. */
export const ce = new CostExplorerClient({ region: "us-east-1" });

export const CACHE_MS = 6 * 3600_000;

export const NO_ACCESS = "Costs are not available yet: the app may not read Cost Explorer (the boundary claude-ec2-Boundary needs the Costs statement, infra/github/README.md).";

export interface Costs {
  /** "2026-11" */
  month: string;
  currency: string;
  /** Month to date, today's partial costs included. */
  total: number;
  /** Month to date plus Cost Explorer's forecast for the rest of the month; null when it has none (e.g. too little data). */
  forecast: number | null;
  /** Largest first; costs under a cent left out. */
  services: { name: string; amount: number }[];
  /** The Claude Code instance: running time, disk and public IPv4, month to date; parts largest first. */
  instance: { amount: number; parts: { name: InstancePart; amount: number }[] };
  /** Every day from the 1st to today; `instance` is that day's share of the Claude Code instance. */
  days: { date: string; amount: number; instance: number; estimated: boolean }[];
  /** When Cost Explorer was asked (epoch ms). */
  updatedAt: number;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

export type InstancePart = "Running time" | "Disk" | "Public IPv4";

// Claude Code is the account's only EC2 instance, so its costs are told apart by usage type (one request, no tags):
// its running time and CPU credits (EC2 - Compute), its EBS volume and snapshots (EC2 - Other) and its public IPv4
// address (VPC). A second instance or volume in the account would be counted here as well.
const INSTANCE_SERVICES = new Set(["Amazon Elastic Compute Cloud - Compute", "EC2 - Other", "Amazon Virtual Private Cloud"]);
const INSTANCE_USAGE: [RegExp, InstancePart][] = [
  [/(^|-)(BoxUsage|CPUCredits)(:|$)/, "Running time"],
  [/(^|-)EBS:/, "Disk"],
  [/(^|-)PublicIPv4:/, "Public IPv4"],
];

/** The instance part a cost line belongs to, from its service and usage type (e.g. "EU-EBS:VolumeUsage.gp3"). */
export function instancePart(service: string, usageType: string): InstancePart | undefined {
  if (!INSTANCE_SERVICES.has(service)) return undefined;
  return INSTANCE_USAGE.find(([re]) => re.test(usageType))?.[1];
}

export async function monthCosts(now = new Date()): Promise<Costs> {
  const today = day(now);
  const first = `${today.slice(0, 7)}-01`;
  const tomorrow = day(new Date(now.getTime() + 86_400_000));
  const nextMonth = day(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)));

  const query = {
    TimePeriod: { Start: first, End: tomorrow },
    Granularity: "DAILY" as const,
    Metrics: ["UnblendedCost"],
    // By service and usage type in the same request: the services as before, and the instance's lines.
    GroupBy: [
      { Type: "DIMENSION" as const, Key: "SERVICE" },
      { Type: "DIMENSION" as const, Key: "USAGE_TYPE" },
    ],
  };
  const usage = ce.send(new GetCostAndUsageCommand(query)).catch((e: unknown) => {
    // Until the permissions boundary (infra/github/boundary-policy.json, "Costs") is published with admin credentials,
    // the role may not read Cost Explorer: the rest of the app works, the costs card says why it is empty.
    if ((e as Error).name === "AccessDeniedException") {
      console.warn("GetCostAndUsage", (e as Error).message);
      throw new HttpError(503, NO_ACCESS);
    }
    throw e;
  });
  const forecast = ce
    .send(new GetCostForecastCommand({ TimePeriod: { Start: today, End: nextMonth }, Granularity: "MONTHLY", Metric: "UNBLENDED_COST" }))
    .then((r) => Number(r.Total?.Amount ?? Number.NaN))
    .catch((e: unknown) => {
      // DataUnavailableException early in a month or on a new account: no forecast, the rest still shows.
      console.warn("GetCostForecast", (e as Error).name, (e as Error).message);
      return Number.NaN;
    });

  const byService = new Map<string, number>();
  const byPart = new Map<InstancePart, number>();
  const days: Costs["days"] = [];
  let currency = "USD";
  let beforeToday = 0;
  let token: string | undefined;
  let res = await usage;
  for (;;) {
    for (const r of res.ResultsByTime ?? []) {
      const date = r.TimePeriod?.Start ?? "";
      // A day can come back in two pages: add to it rather than adding it twice.
      let d = days.at(-1);
      if (d?.date !== date) {
        d = { date, amount: 0, instance: 0, estimated: r.Estimated ?? false };
        days.push(d);
      }
      for (const g of r.Groups ?? []) {
        const m = g.Metrics?.["UnblendedCost"];
        const a = Number(m?.Amount ?? 0);
        if (m?.Unit) currency = m.Unit;
        d.amount += a;
        if (date < today) beforeToday += a;
        const name = g.Keys?.[0] ?? "Other";
        byService.set(name, (byService.get(name) ?? 0) + a);
        const part = instancePart(name, g.Keys?.[1] ?? "");
        if (part) {
          d.instance += a;
          byPart.set(part, (byPart.get(part) ?? 0) + a);
        }
      }
    }
    token = res.NextPageToken;
    if (!token) break;
    res = await ce.send(new GetCostAndUsageCommand({ ...query, NextPageToken: token }));
  }

  const rest = await forecast;
  return {
    month: today.slice(0, 7),
    currency,
    total: days.reduce((s, d) => s + d.amount, 0),
    // The forecast covers today to the month's end; the days before today are known.
    forecast: Number.isFinite(rest) ? beforeToday + rest : null,
    services: [...byService]
      .map(([name, amount]) => ({ name, amount }))
      .filter((s) => s.amount >= 0.005)
      .sort((a, b) => b.amount - a.amount),
    instance: {
      amount: [...byPart.values()].reduce((s, a) => s + a, 0),
      parts: [...byPart]
        .map(([name, amount]) => ({ name, amount }))
        .filter((p) => p.amount >= 0.005)
        .sort((a, b) => b.amount - a.amount),
    },
    days,
    updatedAt: now.getTime(),
  };
}

let cached: { month: string; at: number; costs: Promise<Costs> } | undefined;

/** monthCosts(), from memory for CACHE_MS (and within the same month); concurrent callers share one request. */
export function cachedMonthCosts(now = new Date()): Promise<Costs> {
  const month = now.toISOString().slice(0, 7);
  if (cached && cached.month === month && now.getTime() - cached.at < CACHE_MS) return cached.costs;
  const costs = monthCosts(now);
  cached = { month, at: now.getTime(), costs };
  // A failure is not kept: the next call asks again.
  costs.catch(() => {
    if (cached?.costs === costs) cached = undefined;
  });
  return costs;
}

/** For the tests. */
export function clearCostsCache() {
  cached = undefined;
}
