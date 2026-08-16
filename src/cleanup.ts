import { calendarPrefix, ownerMarker } from "./calendar.js";
import { runAppleScript } from "./applescript.js";
import { removeLegacyState } from "./state.js";

export interface CleanupResult {
  removed: string[];
}

export async function cleanupManagedCalendars(): Promise<CleanupResult> {
  const candidates = parseNames(
    await retryTransient(() =>
      runAppleScript(listManagedCalendarsScript, [ownerMarker, calendarPrefix]),
    ),
  );
  if (candidates.length === 0) {
    await removeLegacyState();
    return { removed: [] };
  }

  const failures: string[] = [];
  for (const name of candidates) {
    try {
      await clearCalendar(name);
      await deleteCalendar(name);
    } catch (error) {
      failures.push(`${name}\n    ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      [
        "Cleanup incomplete.",
        `Calendar still contains ${failures.length} Calendar Tetris calendar(s):`,
        ...failures.map((failure) => `  ${failure}`),
        "",
        "Try again: npx calendar-tetris cleanup",
      ].join("\n"),
    );
  }

  await removeLegacyState();
  return { removed: candidates };
}

async function clearCalendar(name: string): Promise<void> {
  let lastError: unknown;
  for (const wait of [0, 250, 750, 1_500, 2_500]) {
    if (wait > 0) await delay(wait);
    try {
      await runAppleScript(clearManagedCalendarScript, [ownerMarker, name]);
    } catch (error) {
      lastError = error;
    }
    const eventCount = await managedEventCount(name);
    if (eventCount === null || eventCount === 0) return;
  }
  const detail = lastError instanceof Error ? lastError.message : "Calendar kept the events.";
  throw new Error(`Could not clear its ${await managedEventCount(name)} event(s). Last response: ${detail}`);
}

async function deleteCalendar(name: string): Promise<void> {
  let lastError: unknown;
  for (const wait of [0, 250, 750, 1_500, 2_500]) {
    if (wait > 0) await delay(wait);
    try {
      await runAppleScript(deleteManagedCalendarScript, [ownerMarker, name]);
    } catch (error) {
      // Calendar often returns -10000 after accepting deletion. The fresh
      // existence query below is the authoritative postcondition.
      lastError = error;
    }
    if (!(await managedCalendarExists(name))) return;
  }
  const detail = lastError instanceof Error ? lastError.message : "Calendar kept the calendar.";
  throw new Error(`Could not remove it. Last response: ${detail}`);
}

async function managedEventCount(name: string): Promise<number | null> {
  const output = await retryTransient(() =>
    runAppleScript(managedEventCountScript, [ownerMarker, name]),
  );
  return output === "absent" ? null : Number.parseInt(output, 10);
}

async function managedCalendarExists(name: string): Promise<boolean> {
  return (
    (await retryTransient(() =>
      runAppleScript(managedCalendarExistsScript, [ownerMarker, name]),
    )) === "true"
  );
}

async function retryTransient<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (const wait of [0, 250, 750, 1_500]) {
    if (wait > 0) await delay(wait);
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!(error instanceof Error) || !error.message.includes("-10000")) throw error;
    }
  }
  throw lastError;
}

function parseNames(output: string): string[] {
  if (!output) return [];
  return [...new Set(output.split(/\r?\n/u).filter(Boolean))];
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const listManagedCalendarsScript = String.raw`
on run argv
    set ownerMarker to item 1 of argv
    set namePrefix to item 2 of argv
    set outputNames to {}
    tell application "Calendar"
        -- The marker is the primary identity and continues to work if a user
        -- renames a game calendar. No EventKit identifier is needed.
        set ownedCalendars to every calendar whose description is ownerMarker
        repeat with calendarReference in ownedCalendars
            set end of outputNames to name of calendarReference
        end repeat

        -- Recover empty partial calendars left by older setup builds that made
        -- the calendar but lost its description property.
        repeat with calendarReference in every calendar
            set calendarName to name of calendarReference
            if calendarName starts with namePrefix and not my listContains(outputNames, calendarName) then
                set currentDescription to description of calendarReference
                set descriptionIsBlank to currentDescription is missing value
                if not descriptionIsBlank then set descriptionIsBlank to currentDescription is ""
                if descriptionIsBlank and (count of events of calendarReference) is 0 then
                    set description of calendarReference to ownerMarker
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

const clearManagedCalendarScript = String.raw`
on run argv
    set ownerMarker to item 1 of argv
    set calendarName to item 2 of argv
    tell application "Calendar"
        with timeout of 3600 seconds
            set matches to every calendar whose name is calendarName
            if (count of matches) is 0 then return "absent"
            if (count of matches) is not 1 then error "More than one calendar is named " & calendarName
            set targetCalendar to item 1 of matches
            if description of targetCalendar is not ownerMarker then error "Refusing to clear an unowned calendar"
            set eventDescriptions to description of every event of targetCalendar
            repeat with eventDescription in eventDescriptions
                if contents of eventDescription is not ownerMarker then error "Refusing to clear a calendar containing an unowned event"
            end repeat
            ignoring application responses
                tell targetCalendar to delete every event
            end ignoring
            return "submitted"
        end timeout
    end tell
end run
`;

const managedEventCountScript = String.raw`
on run argv
    set ownerMarker to item 1 of argv
    set calendarName to item 2 of argv
    tell application "Calendar"
        set matches to every calendar whose name is calendarName
        if (count of matches) is 0 then return "absent"
        if (count of matches) is not 1 then error "More than one calendar is named " & calendarName
        set targetCalendar to item 1 of matches
        if description of targetCalendar is not ownerMarker then error "Refusing to inspect an unowned calendar"
        return count of events of targetCalendar
    end tell
end run
`;

const deleteManagedCalendarScript = String.raw`
on run argv
    set ownerMarker to item 1 of argv
    set calendarName to item 2 of argv
    tell application "Calendar"
        with timeout of 3600 seconds
            set matches to every calendar whose name is calendarName
            if (count of matches) is 0 then return "absent"
            if (count of matches) is not 1 then error "More than one calendar is named " & calendarName
            set targetCalendar to item 1 of matches
            if description of targetCalendar is not ownerMarker then error "Refusing to delete an unowned calendar"
            if (count of events of targetCalendar) is not 0 then error "Calendar still contains events" number -10000
            ignoring application responses
                delete targetCalendar
            end ignoring
            return "submitted"
        end timeout
    end tell
end run
`;

const managedCalendarExistsScript = String.raw`
on run argv
    set ownerMarker to item 1 of argv
    set calendarName to item 2 of argv
    tell application "Calendar"
        set matches to every calendar whose name is calendarName
        if (count of matches) is 0 then return false
        if (count of matches) is not 1 then return true
        return description of item 1 of matches is ownerMarker
    end tell
end run
`;

export const cleanupAppleScripts = {
  list: listManagedCalendarsScript,
  clearOne: clearManagedCalendarScript,
  eventCount: managedEventCountScript,
  deleteOne: deleteManagedCalendarScript,
  exists: managedCalendarExistsScript,
} as const;
