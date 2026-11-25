// The Claude Code instance's costs for the current month, from Cost Explorer: month to date by part (running time, disk,
// public IPv4) and by day. Cost Explorer charges $0.01 a request and refreshes its data a few times a day: one request
// per answer, kept in the function's memory for CACHE_MS while it stays warm, and in the browser (costsCache.ts).

import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
import { HttpError } from "./instance.ts";

/** Cost Explorer has a single endpoint, in us-east-1. */
export const ce = new CostExplorerClient({ region: "us-east-1" });

export const CACHE_MS = 6 * 3600_000;

export const NO_ACCESS = "Costs are not available yet: the app may not read Cost Explorer (the boundary claude-ec2-Boundary needs the Costs statement, infra/github/README.md).";

export type InstancePart = "Running time" | "Disk" | "Public IPv4";

export interface Costs {
  /** "2026-11" */
  month: string;
  currency: string;
  /** The instance's costs month to date, today's partial costs included. */
  total: number;
  /** By part, largest first; parts under a cent left out. */
  parts: { name: InstancePart; amount: number }[];
  /** Every day from the 1st to today. */
  days: { date: string; amount: number; estimated: boolean }[];
  /** When Cost Explorer was asked (epoch ms). */
  updatedAt: number;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

// Claude Code is the account's only EC2 instance, so its costs are told apart by service and usage type: its running
// time and CPU credits (EC2 - Compute), its EBS volume and snapshots (EC2 - Other) and its public IPv4 address (VPC).
// A second instance or volume in the account would be counted here as well. (It also carries the cost tag
// sst:app=claude-ec2, but only since 25 Nov 2026.)
const INSTANCE_SERVICES = ["Amazon Elastic Compute Cloud - Compute", "EC2 - Other", "Amazon Virtual Private Cloud"];
const INSTANCE_USAGE: [RegExp, InstancePart][] = [
  [/(^|-)(BoxUsage|CPUCredits)(:|$)/, "Running time"],
  [/(^|-)EBS:/, "Disk"],
  [/(^|-)PublicIPv4:/, "Public IPv4"],
];

/** The instance part a cost line belongs to, from its service and usage type (e.g. "EU-EBS:VolumeUsage.gp3"). */
export function instancePart(service: string, usageType: string): InstancePart | undefined {
  if (!INSTANCE_SERVICES.includes(service)) return undefined;
  return INSTANCE_USAGE.find(([re]) => re.test(usageType))?.[1];
}

export async function monthCosts(now = new Date()): Promise<Costs> {
  const today = day(now);
  const first = `${today.slice(0, 7)}-01`;
  const tomorrow = day(new Date(now.getTime() + 86_400_000));
  const query = {
    TimePeriod: { Start: first, End: tomorrow },
    Granularity: "DAILY" as const,
    Metrics: ["UnblendedCost"],
    Filter: { Dimensions: { Key: "SERVICE" as const, Values: INSTANCE_SERVICES } },
    GroupBy: [
      { Type: "DIMENSION" as const, Key: "SERVICE" },
      { Type: "DIMENSION" as const, Key: "USAGE_TYPE" },
    ],
  };
  const send = (q: typeof query & { NextPageToken?: string }) =>
    ce.send(new GetCostAndUsageCommand(q)).catch((e: unknown) => {
      // Without the boundary's Costs statement the role may not read Cost Explorer: the card says why it is empty.
      if ((e as Error).name === "AccessDeniedException") {
        console.warn("GetCostAndUsage", (e as Error).message);
        throw new HttpError(503, NO_ACCESS);
      }
      throw e;
    });

  const byPart = new Map<InstancePart, number>();
  const days: Costs["days"] = [];
  let currency = "USD";
  let res = await send(query);
  for (;;) {
    for (const r of res.ResultsByTime ?? []) {
      const date = r.TimePeriod?.Start ?? "";
      // A day can come back in two pages: add to it rather than adding it twice.
      let d = days.at(-1);
      if (d?.date !== date) {
        d = { date, amount: 0, estimated: r.Estimated ?? false };
        days.push(d);
      }
      for (const g of r.Groups ?? []) {
        const part = instancePart(g.Keys?.[0] ?? "", g.Keys?.[1] ?? "");
        if (!part) continue;
        const m = g.Metrics?.["UnblendedCost"];
        const a = Number(m?.Amount ?? 0);
        if (m?.Unit) currency = m.Unit;
        d.amount += a;
        byPart.set(part, (byPart.get(part) ?? 0) + a);
      }
    }
    if (!res.NextPageToken) break;
    res = await send({ ...query, NextPageToken: res.NextPageToken });
  }

  return {
    month: today.slice(0, 7),
    currency,
    total: days.reduce((s, d) => s + d.amount, 0),
    parts: [...byPart]
      .map(([name, amount]) => ({ name, amount }))
      .filter((p) => p.amount >= 0.005)
      .sort((a, b) => b.amount - a.amount),
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
