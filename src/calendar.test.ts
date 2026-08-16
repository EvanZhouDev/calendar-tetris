import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { calendarWorkerAppleScript } from "./applescript.js";
import {
  CalendarRenderer,
  calendarAppleScripts,
  planPool,
  runsForSnapshot,
  type EventSlot,
} from "./calendar.js";
import { compactRules, standardRules, TetrisGame } from "./game.js";

test("each mode creates only the calendars it needs", () => {
  assert.equal(new CalendarRenderer({ compact: false, hud: true }).calendarCount, 9);
  assert.equal(new CalendarRenderer({ compact: false, hud: false }).calendarCount, 8);
  assert.equal(new CalendarRenderer({ compact: true, hud: true }).calendarCount, 7);
  assert.equal(new CalendarRenderer({ compact: true, hud: false }).calendarCount, 6);
});

test("empty compact columns need no board events", () => {
  const game = new TetrisGame(compactRules, () => 0);
  const snapshot = game.snapshot;
  const empty = {
    ...snapshot,
    activeCells: [],
    gameOver: true,
  };
  assert.deepEqual(runsForSnapshot(empty, { compact: true, hud: false }, 0), []);
});

test("compact vertical cells are compressed into one full-width event", () => {
  const game = new TetrisGame(compactRules, () => 0);
  const runs = runsForSnapshot(game.snapshot, { compact: true, hud: false }, 0);
  assert.ok(runs.length > 0);
  assert.ok(runs.every((run) => run.lane === "full"));
});

test("a lone standard half-cell is paired with a placeholder", () => {
  const game = new TetrisGame(standardRules, () => 0);
  const snapshot = game.snapshot;
  const settled = snapshot.settled.map((row) => [...row]);
  settled[10]![0] = "T";
  const runs = runsForSnapshot(
    { ...snapshot, settled, activeCells: [], gameOver: true },
    { compact: false, hud: false },
    0,
  );
  const placeholder = runs.find((run) => run.color === "empty");
  assert.ok(placeholder);
  assert.ok(placeholder.lane === "left" || placeholder.lane === "right");
  const colored = runs.find((run) => run.color === "T");
  assert.ok(colored);
  const left = colored.lane === "left" ? colored : placeholder;
  const right = colored.lane === "right" ? colored : placeholder;
  assert.equal(right.start - left.start, 1);
  assert.equal(right.end, left.end);
});

test("matching standard halves become one full-width event", () => {
  const game = new TetrisGame(standardRules, () => 0);
  const snapshot = game.snapshot;
  const settled = snapshot.settled.map((row) => [...row]);
  settled[10]![0] = "T";
  settled[10]![1] = "T";
  const runs = runsForSnapshot(
    { ...snapshot, settled, activeCells: [], gameOver: true },
    { compact: false, hud: false },
    0,
  );
  assert.ok(runs.some((run) => run.color === "T" && run.lane === "full"));
  assert.equal(runs.some((run) => run.color === "empty"), false);
});

test("compact HUD uses the requested piece labels", () => {
  const game = new TetrisGame(compactRules, () => 0);
  const runs = runsForSnapshot(game.snapshot, { compact: true, hud: true }, 0);
  const visibleLabels = new Set(runs.map((run) => run.summary));
  const valid = new Set(["I", "Domino", "L", "T", "S", "Z"]);
  for (const label of visibleLabels) {
    if (["Hold", "Up Next", "TETRIS", "0:00", "Score: 0", "\u200B"].includes(label)) continue;
    assert.ok(valid.has(label), `Unexpected compact label ${label}`);
  }
});

test("pool planning preserves unchanged event slots", () => {
  const game = new TetrisGame(compactRules, () => 0);
  const targets = runsForSnapshot(game.snapshot, { compact: true, hud: false }, 0);
  const slots: EventSlot[] = targets.map((run, id) => ({
    id,
    palette: `${run.lane}:${run.color}`,
    run,
    replacement: 0,
  }));
  const plan = planPool(slots, targets);
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.unchanged, targets.length);
});

test("all Calendar AppleScripts compile without contacting Calendar", () => {
  const directory = mkdtempSync(join(tmpdir(), "calendar-tetris-scripts-"));
  try {
    const scripts = { ...calendarAppleScripts, worker: calendarWorkerAppleScript };
    for (const [name, script] of Object.entries(scripts)) {
      execFileSync("/usr/bin/osacompile", ["-o", join(directory, `${name}.scpt`), "-e", script]);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("resident translations create complete replacements before deleting old events", () => {
  const creation = calendarWorkerAppleScript.indexOf("url:eventURL");
  const deletion = calendarWorkerAppleScript.indexOf("delete targetEvent");
  assert.ok(creation >= 0);
  assert.ok(deletion > creation);
});

test("calendar palette setup uses one transaction without identifier reads", () => {
  assert.match(calendarAppleScripts.prepare, /repeat with calendarIndex/u);
  assert.match(calendarAppleScripts.prepare, /make new calendar/u);
  assert.doesNotMatch(calendarAppleScripts.prepare, /calendarIdentifier/u);
});
