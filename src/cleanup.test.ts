import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
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

test("cleanup never depends on EventKit calendar identifiers", () => {
  for (const script of Object.values(cleanupAppleScripts)) {
    assert.doesNotMatch(script, /calendarIdentifier/u);
  }
});

test("cleanup recognizes only owned calendars and empty legacy partials", () => {
  assert.match(cleanupAppleScripts.list, /whose description is ownerMarker/u);
  assert.match(cleanupAppleScripts.list, /descriptionIsBlank and \(count of events/u);
});

test("cleanup uses fresh postconditions instead of save barriers", () => {
  for (const script of Object.values(cleanupAppleScripts)) {
    assert.doesNotMatch(script, /get count of calendars/u);
    assert.doesNotMatch(script, /^\s*save\s*$/mu);
  }
});
