import { runAppleScript, runJXAScript } from "./applescript.js";
import { calendarPrefix, ownerMarker } from "./calendar.js";
import { removeLegacyState } from "./state.js";

export interface CleanupResult {
  removed: string[];
}

export type CleanupProgress = (message: string) => void;

export async function cleanupManagedCalendars(
  progress?: CleanupProgress,
): Promise<CleanupResult> {
  // Trigger both native permission prompts before performing any mutation.
  // macOS only presents them while authorization is undetermined.
  progress?.("[1/4] Checking permissions");
  await runJXAScript(requestCleanupAccessScript);

  // Discover marker-owned calendars without changing their events. EventKit
  // removes each calendar and all of its events as one operation, so clearing
  // hundreds of events through Calendar first would only make cleanup slower.
  progress?.("[2/4] Finding Calendar Tetris calendars");
  const names = parseNames(
    await runAppleScript(discoverManagedCalendarsScript, [ownerMarker, calendarPrefix]),
  );
  if (names.length === 0) {
    await removeLegacyState();
    return { removed: [] };
  }

  let eventKitError: unknown;
  try {
    // Calendar.app's AppleScript delete command cannot remove calendars on
    // current macOS. EventKit is Apple's supported calendar-removal API. Queue
    // every removal with commit=false, then commit once.
    progress?.(`[3/4] Removing ${names.length} game calendar(s)`);
    await runJXAScript(removeCalendarsWithEventKitScript, names);
  } catch (error) {
    eventKitError = error;
  }

  progress?.("[4/4] Verifying cleanup");
  const remaining = parseNames(
    await runAppleScript(listRemainingManagedCalendarsScript, [ownerMarker, calendarPrefix]),
  );
  if (remaining.length > 0) {
    const detail = eventKitError instanceof Error
      ? eventKitError.message
      : "EventKit returned without removing the calendars.";
    throw new Error(
      [
        "Cleanup incomplete.",
        `Calendar still contains ${remaining.length} Calendar Tetris calendar(s):`,
        ...remaining.map((name) => `  ${name}`),
        "",
        `EventKit response: ${detail}`,
        "Try again: npx calendar-tetris cleanup",
      ].join("\n"),
      { cause: eventKitError },
    );
  }

  await removeLegacyState();
  return { removed: names };
}

function parseNames(output: string): string[] {
  if (!output) return [];
  return [...new Set(output.split(/\r?\n/u).filter(Boolean))];
}

const discoverManagedCalendarsScript = String.raw`
on run argv
    set ownerMarker to item 1 of argv
    set namePrefix to item 2 of argv
    set ownedNames to {}
    tell application "Calendar"
        with timeout of 3600 seconds
            -- The marker remains authoritative even if a game calendar was
            -- renamed. Fetch these references without reading EventKit IDs.
            set markedCalendars to every calendar whose description is ownerMarker
            repeat with calendarReference in markedCalendars
                set end of ownedNames to name of calendarReference
            end repeat

            -- Include only empty, blank-description partials left by older
            -- setup builds. A nonempty or differently marked calendar is never
            -- selected by its name alone.
            repeat with calendarReference in every calendar
                set calendarName to name of calendarReference
                if calendarName starts with namePrefix and not my listContains(ownedNames, calendarName) then
                    set currentDescription to description of calendarReference
                    set descriptionIsBlank to currentDescription is missing value
                    if not descriptionIsBlank then set descriptionIsBlank to currentDescription is ""
                    if descriptionIsBlank and (count of events of calendarReference) is 0 then
                        set end of ownedNames to calendarName
                    end if
                end if
            end repeat
        end timeout
    end tell
    set AppleScript's text item delimiters to linefeed
    return ownedNames as text
end run

on listContains(values, targetValue)
    repeat with candidate in values
        if contents of candidate is targetValue then return true
    end repeat
    return false
end listContains
`;

