import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { cleanupAppleScripts, cleanupJXAScripts } from "./cleanup.js";

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

test("cleanup EventKit JXA scripts compile without contacting Calendar", () => {
  const directory = mkdtempSync(join(tmpdir(), "calendar-tetris-eventkit-"));
  try {
    for (const [name, script] of Object.entries(cleanupJXAScripts)) {
      execFileSync("/usr/bin/osacompile", [
        "-l", "JavaScript", "-o", join(directory, `${name}.scpt`), "-e", script,
      ]);
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
  assert.match(cleanupAppleScripts.clearAll, /whose description is ownerMarker/u);
  assert.match(cleanupAppleScripts.clearAll, /descriptionIsBlank and \(count of events/u);
});

test("cleanup uses fresh postconditions instead of save barriers", () => {
  for (const script of Object.values(cleanupAppleScripts)) {
    assert.doesNotMatch(script, /get count of calendars/u);
    assert.doesNotMatch(script, /^\s*save\s*$/mu);
  }
});

test("cleanup clears every calendar in one AppleScript batch", () => {
  assert.match(cleanupAppleScripts.clearAll, /repeat with calendarReference in ownedCalendars/u);
  assert.match(cleanupAppleScripts.clearAll, /delete every event/u);
  assert.doesNotMatch(cleanupAppleScripts.clearAll, /ignoring application responses/u);
  assert.doesNotMatch(cleanupAppleScripts.clearAll, /delete targetCalendar/u);
});

test("EventKit batches calendar removal into one commit", () => {
  const script = cleanupJXAScripts.removeCalendars;
  assert.match(script, /removeCalendarCommitError\(calendar, false/u);
  assert.match(script, /store\.commit\(commitError\)/u);
  assert.match(script, /requestFullAccessToEventsWithCompletion/u);
  assert.match(script, /NSRunLoop\.currentRunLoop\.runUntilDate/u);
  assert.doesNotMatch(script, /dispatch_group/u);
});
