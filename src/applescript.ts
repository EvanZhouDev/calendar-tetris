import { execFile } from "node:child_process";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function runAppleScript(
  script: string,
  arguments_: readonly string[] = [],
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/osascript",
      ["-l", "AppleScript", "-e", script, "--", ...arguments_],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout.trim();
  } catch (error) {
    const details = error as Error & {
      code?: number | string;
      signal?: string;
      stderr?: string | Buffer;
    };
    const stderr = details.stderr?.toString().trim();
    const reason = details.signal
      ? `osascript stopped by ${details.signal}`
      : `osascript exited with code ${details.code ?? "unknown"}`;
    throw new Error(stderr || reason, { cause: error });
  }
}

export interface ResidentReference {
  key: string;
  calendarName: string;
  eventURL: string;
}

export interface CreateEvent {
  type: "create";
  key: string;
  calendarName: string;
  eventURL: string;
  start: number;
  end: number;
  summary: string;
  allDay: boolean;
}

export interface ReplaceEvent extends Omit<CreateEvent, "type"> {
  type: "replace";
}

export interface MutateEvent {
  type: "mutate";
  key: string;
  start: number;
  end: number;
  updateStart: boolean;
  updateEnd: boolean;
  updateSummary: boolean;
  summary: string;
}

export type CalendarUpdate = CreateEvent | ReplaceEvent | MutateEvent;

interface Waiter {
  resolve: (line: string) => void;
  reject: (error: Error) => void;
}

export class CalendarWorker {
  private readonly waiters: Waiter[] = [];
  private stdoutBuffer = "";
  private stderr = "";
  private stopped = false;

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.acceptOutput(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
    child.once("exit", (code, signal) => {
      this.stopped = true;
      const detail = this.stderr.trim();
      const reason = signal
        ? `Calendar worker stopped by ${signal}`
        : `Calendar worker exited with code ${code ?? "unknown"}`;
      const error = new Error(detail || reason);
      for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    });
  }

