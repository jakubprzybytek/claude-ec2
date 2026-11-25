import { CostExplorerClient, GetCostAndUsageCommand, GetCostForecastCommand } from "@aws-sdk/client-cost-explorer";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { APP_TAG, CACHE_MS, cachedMonthCosts, clearCostsCache, instancePart, monthCosts, NO_ACCESS } from "../../src/costs.ts";
import { HttpError } from "../../src/instance.ts";

const ce = mockClient(CostExplorerClient);
const NOW = new Date("2026-11-03T10:00:00Z");

/** A day's cost lines, keyed "service" or "service|usage type". */
const day = (date: string, lines: Record<string, number>, estimated = false) => ({
  TimePeriod: { Start: date, End: "" },
  Estimated: estimated,
  Groups: Object.entries(lines).map(([k, v]) => ({
    Keys: k.includes("|") ? k.split("|") : [k, "Other"],
    Metrics: { UnblendedCost: { Amount: String(v), Unit: "USD" } },
  })),
});

const COMPUTE = "Amazon Elastic Compute Cloud - Compute";

/** The request for this app's tagged resources (the others have no filter). */
const APP_FILTER = { Filter: { Tags: { Key: APP_TAG.key, Values: [APP_TAG.value] } } };
const accountCalls = () => ce.commandCalls(GetCostAndUsageCommand).filter((c) => !c.args[0].input.Filter);

beforeEach(() => {
  ce.reset();
  clearCostsCache();
  ce.on(GetCostAndUsageCommand).resolves({
    ResultsByTime: [day("2026-11-01", { EC2: 1, S3: 0.5 }), day("2026-11-02", { EC2: 2, Tiny: 0.001 }), day("2026-11-03", { EC2: 0.25 }, true)],
  });
  ce.on(GetCostAndUsageCommand, APP_FILTER).resolves({
    ResultsByTime: [{ TimePeriod: { Start: "2026-11-01", End: "" }, Groups: [{ Keys: ["AWS Lambda"], Metrics: { UnblendedCost: { Amount: "0.5", Unit: "USD" } } }, { Keys: [COMPUTE], Metrics: { UnblendedCost: { Amount: "1.25", Unit: "USD" } } }, { Keys: ["Tiny"], Metrics: { UnblendedCost: { Amount: "0.001", Unit: "USD" } } }] }],
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
    expect(accountCalls()[0]!.args[0].input.TimePeriod).toEqual({ Start: "2026-11-01", End: "2026-11-04" });
    expect(ce.commandCalls(GetCostForecastCommand)[0]!.args[0].input.TimePeriod).toEqual({ Start: "2026-11-03", End: "2026-12-01" });
  });

  it("tells the instance's costs apart by usage type, per part and per day", async () => {
    ce.on(GetCostAndUsageCommand).resolves({
      ResultsByTime: [
        day("2026-11-01", { [`${COMPUTE}|EU-BoxUsage:t4g.medium`]: 0.8, "EC2 - Other|EU-EBS:VolumeUsage.gp3": 0.08, "Amazon Virtual Private Cloud|EU-PublicIPv4:InUseAddress": 0.12, "Amazon DynamoDB|EU-TimedStorage-ByteHrs": 1 }),
        day("2026-11-02", { [`${COMPUTE}|EU-CPUCredits:t4g`]: 0.001, "EC2 - Other|EU-EBS:VolumeUsage.gp3": 0.08, "EC2 - Other|EU-DataTransfer-Out-Bytes": 0.5 }),
      ],
    });
    const c = await monthCosts(NOW);
    expect(c.instance.amount).toBeCloseTo(1.081);
    expect(c.instance.parts).toEqual([
      { name: "Running time", amount: expect.closeTo(0.801) },
      { name: "Disk", amount: expect.closeTo(0.16) },
      { name: "Public IPv4", amount: 0.12 },
    ]);
    expect(c.days.map((d) => [d.amount, d.instance])).toEqual([
      [2, expect.closeTo(1)],
      [0.581, expect.closeTo(0.081)],
    ]);
    // The services are still summed over their usage types.
    expect(c.services[0]).toEqual({ name: "Amazon DynamoDB", amount: 1 });
    expect(accountCalls()[0]!.args[0].input.GroupBy?.map((g) => g.Key)).toEqual(["SERVICE", "USAGE_TYPE"]);
  });

  it("counts only the instance's usage types", () => {
    expect(instancePart(COMPUTE, "BoxUsage:t4g.medium")).toBe("Running time");
    expect(instancePart("EC2 - Other", "EU-EBS:SnapshotUsage")).toBe("Disk");
    expect(instancePart("EC2 - Other", "EU-DataTransfer-Regional-Bytes")).toBeUndefined();
    expect(instancePart("EC2 - Other", "EU-NatGateway-Hours")).toBeUndefined();
    expect(instancePart("Amazon Relational Database Service", "EU-BoxUsage:db.t4g.micro")).toBeUndefined();
  });

  it("adds up a day that comes back in two pages once", async () => {
    ce.on(GetCostAndUsageCommand)
      .resolvesOnce({ ResultsByTime: [day("2026-11-01", { EC2: 1 })], NextPageToken: "p2" })
      .resolves({ ResultsByTime: [day("2026-11-01", { S3: 2 })] });
    const c = await monthCosts(NOW);
    expect(c.days).toEqual([{ date: "2026-11-01", amount: 3, instance: 0, estimated: false }]);
  });

  it("adds this app's tagged resources by service", async () => {
    const c = await monthCosts(NOW);
    expect(c.app).toEqual({
      name: "claude-ec2",
      amount: expect.closeTo(1.751),
      services: [
        { name: COMPUTE, amount: 1.25 },
        { name: "AWS Lambda", amount: 0.5 },
      ],
    });
    const call = ce.commandCalls(GetCostAndUsageCommand, APP_FILTER)[0]!.args[0].input;
    expect(call).toMatchObject({ TimePeriod: { Start: "2026-11-01", End: "2026-11-04" }, Granularity: "MONTHLY", GroupBy: [{ Key: "SERVICE" }] });
  });

  it("shows the rest when the app's costs fail", async () => {
    ce.on(GetCostAndUsageCommand, APP_FILTER).rejects(new Error("throttled"));
    const c = await monthCosts(NOW);
    expect(c.app).toBeNull();
    expect(c.total).toBeCloseTo(3.751);
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
    expect(accountCalls()[1]!.args[0].input.NextPageToken).toBe("p2");
  });

  it("asks Cost Explorer again only after the cache time or in a new month", async () => {
    await cachedMonthCosts(NOW);
    await Promise.all([cachedMonthCosts(new Date(NOW.getTime() + 1000)), cachedMonthCosts(new Date(NOW.getTime() + CACHE_MS - 1))]);
    expect(accountCalls()).toHaveLength(1);
    await cachedMonthCosts(new Date(NOW.getTime() + CACHE_MS));
    expect(accountCalls()).toHaveLength(2);
    await cachedMonthCosts(new Date("2026-12-01T00:00:00Z"));
    expect(accountCalls()).toHaveLength(3);
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
