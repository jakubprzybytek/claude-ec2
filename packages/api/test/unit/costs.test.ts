import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { CACHE_MS, cachedMonthCosts, clearCostsCache, instancePart, monthCosts, NO_ACCESS } from "../../src/costs.ts";
import { HttpError } from "../../src/instance.ts";

const ce = mockClient(CostExplorerClient);
const NOW = new Date("2026-11-03T10:00:00Z");

const COMPUTE = "Amazon Elastic Compute Cloud - Compute";
const RUNNING = `${COMPUTE}|EU-BoxUsage:t4g.medium`;
const DISK = "EC2 - Other|EU-EBS:VolumeUsage.gp3";
const IPV4 = "Amazon Virtual Private Cloud|EU-PublicIPv4:InUseAddress";

/** A day's cost lines, keyed "service|usage type". */
const day = (date: string, lines: Record<string, number>, estimated = false) => ({
  TimePeriod: { Start: date, End: "" },
  Estimated: estimated,
  Groups: Object.entries(lines).map(([k, v]) => ({ Keys: k.split("|"), Metrics: { UnblendedCost: { Amount: String(v), Unit: "USD" } } })),
});

beforeEach(() => {
  ce.reset();
  clearCostsCache();
  ce.on(GetCostAndUsageCommand).resolves({
    ResultsByTime: [
      day("2026-11-01", { [RUNNING]: 0.8, [DISK]: 0.08, [IPV4]: 0.12 }),
      // Lines of the same services that are not the instance's are left out.
      day("2026-11-02", { [`${COMPUTE}|EU-CPUCredits:t4g`]: 0.001, [DISK]: 0.08, "EC2 - Other|EU-DataTransfer-Out-Bytes": 0.5 }),
      day("2026-11-03", { [RUNNING]: 0.2 }, true),
    ],
  });
});

describe("instance costs", () => {
  it("sums the instance's costs by part and by day, in one request", async () => {
    const c = await monthCosts(NOW);
    expect(c).toMatchObject({ month: "2026-11", currency: "USD" });
    expect(c.total).toBeCloseTo(1.281);
    expect(c.parts).toEqual([
      { name: "Running time", amount: expect.closeTo(1.001) },
      { name: "Disk", amount: expect.closeTo(0.16) },
      { name: "Public IPv4", amount: expect.closeTo(0.12) },
    ]);
    expect(c.days.map((d) => [d.date, d.estimated])).toEqual([
      ["2026-11-01", false],
      ["2026-11-02", false],
      ["2026-11-03", true],
    ]);
    expect(c.days.map((d) => d.amount)).toEqual([expect.closeTo(1), expect.closeTo(0.081), expect.closeTo(0.2)]);
    const calls = ce.commandCalls(GetCostAndUsageCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input).toMatchObject({
      TimePeriod: { Start: "2026-11-01", End: "2026-11-04" },
      Filter: { Dimensions: { Key: "SERVICE", Values: [COMPUTE, "EC2 - Other", "Amazon Virtual Private Cloud"] } },
      GroupBy: [{ Key: "SERVICE" }, { Key: "USAGE_TYPE" }],
    });
  });

  it("counts only the instance's usage types", () => {
    expect(instancePart(COMPUTE, "BoxUsage:t4g.medium")).toBe("Running time");
    expect(instancePart("EC2 - Other", "EU-EBS:SnapshotUsage")).toBe("Disk");
    expect(instancePart("EC2 - Other", "EU-DataTransfer-Regional-Bytes")).toBeUndefined();
    expect(instancePart("EC2 - Other", "EU-NatGateway-Hours")).toBeUndefined();
    expect(instancePart("Amazon Relational Database Service", "EU-BoxUsage:db.t4g.micro")).toBeUndefined();
  });

  it("follows the result pages, adding up a day split across them once", async () => {
    ce.on(GetCostAndUsageCommand)
      .resolvesOnce({ ResultsByTime: [day("2026-11-01", { [RUNNING]: 1 })], NextPageToken: "p2" })
      .resolves({ ResultsByTime: [day("2026-11-01", { [DISK]: 2 })] });
    const c = await monthCosts(NOW);
    expect(c.days).toEqual([{ date: "2026-11-01", amount: 3, estimated: false }]);
    expect(ce.commandCalls(GetCostAndUsageCommand)[1]!.args[0].input.NextPageToken).toBe("p2");
  });

  it("asks Cost Explorer again only after the cache time or in a new month", async () => {
    await cachedMonthCosts(NOW);
    await Promise.all([cachedMonthCosts(new Date(NOW.getTime() + 1000)), cachedMonthCosts(new Date(NOW.getTime() + CACHE_MS - 1))]);
    expect(ce.commandCalls(GetCostAndUsageCommand)).toHaveLength(1);
    await cachedMonthCosts(new Date(NOW.getTime() + CACHE_MS));
    expect(ce.commandCalls(GetCostAndUsageCommand)).toHaveLength(2);
    await cachedMonthCosts(new Date("2026-12-01T00:00:00Z"));
    expect(ce.commandCalls(GetCostAndUsageCommand)).toHaveLength(3);
  });

  it("says why when the role may not read Cost Explorer", async () => {
    ce.on(GetCostAndUsageCommand).rejects(Object.assign(new Error("not authorized to perform: ce:GetCostAndUsage"), { name: "AccessDeniedException" }));
    const e = await monthCosts(NOW).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HttpError);
    expect(e).toMatchObject({ status: 503, message: NO_ACCESS });
  });

  it("does not keep a failure", async () => {
    ce.on(GetCostAndUsageCommand)
      .rejectsOnce(new Error("throttled"))
      .resolves({ ResultsByTime: [day("2026-11-01", { [RUNNING]: 1 })] });
    await expect(cachedMonthCosts(NOW)).rejects.toThrow("throttled");
    await expect(cachedMonthCosts(NOW)).resolves.toMatchObject({ month: "2026-11" });
  });
});
