import { describe, expect, it } from "vitest";
import { expiresIn, loginNeedsAttention } from "../../src/LoginCard.tsx";

const NOW = 1_800_000_000;
const DAY = 86_400;

describe("Claude Code login", () => {
  it("says when the login expires", () => {
    expect(expiresIn(NOW + 29 * DAY + 5, NOW)).toBe("in 29 days");
    expect(expiresIn(NOW + 2 * DAY, NOW)).toBe("in 2 days");
    expect(expiresIn(NOW + 30 * 3600, NOW)).toBe("in 30 hours");
    expect(expiresIn(NOW + 600, NOW)).toBe("in 1 hour");
    expect(expiresIn(NOW - 1, NOW)).toBe("now");
  });

  it("needs attention when logged out or expiring within a week", () => {
    expect(loginNeedsAttention({ loggedIn: false }, NOW)).toBe(true);
    expect(loginNeedsAttention({ loggedIn: true, expiresAt: NOW + 6 * DAY }, NOW)).toBe(true);
    expect(loginNeedsAttention({ loggedIn: true, expiresAt: NOW + 8 * DAY }, NOW)).toBe(false);
    expect(loginNeedsAttention({ loggedIn: true, expiresAt: null }, NOW)).toBe(false);
    // `claude auth status` failed: unknown, not shown as logged out.
    expect(loginNeedsAttention({ loggedIn: null, error: "timeout" }, NOW)).toBe(false);
    expect(loginNeedsAttention(undefined, NOW)).toBe(false);
  });
});
