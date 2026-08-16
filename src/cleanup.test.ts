import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cleanupAppleScripts } from "./cleanup.js";

test("cleanup AppleScripts compile without contacting Calendar", () => {
  const directory = mkdtempSync(join(tmpdir(), "calendar-tetris-cleanup-"));
  try {
    for (const [name, script] of Object.entries(cleanupAppleScripts)) {
      execFileSync("/usr/bin/osacompile", ["-o", join(directory, `${name}.scpt`), "-e", script]);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
