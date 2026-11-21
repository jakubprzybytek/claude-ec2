import { CostExplorerClient, GetCostAndUsageCommand, GetCostForecastCommand } from "@aws-sdk/client-cost-explorer";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { CACHE_MS, cachedMonthCosts, clearCostsCache, monthCosts, NO_ACCESS } from "../../src/costs.ts";
import { HttpError } from "../../src/instance.ts";

const ce = mockClient(CostExplorerClient);
const NOW = new Date("2026-11-03T10:00:00Z");

const day = (date: string, services: Record<string, number>, estimated = false) => ({
  TimePeriod: { Start: date, End: "" },
  Estimated: estimated,
  Groups: Object.entries(services).map(([k, v]) => ({ Keys: [k], Metrics: { UnblendedCost: { Amount: String(v), Unit: "USD" } } })),
});

beforeEach(() => {
  ce.reset();
  clearCostsCache();
  ce.on(GetCostAndUsageCommand).resolves({
    ResultsByTime: [day("2026-11-01", { EC2: 1, S3: 0.5 }), day("2026-11-02", { EC2: 2, Tiny: 0.001 }), day("2026-11-03", { EC2: 0.25 }, true)],
  });
  ce.on(GetCostForecastCommand).resolves({ Total: { Amount: "40", Unit: "USD" } });
});

describe("month costs", () => {
  it("sums month to date by service and day, and adds the forecast to the known days", async () => {
    const c = await monthCosts(NOW);
    expect(c).toMatchObject({ month: "2026-11", currency: "USD", forecast: 43.501 });
    expect(c.total).toBeCloseTo(3.751);
    expect(c.services).toEqual([
      { name: "EC2", amount: 3.25 },
      { name: "S3", amount: 0.5 },
    ]);
    expect(c.days.map((d) => [d.date, d.estimated])).toEqual([
      ["2026-11-01", false],
      ["2026-11-02", false],
      ["2026-11-03", true],
    ]);
    expect(ce.commandCalls(GetCostAndUsageCommand)[0]!.args[0].input.TimePeriod).toEqual({ Start: "2026-11-01", End: "2026-11-04" });
    expect(ce.commandCalls(GetCostForecastCommand)[0]!.args[0].input.TimePeriod).toEqual({ Start: "2026-11-03", End: "2026-12-01" });
  });

  it("shows the costs without a forecast when Cost Explorer has none", async () => {
    ce.on(GetCostForecastCommand).rejects(Object.assign(new Error("Insufficient amount of historical data"), { name: "DataUnavailableException" }));
    expect((await monthCosts(NOW)).forecast).toBeNull();
  });

  it("follows the result pages", async () => {
    ce.on(GetCostAndUsageCommand)
      .resolvesOnce({ ResultsByTime: [day("2026-11-01", { EC2: 1 })], NextPageToken: "p2" })
      .resolves({ ResultsByTime: [day("2026-11-02", { EC2: 2 })] });
    expect((await monthCosts(NOW)).total).toBe(3);
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
      .resolves({ ResultsByTime: [day("2026-11-01", { EC2: 1 })] });
    await expect(cachedMonthCosts(NOW)).rejects.toThrow("throttled");
    await expect(cachedMonthCosts(NOW)).resolves.toMatchObject({ month: "2026-11" });
  });
});
