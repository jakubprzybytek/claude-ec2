import { describe, expect, it } from "vitest";
import { accessOf, groupsOf } from "../../src/access.ts";

describe("groupsOf", () => {
  it("reads the forms API Gateway passes", () => {
    expect(groupsOf({ "cognito:groups": ["a", "b"] })).toEqual(["a", "b"]);
    expect(groupsOf({ "cognito:groups": "[a b]" })).toEqual(["a", "b"]);
    expect(groupsOf({ "cognito:groups": '["a","b"]' })).toEqual(["a", "b"]);
    expect(groupsOf({ "cognito:groups": "" })).toEqual([]);
    expect(groupsOf({})).toEqual([]);
    expect(groupsOf(undefined)).toEqual([]);
  });
});

describe("accessOf", () => {
  const env = { FULL_ACCESS_GROUPS: "claude-ec2", READ_ONLY_GROUPS: "claude-ec2-test" };
  it("gives full access to the app's group", () => expect(accessOf({ "cognito:groups": "[other claude-ec2]" }, env)).toBe("full"));
  it("gives read-only access to the test group", () => expect(accessOf({ "cognito:groups": "[claude-ec2-test]" }, env)).toBe("read"));
  it("refuses other users of the shared pool", () => expect(accessOf({ "cognito:groups": "[portfolio-tracker]" }, env)).toBe("none"));
  it("refuses the test group where it is not configured (prod)", () =>
    expect(accessOf({ "cognito:groups": "[claude-ec2-test]" }, { FULL_ACCESS_GROUPS: "claude-ec2" })).toBe("none"));
  it("does not match on substrings", () => expect(accessOf({ "cognito:groups": "[claude-ec2-admin]" }, env)).toBe("none"));
});
