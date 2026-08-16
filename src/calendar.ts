import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  CalendarWorker,
  type CalendarUpdate,
  runAppleScript,
} from "./applescript.js";
import {
  type GameSnapshot,
  type PieceID,
  type Rules,
  compactRules,
  standardRules,
} from "./game.js";

const execFileAsync = promisify(execFile);

export const ownerMarker = "Owned by Calendar Tetris v1";
export const calendarPrefix = "__CALENDAR_TETRIS__";
const boardStartSeconds = 60 * 60;
const daySeconds = 24 * 60 * 60;
const sessionID = randomUUID();

export interface CalendarOptions {
  compact: boolean;
  hud: boolean;
}

export interface ManagedCalendar {
  key: string;
  name: string;
  identifier: string;
  color: string;
}

export type RenderLane = "left" | "right" | "full" | "allDay";

export interface CalendarRun {
  key: string;
  color: string;
  lane: RenderLane;
  start: number;
  end: number;
  summary: string;
  allDay: boolean;
}

export interface EventSlot {
  id: number;
  palette: string;
  run: CalendarRun | null;
  replacement: number;
}

export interface PoolUpdate {
  slot: EventSlot;
  target: CalendarRun | null;
  created: boolean;
}

export interface PoolPlan {
  updates: PoolUpdate[];
  unchanged: number;
}

export class CalendarRenderer {
  readonly rules: Rules;
  readonly calendarCount: number;

  private readonly palette: ReadonlyMap<string, PaletteEntry>;
  private slots: EventSlot[] = [];
  private worker: CalendarWorker | undefined;

  constructor(readonly options: CalendarOptions) {
    this.rules = options.compact ? compactRules : standardRules;
    this.palette = new Map(paletteFor(this.rules, options.hud).map((entry) => [entry.key, entry]));
    this.calendarCount = this.palette.size;
  }

  async requestAccess(): Promise<void> {
    await runAppleScript(calendarAccessScript);
  }

  async prepareCalendars(): Promise<ManagedCalendar[]> {
    const darkMode = await isDarkMode();
    const arguments_ = [
      ownerMarker,
      String(this.palette.size),
      ...[...this.palette.values()].flatMap((entry) => {
        const [red, green, blue] = rgb16(actualColor(entry, darkMode));
        return [entry.key, entry.name, String(red), String(green), String(blue)];
      }),
    ];
    const output = await runAppleScript(prepareCalendarsScript, arguments_);
    return output
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => {
        const [key, name, identifier] = line.split("\t");
        const entry = key ? this.palette.get(key) : undefined;
        if (!key || !name || !identifier || !entry) {
          throw new Error(`Calendar returned an invalid managed-calendar record: ${line}`);
        }
        return { key, name, identifier, color: entry.color };
      });
  }

  async resetBoard(): Promise<void> {
    await this.close();
    await runAppleScript(resetCalendarsScript, [
      ownerMarker,
      String(this.palette.size),
      ...[...this.palette.values()].map((entry) => entry.name),
    ]);
    this.slots = [];
  }

  async render(snapshot: GameSnapshot, elapsedSeconds: number): Promise<void> {
    if (!this.worker) this.worker = await CalendarWorker.start(ownerMarker);
    const targets = runsForSnapshot(snapshot, this.options, elapsedSeconds);
    const plan = planPool(this.slots, targets);
    if (plan.updates.length === 0) return;

    const ordered = [...plan.updates].sort(compareUpdates);
    const updates = ordered.map((update) => this.workerUpdate(update));
    await this.worker.update(updates);
    applyPlan(this.slots, plan);
  }

  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    if (worker) await worker.close();
  }

  calendarName(color: string): string {
    const entry = this.palette.get(color);
    if (!entry) throw new TypeError(`The ${color} palette is not enabled.`);
    return entry.name;
  }

  private workerUpdate(update: PoolUpdate): CalendarUpdate {
    const current = offsets(update.slot.run, update.slot);
    const next = offsets(update.target, update.slot);
    const key = slotKey(update.slot);
    const summary = update.target?.summary ?? "\u200B";
    const allDay = update.target?.allDay ?? update.slot.run?.allDay ?? false;

    if (update.created) {
      if (!update.target) throw new TypeError("A new slot requires a render target.");
      return {
        type: "create",
        key,
        calendarName: this.calendarName(update.target.color),
        eventURL: baseEventURL(update.slot),
        start: next.start,
        end: next.end,
        summary,
        allDay,
      };
    }

    const updateStart = current.start !== next.start;
    const updateEnd = current.end !== next.end;
    if (updateStart && updateEnd) {
      update.slot.replacement += 1;
      return {
        type: "replace",
        key,
        calendarName: this.calendarName((update.target ?? update.slot.run)?.color ?? "title"),
        eventURL: `${baseEventURL(update.slot)}/replacement/${update.slot.replacement}`,
        start: next.start,
        end: next.end,
        summary,
        allDay,
      };
    }

    return {
      type: "mutate",
      key,
      start: next.start,
      end: next.end,
      updateStart,
      updateEnd,
      updateSummary: summary !== (update.slot.run?.summary ?? "\u200B"),
      summary,
    };
  }
}

