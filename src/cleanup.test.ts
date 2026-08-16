import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { cleanupAppleScripts, cleanupJXAScripts, cleanupManagedCalendars } from "./cleanup.js";

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
  assert.match(cleanupAppleScripts.discover, /whose description is ownerMarker/u);
  assert.match(cleanupAppleScripts.discover, /descriptionIsBlank and \(count of events/u);
});

test("cleanup uses fresh postconditions instead of save barriers", () => {
  for (const script of Object.values(cleanupAppleScripts)) {
    assert.doesNotMatch(script, /get count of calendars/u);
    assert.doesNotMatch(script, /^\s*save\s*$/mu);
  }
});

test("cleanup never clears events individually before removing their calendar", () => {
  assert.doesNotMatch(cleanupAppleScripts.discover, /delete every event/u);
  assert.doesNotMatch(cleanupAppleScripts.discover, /delete targetCalendar/u);
  assert.doesNotMatch(cleanupAppleScripts.discover, /set description of/u);
});

test("cleanup requests both permissions before mutation", () => {
  const script = cleanupJXAScripts.requestAccess;
  assert.match(script, /Application\("Calendar"\)\.calendars\.length/u);
  assert.match(script, /requestFullAccessToEventsWithCompletion/u);
  assert.match(script, /NSRunLoop\.currentRunLoop\.runUntilDate/u);
  assert.doesNotMatch(script, /dispatch_group/u);
});

test("permission status can be checked without triggering a prompt", () => {
  const script = cleanupJXAScripts.accessStatus;
  assert.match(script, /authorizationStatusForEntityType/u);
  assert.doesNotMatch(script, /requestFullAccessToEventsWithCompletion/u);
  assert.doesNotMatch(script, /Application\("Calendar"\)/u);
});

test("cleanup presents its work as two user-facing steps", () => {
  const source = cleanupManagedCalendars.toString();
  assert.match(source, /\[1\/2\] Checking permissions/u);
  assert.match(source, /\[2\/2\] Removing Game Calendars/u);
  assert.doesNotMatch(source, /\[\d+\/4\]/u);
});

test("EventKit batches calendar removal into one commit", () => {
  const script = cleanupJXAScripts.removeCalendars;
  assert.match(script, /removeCalendarCommitError\(calendar, false/u);
  assert.match(script, /store\.commit\(commitError\)/u);
  assert.doesNotMatch(script, /requestFullAccessToEventsWithCompletion/u);
});
