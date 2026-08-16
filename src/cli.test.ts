import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