interface PaletteEntry {
  key: string;
  name: string;
  color: string;
  appearanceColor?: "placeholder" | "title";
}

function paletteFor(rules: Rules, hud: boolean): PaletteEntry[] {
  const entries: PaletteEntry[] = rules.pieces.map((definition) => ({
    key: definition.id,
    name: `${calendarPrefix}${definition.id}`,
    color: definition.color,
  }));
  if (rules.mode === "standard") {
    entries.push({
      key: "empty",
      name: `${calendarPrefix}PLACEHOLDER`,
      color: "#ECECEC",
      appearanceColor: "placeholder",
    });
  }
  if (hud) {
    entries.push({
      key: "title",
      name: `${calendarPrefix}TITLE`,
      color: "#FFFFFF",
      appearanceColor: "title",
    });
  }
  return entries;
}

function actualColor(entry: PaletteEntry, darkMode: boolean): string {
  if (entry.appearanceColor === "placeholder") return darkMode ? "#0E0E0E" : "#ECECEC";
  if (entry.appearanceColor === "title") return darkMode ? "#000000" : "#FFFFFF";
  return entry.color;
}

export function runsForSnapshot(
  snapshot: GameSnapshot,
  options: CalendarOptions,
  elapsedSeconds: number,
): CalendarRun[] {
  const frame = snapshot.settled.map((row) => [...row]);
  if (!snapshot.gameOver) {
    for (const cell of snapshot.activeCells) {
      if (cell.y >= 0) {
        const row = frame[cell.y];
        if (row) row[cell.x] = snapshot.active.id;
      }
    }
  }

  const boardRuns = options.compact
    ? compactBoardRuns(frame)
    : standardBoardRuns(frame);
  if (!options.hud) return boardRuns;
  return [...boardRuns, ...hudRuns(snapshot, elapsedSeconds)];
}

function compactBoardRuns(frame: Array<Array<PieceID | null>>): CalendarRun[] {
  const output: CalendarRun[] = [];
  const rowSeconds = 60 * 60;
  for (let column = 0; column < 5; column += 1) {
    let start = 0;
    while (start < 10) {
      const color = frame[start]?.[column] ?? null;
      let end = start + 1;
      while (end < 10 && (frame[end]?.[column] ?? null) === color) end += 1;
      if (color) output.push(boardRun(column + 1, start, end, "full", color, rowSeconds));
      start = end;
    }
  }
  return output;
}

function standardBoardRuns(frame: Array<Array<PieceID | null>>): CalendarRun[] {
  const output: CalendarRun[] = [];
  const rowSeconds = 30 * 60;
  for (let day = 0; day < 5; day += 1) {
    let start = 0;
    while (start < 20) {
      const pair = [frame[start]?.[day * 2] ?? null, frame[start]?.[day * 2 + 1] ?? null] as const;
      let end = start + 1;
      while (end < 20) {
        const next = [frame[end]?.[day * 2] ?? null, frame[end]?.[day * 2 + 1] ?? null] as const;
        if (next[0] !== pair[0] || next[1] !== pair[1]) break;
        end += 1;
      }
      appendPair(output, day + 1, start, end, pair[0], pair[1], rowSeconds);
      start = end;
    }
  }
  return output;
}

function appendPair(
  output: CalendarRun[],
  day: number,
  startRow: number,
  endRow: number,
  left: PieceID | null,
  right: PieceID | null,
  rowSeconds: number,
): void {
  if (!left && !right) return;
  if (left && left === right) {
    output.push(boardRun(day, startRow, endRow, "full", left, rowSeconds));
    return;
  }
  output.push(boardRun(day, startRow, endRow, "left", left ?? "empty", rowSeconds));
  output.push(boardRun(day, startRow, endRow, "right", right ?? "empty", rowSeconds));
}

