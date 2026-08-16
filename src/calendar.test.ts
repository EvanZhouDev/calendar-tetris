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

test("both boards fill the midnight-to-noon Calendar viewport", () => {
  const cases = [
    { rules: standardRules, compact: false, column: 0 },
    { rules: compactRules, compact: true, column: 0 },
  ] as const;
  for (const { rules, compact, column } of cases) {
    const game = new TetrisGame(rules, () => 0);
    const snapshot = game.snapshot;
    const settled = snapshot.settled.map((row) => [...row]);
    settled[settled.length - 1]![column] = snapshot.active.id;
    const runs = runsForSnapshot(
      { ...snapshot, settled, activeCells: [], gameOver: true },
      { compact, hud: false },
      0,
    );
    const boardRuns = runs.filter((run) => run.key.startsWith("board/"));
    assert.ok(boardRuns.length > 0);
    assert.ok(boardRuns.every((run) => run.start % 86_400 >= 0));
    assert.ok(boardRuns.every((run) => run.end % 86_400 <= 12 * 60 * 60));
    assert.ok(boardRuns.some((run) => run.end % 86_400 === 12 * 60 * 60));
  }
});

test("pool planning preserves unchanged event slots", () => {
  const game = new TetrisGame(compactRules, () => 0);
  const targets = runsForSnapshot(game.snapshot, { compact: true, hud: false }, 0);
  const slots: EventSlot[] = targets.map((run, id) => ({
    id,
    palette: `${run.allDay ? "allDay" : "timed"}:${run.color}`,
    run,
    replacement: 0,
  }));
  const plan = planPool(slots, targets);
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.unchanged, targets.length);
});

test("standard events are reused when overlap changes their visual lane", () => {
  const full = {
    key: "full",
    color: "T",
    lane: "full" as const,
    start: 86_400,
    end: 88_200,
    summary: "\u200B",
    allDay: false,
  };
  const slot: EventSlot = {
    id: 0,
    palette: "timed:T",
    run: full,
    replacement: 0,
  };
  const left = { ...full, key: "left", lane: "left" as const };
  const plan = planPool([slot], [left]);
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.unchanged, 1);
});

test("pool planning maximizes single-bound mutations before replacements", () => {
  const run = (key: string, start: number, end: number) => ({
    key,
    color: "T",
    lane: "full" as const,
    start,
    end,
    summary: "\u200B",
    allDay: false,
  });
  const slots: EventSlot[] = [run("old-a", 0, 10), run("old-b", 20, 30)].map(
    (previous, id) => ({ id, palette: "timed:T", run: previous, replacement: 0 }),
  );
  const plan = planPool(slots, [run("new-flexible", 0, 30), run("new-constrained", 0, 40)]);
  assert.equal(plan.updates.length, 2);
  assert.ok(plan.updates.every(({ slot, target }) => (
    target !== null && (slot.run?.start === target.start || slot.run?.end === target.end)
  )));
});

test("pool planning does not revive a parked slot while a visible slot can move", () => {
  const visible = {
    key: "visible",
    color: "O",
    lane: "full" as const,
    start: 0,
    end: 1_800,
    summary: "\u200B",
    allDay: false,
  };
  const visibleSlot: EventSlot = {
    id: 0,
    palette: "timed:O",
    run: visible,
    replacement: 0,
  };
  const parkedSlot: EventSlot = {
    id: 1,
    palette: "timed:O",
    run: null,
    replacement: 0,
  };
  const target = { ...visible, key: "moved", start: 1_800, end: 3_600 };
  const plan = planPool([visibleSlot, parkedSlot], [target]);
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0]?.slot, visibleSlot);
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
  const deletion = calendarWorkerAppleScript.indexOf("delete (first event whose url is oldEventURL)");
  assert.ok(creation >= 0);
  assert.ok(deletion > creation);
});

test("resident frames perform no synchronous per-event URL lookups", () => {
  assert.doesNotMatch(calendarWorkerAppleScript, /set end of eventReferences/u);
  assert.doesNotMatch(calendarWorkerAppleScript, /set item eventIndex of eventReferences/u);
  assert.match(calendarWorkerAppleScript, /delete \(first event whose url is oldEventURL\)/u);
  assert.match(calendarWorkerAppleScript, /get count of calendars/u);
});

test("calendar palette setup uses one transaction without identifier reads", () => {
  assert.match(calendarAppleScripts.prepare, /repeat with calendarIndex/u);
  assert.match(calendarAppleScripts.prepare, /make new calendar/u);
  assert.doesNotMatch(calendarAppleScripts.prepare, /calendarIdentifier/u);
});

test("board reset prewarms the resident worker without drawing a frame", () => {
  const source = CalendarRenderer.prototype.resetBoard.toString();
  assert.match(source, /CalendarWorker\.start/u);
  assert.doesNotMatch(source, /this\.render/u);
});

test("setup HUD rendering does not include board runs", () => {
  const source = CalendarRenderer.prototype.renderHUD.toString();
  assert.match(source, /hudRuns/u);
  assert.doesNotMatch(source, /runsForSnapshot/u);
});
