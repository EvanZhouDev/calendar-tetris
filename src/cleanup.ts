import { runAppleScript, runJXAScript } from "./applescript.js";
import { calendarPrefix, ownerMarker } from "./calendar.js";
import { removeLegacyState } from "./state.js";

export interface CleanupResult {
  removed: string[];
}

interface ClearResult {
  name: string;
  eventCount: number;
}

export async function cleanupManagedCalendars(): Promise<CleanupResult> {
  // Discovery, ownership validation, and every event clear happen inside one
  // Calendar AppleScript process. This avoids process startup per calendar and
  // lets Calendar serialize the complete batch itself.
  const cleared = parseClearResults(
    await runAppleScript(clearAllManagedCalendarsScript, [ownerMarker, calendarPrefix]),
  );
  if (cleared.length === 0) {
    await removeLegacyState();
    return { removed: [] };
  }

  const uncleared = cleared.filter((calendar) => calendar.eventCount !== 0);
  if (uncleared.length > 0) {
    throw new Error(
      [
        "Cleanup incomplete. Calendar did not clear every owned event:",
        ...uncleared.map((calendar) => `  ${calendar.name}: ${calendar.eventCount} event(s) remain`),
        "",
        "Try again: npx calendar-tetris cleanup",
      ].join("\n"),
    );
  }

  const names = cleared.map((calendar) => calendar.name);
  let eventKitError: unknown;
  try {
    // Calendar.app's AppleScript delete command cannot remove calendars on
    // current macOS. EventKit is Apple's supported calendar-removal API. Queue
    // every removal with commit=false, then commit once.
    await runJXAScript(removeCalendarsWithEventKitScript, names);
  } catch (error) {
    eventKitError = error;
  }

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

function parseClearResults(output: string): ClearResult[] {
  if (!output) return [];
  return output.split(/\r?\n/u).filter(Boolean).map((line) => {
    const [name, count] = line.split("\t");
    const eventCount = Number.parseInt(count ?? "", 10);
    if (!name || !Number.isInteger(eventCount)) {
      throw new Error(`Calendar returned an invalid cleanup record: ${line}`);
    }
    return { name, eventCount };
  });
}

function parseNames(output: string): string[] {
  if (!output) return [];
  return [...new Set(output.split(/\r?\n/u).filter(Boolean))];
}

const clearAllManagedCalendarsScript = String.raw`
on run argv
    set ownerMarker to item 1 of argv
    set namePrefix to item 2 of argv
    set ownedCalendars to {}
    set ownedNames to {}
    tell application "Calendar"
        with timeout of 3600 seconds
            -- The marker remains authoritative even if a game calendar was
            -- renamed. Fetch these references without reading EventKit IDs.
            set markedCalendars to every calendar whose description is ownerMarker
            repeat with calendarReference in markedCalendars
                set end of ownedCalendars to contents of calendarReference
                set end of ownedNames to name of calendarReference
            end repeat

            -- Recover only empty, blank-description partials created by older
            -- setup builds. A nonempty or differently marked calendar is never
            -- adopted by its name alone.
            repeat with calendarReference in every calendar
                set calendarName to name of calendarReference
                if calendarName starts with namePrefix and not my listContains(ownedNames, calendarName) then
                    set currentDescription to description of calendarReference
                    set descriptionIsBlank to currentDescription is missing value
                    if not descriptionIsBlank then set descriptionIsBlank to currentDescription is ""
                    if descriptionIsBlank and (count of events of calendarReference) is 0 then
                        set description of calendarReference to ownerMarker
                        set end of ownedCalendars to contents of calendarReference
                        set end of ownedNames to calendarName
                    end if
                end if
            end repeat

            -- Validate every event before performing any destructive action.
            repeat with calendarReference in ownedCalendars
                set eventDescriptions to description of every event of calendarReference
                repeat with eventDescription in eventDescriptions
                    if contents of eventDescription is not ownerMarker then
                        error "Refusing to clear an unowned event from " & (name of calendarReference)
                    end if
                end repeat
            end repeat

            -- Retry the whole clear batch inside this one osascript process.
            -- Calendar sometimes returns -10000 after accepting a deletion.
            repeat with passIndex from 1 to 4
                repeat with calendarReference in ownedCalendars
                    if (count of events of calendarReference) is greater than 0 then
                        try
                            tell calendarReference to delete every event
                        on error errorMessage number errorNumber
                            if errorNumber is not -10000 then error errorMessage number errorNumber
                        end try
                    end if
                end repeat
                if passIndex is less than 4 then delay 0.25
            end repeat

            set outputLines to {}
            repeat with calendarReference in ownedCalendars
                set end of outputLines to (name of calendarReference) & tab & (count of events of calendarReference)
            end repeat
        end timeout
    end tell
    set AppleScript's text item delimiters to linefeed
    return outputLines as text
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

  const allCalendars = store.calendarsForEntityType($.EKEntityTypeEvent);
  const removals = [];
  for (const name of argv) {
    const matches = [];
    for (let index = 0; index < allCalendars.count; index += 1) {
      const calendar = allCalendars.objectAtIndex(index);
      if (ObjC.unwrap(calendar.title) === name) matches.push(calendar);
    }
    if (matches.length === 0) continue;
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

export const cleanupAppleScripts = {
  clearAll: clearAllManagedCalendarsScript,
  remaining: listRemainingManagedCalendarsScript,
} as const;

export const cleanupJXAScripts = {
  removeCalendars: removeCalendarsWithEventKitScript,
} as const;