function boardRun(
  day: number,
  startRow: number,
  endRow: number,
  lane: RenderLane,
  color: string,
  rowSeconds: number,
): CalendarRun {
  const start = day * daySeconds + boardStartSeconds + startRow * rowSeconds + (lane === "right" ? 1 : 0);
  const end = day * daySeconds + boardStartSeconds + endRow * rowSeconds;
  return {
    key: `board/${day}/${startRow}/${endRow}/${lane}/${color}`,
    color,
    lane,
    start,
    end,
    summary: "\u200B",
    allDay: false,
  };
}

function hudRuns(snapshot: GameSnapshot, elapsedSeconds: number): CalendarRun[] {
  const output: CalendarRun[] = [
    allDayRun("score", 1, 3, `Score: ${snapshot.score}`),
    allDayRun("title", 3, 4, "TETRIS"),
    allDayRun("time", 5, 6, formatTime(elapsedSeconds)),
    timedHudRun("hold-title", 0, 0, "title", "Hold"),
    timedHudRun("next-title", 6, 0, "title", "Up Next"),
  ];

  if (snapshot.held) {
    output.push(timedHudRun("held", 0, 2, snapshot.held, pieceLabel(snapshot, snapshot.held)));
  }
  snapshot.next.slice(0, 3).forEach((id, index) => {
    output.push(timedHudRun(`next-${index}`, 6, 2 + index * 2, id, pieceLabel(snapshot, id)));
  });
  return output;
}

function allDayRun(key: string, startDay: number, endDay: number, summary: string): CalendarRun {
  return {
    key: `hud/${key}`,
    color: "title",
    lane: "allDay",
    start: startDay * daySeconds,
    end: endDay * daySeconds,
    summary,
    allDay: true,
  };
}

function timedHudRun(
  key: string,
  day: number,
  tenMinuteRow: number,
  color: string,
  summary: string,
): CalendarRun {
  const start = day * daySeconds + boardStartSeconds + tenMinuteRow * 10 * 60;
  return {
    key: `hud/${key}`,
    color,
    lane: "full",
    start,
    end: start + 10 * 60,
    summary,
    allDay: false,
  };
}

function pieceLabel(snapshot: GameSnapshot, id: PieceID): string {
  const rules = snapshot.width === 5 ? compactRules : standardRules;
  return rules.pieces.find((piece) => piece.id === id)?.label ?? id;
}

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function planPool(slots: readonly EventSlot[], targets: readonly CalendarRun[]): PoolPlan {
  const updates: PoolUpdate[] = [];
  let unchanged = 0;
  const palettes = new Set([...slots.map((slot) => slot.palette), ...targets.map(paletteForRun)]);

  for (const palette of palettes) {
    const available = slots.filter((slot) => slot.palette === palette);
    const wanted = targets.filter((target) => paletteForRun(target) === palette);
    const usedSlots = new Set<EventSlot>();
    const usedTargets = new Set<CalendarRun>();

    for (const target of wanted) {
      const slot = available.find((candidate) => !usedSlots.has(candidate) && candidate.run?.key === target.key);
      if (!slot) continue;
      usedSlots.add(slot);
      usedTargets.add(target);
      if (runsEqual(slot.run, target)) unchanged += 1;
      else updates.push({ slot, target, created: false });
    }

    for (const target of wanted) {
      if (usedTargets.has(target)) continue;
      const candidates = available.filter((slot) => !usedSlots.has(slot));
      const slot = candidates.sort((left, right) => assignmentCost(left.run, target) - assignmentCost(right.run, target))[0];
      if (slot) {
        usedSlots.add(slot);
        updates.push({ slot, target, created: false });
      } else {
        const created: EventSlot = {
          id: nextSlotID(slots, updates),
          palette,
          run: null,
          replacement: 0,
        };
        usedSlots.add(created);
        updates.push({ slot: created, target, created: true });
      }
    }

    for (const slot of available) {
      if (!usedSlots.has(slot) && slot.run) updates.push({ slot, target: null, created: false });
    }
  }
  return { updates, unchanged };
}

function applyPlan(slots: EventSlot[], plan: PoolPlan): void {
  for (const update of plan.updates) {
    if (update.created) slots.push(update.slot);
    update.slot.run = update.target;
  }
}

function runsEqual(left: CalendarRun | null, right: CalendarRun): boolean {
  return Boolean(
    left &&
      left.key === right.key &&
      left.start === right.start &&
      left.end === right.end &&
      left.summary === right.summary &&
      left.allDay === right.allDay,
  );
}

function assignmentCost(previous: CalendarRun | null, target: CalendarRun): number {
  if (!previous) return 1_000_000;
  return Math.abs(previous.start - target.start) + Math.abs(previous.end - target.end) / 2;
}

