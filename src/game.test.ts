import assert from "node:assert/strict";
import test from "node:test";
import { compactRules, standardRules, TetrisGame } from "./game.js";

test("standard mode is a conventional 20 by 10 seven-piece game", () => {
  assert.equal(standardRules.width, 10);
  assert.equal(standardRules.height, 20);
  assert.deepEqual(standardRules.pieces.map((piece) => piece.label), [
    "I", "O", "T", "S", "Z", "J", "L",
  ]);
});

test("compact mode exposes the six requested user-facing names", () => {
  assert.equal(compactRules.width, 5);
  assert.equal(compactRules.height, 10);
  assert.deepEqual(compactRules.pieces.map((piece) => piece.label), [
    "I", "Domino", "L", "T", "S", "Z",
  ]);
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