  static async start(
    ownerMarker: string,
    references: readonly ResidentReference[] = [],
  ): Promise<CalendarWorker> {
    const arguments_ = [
      ownerMarker,
      String(references.length),
      ...references.flatMap((reference) => [
        reference.key,
        reference.calendarName,
        reference.eventURL,
      ]),
    ];
    const child = spawn(
      "/usr/bin/osascript",
      ["-l", "AppleScript", "-e", residentWorkerScript, "--", ...arguments_],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const worker = new CalendarWorker(child);
    const response = await worker.nextLine();
    if (response !== "READY") {
      await worker.close().catch(() => {});
      throw responseError(response);
    }
    return worker;
  }

  async update(updates: readonly CalendarUpdate[]): Promise<void> {
    if (updates.length === 0) return;
    for (const update of updates) {
      if (update.type === "mutate" && update.updateStart && update.updateEnd) {
        throw new TypeError("A resident mutation may change only one event bound.");
      }
    }

    const command = ["FRAME", ...updates.map(serializeUpdate)].join("|");
    const responsePromise = this.nextLine();
    this.child.stdin.write(`${command}\n`);
    const response = await responsePromise;
    if (!response.startsWith("ACK|")) throw responseError(response);
  }

  async close(): Promise<void> {
    if (this.stopped) return;
    const responsePromise = this.nextLine();
    this.child.stdin.write("STOP\n");
    const response = await responsePromise;
    if (response !== "STOPPED") throw responseError(response);
    this.child.stdin.end();
    this.stopped = true;
  }

  private nextLine(): Promise<string> {
    if (this.stopped) return Promise.reject(new Error("Calendar worker is not running."));
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  private acceptOutput(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/u, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      this.waiters.shift()?.resolve(line);
    }
  }
}

function serializeUpdate(update: CalendarUpdate): string {
  if (update.type === "mutate") {
    return [
      "M",
      update.key,
      update.start,
      update.end,
      Number(update.updateStart),
      Number(update.updateEnd),
      Number(update.updateSummary),
      encodeURIComponent(update.summary),
    ].join(",");
  }
  return [
    update.type === "create" ? "C" : "R",
    update.key,
    update.calendarName,
    update.eventURL,
    update.start,
    update.end,
    encodeURIComponent(update.summary),
    Number(update.allDay),
  ].join(",");
}

function responseError(response: string): Error {
  if (!response.startsWith("ERROR|")) return new Error(response);
  const [, phase = "worker", number = "unknown", encoded = "Calendar update failed"] =
    response.split("|");
  return new Error(`${phase}: ${number}: ${decodeURIComponent(encoded)}`);
}

const residentWorkerScript = String.raw`
use framework "Foundation"
use scripting additions

on run argv
    set ownerMarker to item 1 of argv
    set slotCount to (item 2 of argv) as integer
    set eventKeys to {}
    set eventReferences to {}
    set inputHandle to current application's NSFileHandle's fileHandleWithStandardInput()
    set outputHandle to current application's NSFileHandle's fileHandleWithStandardOutput()

    set weekStart to current date
    set time of weekStart to 0
    set weekStart to weekStart + (1 - (weekday of weekStart as integer)) * days

    try
        tell application "Calendar"
            with timeout of 3600 seconds
                repeat with slotIndex from 0 to slotCount - 1
                    set argumentOffset to 3 + slotIndex * 3
                    set eventKey to item argumentOffset of argv
                    set calendarName to item (argumentOffset + 1) of argv
                    set eventURL to item (argumentOffset + 2) of argv
                    set targetCalendar to calendar calendarName
                    if description of targetCalendar is not ownerMarker then error "Unowned calendar " & calendarName
                    tell targetCalendar to set targetEvent to first event whose url is eventURL
                    if description of targetEvent is not ownerMarker then error "Unowned event " & eventKey
                    set end of eventKeys to eventKey
                    set end of eventReferences to targetEvent
                end repeat
            end timeout
        end tell
        my writeLine(outputHandle, "READY")
    on error errorMessage number errorNumber
        my writeError(outputHandle, "startup", errorNumber, errorMessage)
        return
    end try

    repeat
        set inputData to inputHandle's availableData()
        if (inputData's |length|() as integer) is 0 then exit repeat
        set inputString to current application's NSString's alloc()'s initWithData:inputData encoding:(current application's NSUTF8StringEncoding)
        set commandText to inputString as text
        if commandText ends with linefeed then set commandText to text 1 thru -2 of commandText

        if commandText is "STOP" then
            my writeLine(outputHandle, "STOPPED")
            exit repeat
        end if

        try
            set commandParts to my splitText(commandText, "|")
            if item 1 of commandParts is not "FRAME" then error "Unknown worker command"
            set updateCount to (count of commandParts) - 1
            set hasMutation to false

            tell application "Calendar"
                with timeout of 3600 seconds
                    ignoring application responses
                        -- Every complete replacement is created before any old
                        -- geometry is retired. Calendar never observes a partial
                        -- start/end translation for an individual event.
                        repeat with updateIndex from 1 to updateCount
                            set fields to my splitText(item (updateIndex + 1) of commandParts, ",")
                            set operation to item 1 of fields
                            if operation is "C" or operation is "R" then
                                set calendarName to item 3 of fields
                                set eventURL to item 4 of fields
                                set targetStart to weekStart + ((item 5 of fields) as integer)
                                set targetEnd to weekStart + ((item 6 of fields) as integer)
                                set eventSummary to my decodeField(item 7 of fields)
                                set isAllDay to (item 8 of fields) as integer
                                tell calendar calendarName
                                    if isAllDay is 1 then
                                        make new event at end of events with properties {summary:eventSummary, start date:targetStart, end date:targetEnd, allday event:true, url:eventURL, description:ownerMarker}
                                    else
                                        make new event at end of events with properties {summary:eventSummary, start date:targetStart, end date:targetEnd, url:eventURL, description:ownerMarker}
                                    end if
                                end tell
                            end if
                        end repeat

                        repeat with updateIndex from 1 to updateCount
                            set fields to my splitText(item (updateIndex + 1) of commandParts, ",")
                            if item 1 of fields is "R" then
                                set eventIndex to my indexOfKey(eventKeys, item 2 of fields)
                                set targetEvent to item eventIndex of eventReferences
                                delete targetEvent
                            end if
                        end repeat

                        repeat with updateIndex from 1 to updateCount
                            set fields to my splitText(item (updateIndex + 1) of commandParts, ",")
                            if item 1 of fields is "M" then
                                set hasMutation to true
                                set eventIndex to my indexOfKey(eventKeys, item 2 of fields)
                                set targetEvent to item eventIndex of eventReferences
                                set targetStart to weekStart + ((item 3 of fields) as integer)
                                set targetEnd to weekStart + ((item 4 of fields) as integer)
                                set shouldUpdateStart to (item 5 of fields) as integer
                                set shouldUpdateEnd to (item 6 of fields) as integer
                                set shouldUpdateSummary to (item 7 of fields) as integer
                                if shouldUpdateStart is 1 then set start date of targetEvent to targetStart
                                if shouldUpdateEnd is 1 then set end date of targetEvent to targetEnd
                                if shouldUpdateSummary is 1 then set summary of targetEvent to my decodeField(item 8 of fields)
                            end if
                        end repeat
                    end ignoring

                    if hasMutation then
                        get uid of targetEvent
                    else
                        get count of calendars
                    end if

                    -- Reference lookups are deliberately after the visual
                    -- completion barrier. ACK lets Node accept the next key
                    -- while these nonvisual lookups finish in the worker.
                    my writeLine(outputHandle, "ACK|" & updateCount)

                    repeat with updateIndex from 1 to updateCount
                        set fields to my splitText(item (updateIndex + 1) of commandParts, ",")
                        set operation to item 1 of fields
                        if operation is "C" or operation is "R" then
                            set eventKey to item 2 of fields
                            set calendarName to item 3 of fields
                            set eventURL to item 4 of fields
                            tell calendar calendarName to set targetEvent to first event whose url is eventURL
                            if operation is "C" then
                                set end of eventKeys to eventKey
                                set end of eventReferences to targetEvent
                            else
                                set eventIndex to my indexOfKey(eventKeys, eventKey)
                                set item eventIndex of eventReferences to targetEvent
                            end if
                        end if
                    end repeat
                end timeout
            end tell
        on error errorMessage number errorNumber
            my writeError(outputHandle, "frame", errorNumber, errorMessage)
            return
        end try
    end repeat
end run

on splitText(inputText, delimiterText)
    set previousDelimiters to AppleScript's text item delimiters
    set AppleScript's text item delimiters to delimiterText
    set outputItems to every text item of inputText
    set AppleScript's text item delimiters to previousDelimiters
    return outputItems
end splitText

on indexOfKey(eventKeys, targetKey)
    repeat with keyIndex from 1 to count of eventKeys
        if (item keyIndex of eventKeys as text) is targetKey then return keyIndex
    end repeat
    error "Worker does not know event " & targetKey
end indexOfKey

on decodeField(encodedText)
    set encodedString to current application's NSString's stringWithString:encodedText
    return encodedString's stringByRemovingPercentEncoding() as text
end decodeField

on writeLine(outputHandle, lineText)
    set outputString to current application's NSString's stringWithString:(lineText & linefeed)
    outputHandle's writeData:(outputString's dataUsingEncoding:(current application's NSUTF8StringEncoding))
end writeLine

on writeError(outputHandle, phaseName, errorNumber, errorMessage)
    set encodedMessage to current application's NSString's stringWithString:errorMessage
    set allowedCharacters to current application's NSCharacterSet's alphanumericCharacterSet()
    set encodedMessage to encodedMessage's stringByAddingPercentEncodingWithAllowedCharacters:allowedCharacters
    my writeLine(outputHandle, "ERROR|" & phaseName & "|" & errorNumber & "|" & encodedMessage)
end writeError
`;

export const calendarWorkerAppleScript = residentWorkerScript;
