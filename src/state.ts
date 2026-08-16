import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ManagedCalendar } from "./calendar.js";

interface CalendarRecord {
  identifier: string;
  name: string;
}

export interface CalendarTetrisState {
  version: 1;
  calendars: CalendarRecord[];
}

const statePath = join(
  homedir(),
  "Library",
  "Application Support",
  "calendar-tetris",
  "state.json",
);

const emptyState: CalendarTetrisState = {
  version: 1,
  calendars: [],
};

export async function loadState(): Promise<CalendarTetrisState> {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as Partial<CalendarTetrisState>;
    if (
      parsed.version !== 1 ||
      !Array.isArray(parsed.calendars)
    ) {
      return structuredClone(emptyState);
    }
    const calendars = parsed.calendars.filter(
      (calendar): calendar is CalendarRecord =>
        typeof calendar === "object" &&
        calendar !== null &&
        typeof calendar.identifier === "string" &&
        typeof calendar.name === "string",
    );
    return { version: 1, calendars };
  } catch {
    return structuredClone(emptyState);
  }
}

export async function recordCalendars(calendars: readonly ManagedCalendar[]): Promise<void> {
  const state = await loadState();
  await saveState({
    version: 1,
    calendars: calendars.map(({ identifier, name }) => ({ identifier, name })),
  });
}

export async function clearRecordedCalendars(): Promise<void> {
  const state = await loadState();
  await saveState({ ...state, calendars: [] });
}

async function saveState(state: CalendarTetrisState): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporaryPath, statePath);
}