const listRemainingManagedCalendarsScript = String.raw`
on run argv
    set ownerMarker to item 1 of argv
    set namePrefix to item 2 of argv
    set outputNames to {}
    tell application "Calendar"
        set markedCalendars to every calendar whose description is ownerMarker
        repeat with calendarReference in markedCalendars
            set end of outputNames to name of calendarReference
        end repeat
        repeat with calendarReference in every calendar
            set calendarName to name of calendarReference
            if calendarName starts with namePrefix and not my listContains(outputNames, calendarName) then
                set currentDescription to description of calendarReference
                set descriptionIsBlank to currentDescription is missing value
                if not descriptionIsBlank then set descriptionIsBlank to currentDescription is ""
                if descriptionIsBlank and (count of events of calendarReference) is 0 then
                    set end of outputNames to calendarName
                end if
            end if
        end repeat
    end tell
    set AppleScript's text item delimiters to linefeed
    return outputNames as text
end run

on listContains(values, targetValue)
    repeat with candidate in values
        if contents of candidate is targetValue then return true
    end repeat
    return false
end listContains
`;

const removeCalendarsWithEventKitScript = String.raw`
ObjC.import("EventKit");
ObjC.import("Foundation");

function run(argv) {
  const store = $.EKEventStore.alloc.init;
  const status = Number($.EKEventStore.authorizationStatusForEntityType($.EKEntityTypeEvent));
  if (status !== Number($.EKAuthorizationStatusAuthorized)) {
    throw new Error("Full Calendar Access is required to remove game calendars.");
  }
  const allCalendars = store.calendarsForEntityType($.EKEntityTypeEvent);
  const removals = [];
  for (const name of argv) {
    const matches = [];
    for (let index = 0; index < allCalendars.count; index += 1) {
      const calendar = allCalendars.objectAtIndex(index);
      if (ObjC.unwrap(calendar.title) === name) matches.push(calendar);
    }
    if (matches.length === 0) throw new Error("EventKit could not find calendar " + name);
    if (matches.length !== 1) throw new Error("More than one EventKit calendar is named " + name);
    removals.push(matches[0]);
  }

  for (const calendar of removals) {
    const removeError = Ref();
    if (!store.removeCalendarCommitError(calendar, false, removeError)) {
      store.rollback;
      throw new Error(eventKitError("Could not queue calendar removal", removeError));
    }
  }

  const commitError = Ref();
  if (!store.commit(commitError)) {
    store.rollback;
    throw new Error(eventKitError("Could not commit calendar removals", commitError));
  }
  return removals.length.toString();
}

function eventKitError(prefix, reference) {
  const error = reference[0];
  return error ? prefix + ": " + ObjC.unwrap(error.localizedDescription) : prefix;
}
`;

const requestCleanupAccessScript = String.raw`
ObjC.import("EventKit");
ObjC.import("Foundation");

function run() {
  // This AppleEvent read causes macOS to present the Automation prompt when
  // access to Calendar.app has not yet been decided.
  try {
    Application("Calendar").calendars.length;
  } catch (error) {
    throw new Error("Calendar Automation access is required. " + error.toString());
  }

  const currentStatus = Number($.EKEventStore.authorizationStatusForEntityType($.EKEntityTypeEvent));
  if (currentStatus === Number($.EKAuthorizationStatusAuthorized)) return "granted";
  if (currentStatus !== Number($.EKAuthorizationStatusNotDetermined)) {
    throw new Error("Full Calendar Access is not granted.");
  }

  // Keep osascript's run loop alive while the native EventKit permission sheet
  // is visible. The callback completes after the user chooses Allow or Deny.
  const store = $.EKEventStore.alloc.init;
  let granted = false;
  let accessFinished = false;
  let accessMessage = "Calendar access was denied.";

  store.requestFullAccessToEventsWithCompletion((allowed, error) => {
    granted = Boolean(allowed);
    if (error) accessMessage = ObjC.unwrap(error.localizedDescription);
    accessFinished = true;
  });
  while (!accessFinished) {
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.05));
  }
  if (!granted) {
    throw new Error("Full Calendar Access is required to remove game calendars. " + accessMessage);
  }
  return "granted";
}
`;

export const cleanupAppleScripts = {
  discover: discoverManagedCalendarsScript,
  remaining: listRemainingManagedCalendarsScript,
} as const;

export const cleanupJXAScripts = {
  requestAccess: requestCleanupAccessScript,
  removeCalendars: removeCalendarsWithEventKitScript,
} as const;
