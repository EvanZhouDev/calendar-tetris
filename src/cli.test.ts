import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const cli = new URL("./cli.js", import.meta.url);

test("help describes only the shipping Tetris commands", () => {
  const result = spawnSync(process.execPath, [cli.pathname, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /calendar-tetris \[--5-col\] \[--no-hud\]/u);
  assert.match(result.stdout, /calendar-tetris cleanup/u);
  assert.doesNotMatch(result.stdout, /prototype|game engine/iu);
});

test("version does not contact Calendar", () => {
  const result = spawnSync(process.execPath, [cli.pathname, "--version"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "0.1.0");
});

test("unknown options fail before contacting Calendar", () => {
  const result = spawnSync(process.execPath, [cli.pathname, "--wat"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown option: --wat/u);
});

test("startup draws the HUD but leaves the board empty until Enter", () => {
  const source = readFileSync(cli, "utf8");
  const prompt = source.indexOf("Focus this terminal and press");
  const hudRender = source.indexOf("renderer.renderHUD");
  const firstRender = source.indexOf("const firstRender = renderer.render");
  assert.ok(prompt >= 0);
  assert.ok(hudRender >= 0);
  assert.ok(hudRender < prompt);
  assert.ok(firstRender > prompt);
  assert.match(source, /callToAction\("Enter"\)/u);
  assert.match(source, /Game started\./u);
  assert.doesNotMatch(source, /Drawing first piece/u);
  assert.match(source, /\[1\/2\]/u);
  assert.match(source, /\[2\/2\]/u);
});

test("startup output emphasizes status and keys without coloring descriptions", () => {
  const source = readFileSync(cli, "utf8");
  assert.match(source, /gameTitleFor\(optionsValue\).*is starting\./u);
  assert.match(source, /style\.dim\("1\."\)/u);
  assert.match(source, /style\.key\("← →"\).*style\.dim\("Move"\)/u);
  assert.match(source, /style\.callToAction\("Enter"\)/u);
  assert.match(source, /style\.key\("\^C"\)/u);
});

test("startup title shows only the compact mode suffix", () => {
  const source = readFileSync(cli, "utf8");
  assert.match(source, /style\.dim\(" \(5-Column\)"\)/u);
  assert.doesNotMatch(source, /HUD Off/u);
  assert.doesNotMatch(source, / · 5-Column/u);
});

test("first-run permission copy precedes setup instructions", () => {
  const source = readFileSync(cli, "utf8");
  const permissionCopy = source.indexOf("Calendar permissions required");
  const accessRequest = source.indexOf("await requestCalendarPermissions()");
  assert.ok(permissionCopy >= 0);
  assert.ok(accessRequest > permissionCopy);
  assert.match(source, /await requestCalendarAccess\(\);\s+showInstructions\(\);/u);
  assert.match(source, /Calendar Tetris manages its own game calendars and does not affect your calendars\./u);
  assert.match(source, /Two permission prompts will appear\./u);
  assert.match(source, /Choose Allow both times\./u);
});

test("busy rendering combines queued terminal actions into the next frame", () => {
  const source = readFileSync(cli, "utf8");
  assert.match(source, /pendingInputs\.push\(input\)/u);
  assert.match(source, /pendingInputs\.splice\(0\)/u);
  assert.match(source, /for \(const input of queued\)/u);
  assert.doesNotMatch(source, /pendingInputs\.shift\(\)/u);
  assert.doesNotMatch(source, /pendingInput = input/u);
});
