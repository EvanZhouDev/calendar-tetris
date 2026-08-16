import assert from "node:assert/strict";
import test from "node:test";
import { compactRules, isLockOut, standardRules, TetrisGame } from "./game.js";

test("standard mode has a 20-row matrix beneath a four-row buffer", () => {
  assert.equal(standardRules.width, 10);
  assert.equal(standardRules.matrixHeight, 20);
  assert.equal(standardRules.bufferRows, 4);
  assert.equal(standardRules.height, 24);
  assert.deepEqual(standardRules.pieces.map((piece) => piece.label), [
    "I", "O", "T", "S", "Z", "J", "L",
  ]);
});

test("compact mode exposes the six requested user-facing names", () => {
  assert.equal(compactRules.width, 5);
  assert.equal(compactRules.matrixHeight, 10);
  assert.equal(compactRules.bufferRows, 2);
  assert.equal(compactRules.height, 12);
  assert.deepEqual(compactRules.pieces.map((piece) => piece.label), [
    "I", "Domino", "L", "T", "S", "Z",
  ]);
  assert.deepEqual(compactRules.pieces.map((piece) => piece.cells.length), [3, 2, 3, 4, 4, 4]);
});

test("pieces spawn at the bottom of each buffer", () => {
  const standard = new TetrisGame(standardRules, () => 0).snapshot;
  const compact = new TetrisGame(compactRules, () => 0).snapshot;
  assert.ok(standard.activeCells.every((cell) => cell.y < standard.bufferRows));
  assert.ok(Math.max(...standard.activeCells.map((cell) => cell.y)) === standard.bufferRows - 1);
  assert.ok(compact.activeCells.every((cell) => cell.y < compact.bufferRows));
  assert.ok(Math.max(...compact.activeCells.map((cell) => cell.y)) === compact.bufferRows - 1);
});

test("locking entirely in the buffer is a lock out but partial entry survives", () => {
  assert.equal(isLockOut([{ x: 4, y: 2 }, { x: 5, y: 3 }], 4), true);
  assert.equal(isLockOut([{ x: 4, y: 3 }, { x: 5, y: 4 }], 4), false);
});

test("a piece cannot move beyond either wall", () => {
  const game = new TetrisGame(standardRules, () => 0);
  while (game.moveLeft()) {}
  assert.equal(game.moveLeft(), false);
  while (game.moveRight()) {}
  assert.equal(game.moveRight(), false);
});

test("hard drop exposes its landing before lock and spawn", () => {
  const game = new TetrisGame(standardRules, () => 0);
  const before = game.snapshot.active.id;
  assert.equal(game.dropToBottom(), true);
  assert.equal(game.snapshot.active.id, before);
  assert.equal(game.lockGroundedPiece(), true);
  assert.ok(game.snapshot.settled.flat().some((cell) => cell === before));
});

test("hold is available once per falling piece", () => {
  const game = new TetrisGame(compactRules, () => 0);
  const first = game.snapshot.active.id;
  assert.equal(game.hold(), true);
  assert.equal(game.snapshot.held, first);
  assert.equal(game.hold(), false);
  game.dropToBottom();
  game.lockGroundedPiece();
  assert.equal(game.hold(), true);
});

test("compact pieces rotate without leaving the five-column board", () => {
  const game = new TetrisGame(compactRules, () => 0);
  assert.equal(game.rotateClockwise(), true);
  assert.ok(game.snapshot.activeCells.every((cell) => cell.x >= 0 && cell.x < 5));
});
