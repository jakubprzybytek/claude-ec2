import { describe, expect, it } from "vitest";
import type { Costs } from "../../src/api.ts";
import { COSTS_FRESH_MS, costsFresh } from "../../src/costsCache.ts";

const NOW = Date.parse("2026-11-25T20:00:00Z");
const costs: Costs = {
  month: "2026-11",
  currency: "USD",
  total: 40,
  forecast: 80,
  services: [],
  instance: { amount: 7.5, parts: [] },
  app: { name: "claude-ec2", amount: 1, services: [] },
  days: [],
  updatedAt: NOW,
};

describe("saved costs answer", () => {
  it("is used while under the fresh time", () => {
    expect(costsFresh({ data: costs, at: NOW - COSTS_FRESH_MS + 1000 }, NOW)).toBe(true);
    expect(costsFresh({ data: costs, at: NOW - COSTS_FRESH_MS }, NOW)).toBe(false);
  });

  it("is asked again in a new month", () => {
    expect(costsFresh({ data: costs, at: NOW - 60_000 }, Date.parse("2026-12-01T00:00:30Z"))).toBe(false);
  });

  it("is not kept when it was a note or lacks fields the card reads", () => {
    expect(costsFresh({ data: { unavailable: "no access" }, at: NOW }, NOW)).toBe(false);
    const { app: _app, ...old } = costs;
    expect(costsFresh({ data: old as Costs, at: NOW }, NOW)).toBe(false);
    expect(costsFresh({ data: { ...costs, app: null }, at: NOW }, NOW)).toBe(true);
  });
});
