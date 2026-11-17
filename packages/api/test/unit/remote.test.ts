import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { commandLine, shellQuote } from "../../src/remote.ts";

describe("commandLine", () => {
  it("passes the script and awkward arguments through sh unchanged", () => {
    const script = 'printf "%s|" "$@"; echo "$(echo nested)"';
    const args = ["plain", "it's", "$HOME `id` ; rm -rf /", "", "new\nline"];
    // AWS-RunShellScript runs the command with sh.
    const out = execFileSync("sh", ["-c", commandLine(script, args)], { encoding: "utf8" });
    expect(out).toBe(`${args.join("|")}|nested\n`);
  });

  it("quotes single quotes", () => expect(shellQuote("a'b")).toBe(`'a'\\''b'`));
});
