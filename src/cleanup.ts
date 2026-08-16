import { calendarPrefix, ownerMarker } from "./calendar.js";
import { runAppleScript } from "./applescript.js";
import {
  clearRecordedCalendars,
  loadState,
  markPermissionGranted,
} from "./state.js";

export interface CleanupResult {
  removed: string[];
}

interface Candidate {
  identifier: string;
  name: string;
}

export async function cleanupManagedCalendars(): Promise<CleanupResult> {
  const state = await loadState();
  const recordedIdentifiers = state.calendars.map((calendar) => calendar.identifier);
  const candidates = parseCandidates(
    await runAppleScript(listManagedCalendarsScript, [
      ownerMarker,
      calendarPrefix,
      String(recordedIdentifiers.length),
      ...recordedIdentifiers,
    ]),
  );
  // A successful Calendar query proves that Automation access is currently
  // available, even when there was nothing left to clean up.
  await markPermissionGranted();
  if (candidates.length === 0) {
    await clearRecordedCalendars();
    return { removed: [] };
  }

  await runAppleScript(clearManagedCalendarsScript, [
    ownerMarker,
    String(candidates.length),
    ...candidates.map((calendar) => calendar.identifier),
  ]);

  const failures: string[] = [];
  for (const candidate of candidates) {
    let removed = false;
    let lastError: unknown;
    for (const wait of [0, 250, 750, 1_500]) {
      if (wait > 0) await delay(wait);
      try {
        await runAppleScript(deleteManagedCalendarScript, [
          ownerMarker,
          candidate.identifier,
        ]);
      } catch (error) {
        // Calendar frequently reports -10000 after accepting a deletion. The
        // identifier existence check is the postcondition that matters.
        lastError = error;
      }
      if (!(await managedCalendarExists(candidate.identifier))) {
        removed = true;
        break;
      }
    }
    if (!removed) {
      const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
      failures.push(`${candidate.name}${detail}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Calendar would not remove ${failures.length} empty game calendar(s):\n${failures.join("\n")}`,
    );
  }
  await clearRecordedCalendars();
  return { removed: candidates.map((candidate) => candidate.name) };
}

async function managedCalendarExists(identifier: string): Promise<boolean> {
  return (await runAppleScript(managedCalendarExistsScript, [identifier])) === "true";
}

function parseCandidates(output: string): Candidate[] {
  if (!output) return [];
  return output.split(/\r?\n/u).map((line) => {
    const [identifier, name] = line.split("\t");
    if (!identifier || !name) throw new Error(`Calendar returned an invalid cleanup record: ${line}`);
    return { identifier, name };
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const listManagedCalendarsScript = String.raw`
on run argv
    set ownerMarker to item 1 of argv
    set namePrefix to item 2 of argv
    set identifierCount to (item 3 of argv) as integer
    set recordedIdentifiers to {}
    repeat with identifierIndex from 1 to identifierCount
        set end of recordedIdentifiers to item (identifierIndex + 3) of argv
    end repeat
    set outputLines to {}
    tell application "Calendar"
        repeat with calendarReference in every calendar
            set calendarName to name of calendarReference
            set calendarID to calendarIdentifier of calendarReference
            set isRecorded to my listContains(recordedIdentifiers, calendarID)
            if description of calendarReference is ownerMarker and (calendarName starts with namePrefix or isRecorded) then
                set end of outputLines to calendarID & tab & calendarName
            end if
        end repeat
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

const clearManagedCalendarsScript = String.raw`
on run argv
    set ownerMarker to item 1 of argv
    set identifierCount to (item 2 of argv) as integer
    set ownedCalendars to {}
    tell application "Calendar"
        with timeout of 3600 seconds
            repeat with identifierIndex from 1 to identifierCount
                set calendarID to item (identifierIndex + 2) of argv
                set matches to every calendar whose calendarIdentifier is calendarID
                if (count of matches) is 1 then
                    set targetCalendar to item 1 of matches
                    if description of targetCalendar is not ownerMarker then error "Refusing to clear an unowned calendar"
                    tell targetCalendar to set eventDescriptions to description of every event
                    repeat with eventDescription in eventDescriptions
                        if contents of eventDescription is not ownerMarker then error "A game calendar contains an unowned event: " & (name of targetCalendar)
                    end repeat
                    set end of ownedCalendars to targetCalendar
                end if
            end repeat
            ignoring application responses
                repeat with targetCalendar in ownedCalendars
                    tell contents of targetCalendar to delete every event
                end repeat
            end ignoring
            get count of calendars
            save
        end timeout
    end tell
end run
`;

const deleteManagedCalendarScript = String.raw`
on run argv
    set ownerMarker to item 1 of argv
    set calendarID to item 2 of argv
    tell application "Calendar"
        with timeout of 3600 seconds
            set matches to every calendar whose calendarIdentifier is calendarID
            if (count of matches) is 1 then
                set targetCalendar to item 1 of matches
                if description of targetCalendar is not ownerMarker then error "Refusing to delete an unowned calendar"
                if (count of events of targetCalendar) is not 0 then error "Refusing to delete a nonempty game calendar"
                ignoring application responses
                    delete targetCalendar
                end ignoring
                get count of calendars
            end if
        end timeout
    end tell
end run
`;

const managedCalendarExistsScript = String.raw`
on run argv
    set calendarID to item 1 of argv
    tell application "Calendar" to return (count of (every calendar whose calendarIdentifier is calendarID)) is greater than 0
end run
`;

export const cleanupAppleScripts = {
  list: listManagedCalendarsScript,
  clear: clearManagedCalendarsScript,
  deleteOne: deleteManagedCalendarScript,
  exists: managedCalendarExistsScript,
} as const;