function compareUpdates(left: PoolUpdate, right: PoolUpdate): number {
  if (!left.target) return right.target ? 1 : 0;
  if (!right.target) return -1;
  // For a split pair, submit the nearly invisible placeholder before the
  // colored half. If Calendar paints between AppleEvents, the visible half is
  // the final operation rather than the first half of a torn piece.
  return (
    Number(right.target.color === "empty") - Number(left.target.color === "empty") ||
    left.target.start - right.target.start ||
    laneOrder(left.target.lane) - laneOrder(right.target.lane)
  );
}

function laneOrder(lane: RenderLane): number {
  if (lane === "left") return 0;
  if (lane === "right") return 1;
  return 0;
}

function paletteForRun(run: CalendarRun): string {
  return `${run.lane}:${run.color}`;
}

function nextSlotID(slots: readonly EventSlot[], updates: readonly PoolUpdate[]): number {
  return Math.max(-1, ...slots.map((slot) => slot.id), ...updates.map((update) => update.slot.id)) + 1;
}

function offsets(run: CalendarRun | null, slot: EventSlot): { start: number; end: number } {
  if (run) return { start: run.start, end: run.end };
  const allDay = slot.palette.startsWith("allDay:");
  const start = (3650 + slot.id * 2) * daySeconds;
  return { start, end: start + (allDay ? daySeconds : 60) };
}

function slotKey(slot: EventSlot): string {
  return `slot-${slot.id}`;
}

function baseEventURL(slot: EventSlot): string {
  return `calendar-tetris://session/${sessionID}/slot/${slot.id}`;
}

function rgb16(color: string): [number, number, number] {
  return [1, 3, 5].map((index) => Number.parseInt(color.slice(index, index + 2), 16) * 257) as [number, number, number];
}

async function isDarkMode(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("/usr/bin/defaults", ["read", "-g", "AppleInterfaceStyle"]);
    return stdout.trim().toLowerCase() === "dark";
  } catch {
    return false;
  }
}

const prepareCalendarsScript = String.raw`
on run argv
    set ownerMarker to item 1 of argv
    set calendarCount to (item 2 of argv) as integer
    set outputLines to {}
    tell application "Calendar"
        with timeout of 3600 seconds
            repeat with calendarIndex from 0 to calendarCount - 1
                set argumentOffset to 3 + calendarIndex * 5
                set colorKey to item argumentOffset of argv
                set calendarName to item (argumentOffset + 1) of argv
                set redValue to (item (argumentOffset + 2) of argv) as integer
                set greenValue to (item (argumentOffset + 3) of argv) as integer
                set blueValue to (item (argumentOffset + 4) of argv) as integer
                if exists calendar calendarName then
                    set targetCalendar to calendar calendarName
                    if description of targetCalendar is not ownerMarker then error "Refusing to use unowned calendar " & calendarName
                else
                    set targetCalendar to make new calendar with properties {name:calendarName, description:ownerMarker}
                end if
                set targetColor to {redValue, greenValue, blueValue}
                if color of targetCalendar is not targetColor then set color of targetCalendar to targetColor
                set end of outputLines to colorKey & tab & calendarName & tab & (calendarIdentifier of targetCalendar)
            end repeat
            save
        end timeout
    end tell
    set AppleScript's text item delimiters to linefeed
    return outputLines as text
end run
`;

const calendarAccessScript = String.raw`
tell application "Calendar" to get count of calendars
`;

const resetCalendarsScript = String.raw`
on run argv
    set ownerMarker to item 1 of argv
    set calendarCount to (item 2 of argv) as integer
    set ownedCalendars to {}
    tell application "Calendar"
        with timeout of 3600 seconds
            repeat with calendarIndex from 1 to calendarCount
                set calendarName to item (calendarIndex + 2) of argv
                if not (exists calendar calendarName) then error "Missing game calendar " & calendarName
                set targetCalendar to calendar calendarName
                if description of targetCalendar is not ownerMarker then error "Refusing to reset unowned calendar " & calendarName
                tell targetCalendar to set eventDescriptions to description of every event
                repeat with eventDescription in eventDescriptions
                    if contents of eventDescription is not ownerMarker then error "Game calendar contains an unowned event: " & calendarName
                end repeat
                set end of ownedCalendars to targetCalendar
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

export const calendarAppleScripts = {
  access: calendarAccessScript,
  prepare: prepareCalendarsScript,
  reset: resetCalendarsScript,
} as const;
