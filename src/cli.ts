#!/usr/bin/env node

import { CalendarRenderer } from "./calendar.js";
import { cleanupManagedCalendars } from "./cleanup.js";
import { compactRules, standardRules, TetrisGame } from "./game.js";
import { recordCalendars } from "./state.js";

interface Options {
  command: "run" | "cleanup" | "help" | "version";
  compact: boolean;
  hud: boolean;
}

try {
  const options = parseOptions(process.argv.slice(2));
  if (options.command === "help") showHelp();
  else if (options.command === "version") console.log("0.1.0");
  else if (options.command === "cleanup") await runCleanup();
  else await runGame(options);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n${message}`);
  if (message.includes("-1743") || message.toLowerCase().includes("not authorized")) {
    console.error("\nAllow your terminal to control Calendar in:");
    console.error("System Settings → Privacy & Security → Automation");
  }
  process.exitCode = 1;
}

function parseOptions(arguments_: readonly string[]): Options {
  let command: Options["command"] = "run";
  let compact = false;
  let hud = true;

  for (const argument of arguments_) {
    if (argument === "cleanup") command = "cleanup";
    else if (argument === "--5-col") compact = true;
    else if (argument === "--no-hud") hud = false;
    else if (argument === "--help" || argument === "-h") command = "help";
    else if (argument === "--version" || argument === "-v") command = "version";
    else throw new Error(`Unknown option: ${argument}\nRun calendar-tetris --help for usage.`);
  }
  if (command === "cleanup" && (compact || !hud)) {
    throw new Error("The cleanup command does not accept game-mode options.");
  }
  return { command, compact, hud };
}

function showHelp(): void {
  console.log(`Calendar Tetris

Usage:
  calendar-tetris [--5-col] [--no-hud]
  calendar-tetris cleanup

Options:
  --5-col   Play the compact 10 × 5 game
  --no-hud  Hide Score, Hold, Up Next, title, and time
  -h, --help
  -v, --version`);
}

async function runCleanup(): Promise<void> {
  console.log("Calendar Tetris");
  console.log("Cleaning up calendars used for Calendar Tetris.");
  await cleanupManagedCalendars();
  console.log("Cleanup complete.");
}

async function runGame(optionsValue: Options): Promise<void> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("Calendar Tetris requires an interactive terminal.");
  }

  const renderer = new CalendarRenderer({ compact: optionsValue.compact, hud: optionsValue.hud });
  const rules = optionsValue.compact ? compactRules : standardRules;
  const game = new TetrisGame(rules);

  console.log(titleFor(optionsValue));
  console.log();
  let instructionsShown = false;
  const showInstructions = (): void => {
    if (instructionsShown) return;
    instructionsShown = true;
    console.log("Calendar Tetris is starting. While you’re waiting...\n");
    console.log("1. Place both Calendar and this terminal in view.");
    console.log("2. Set Calendar to Week View (⌘2) and Go to Today (⌘T).");
    console.log("3. Scroll up to the top of Calendar.\n");
    console.log("You will control the game with the terminal and see the output in Calendar.\n");
  };
  await requestCalendarAccess(renderer, showInstructions);
  showInstructions();

  let shuttingDown = false;
  let cleanupStarted = false;
  let currentOperation: Promise<unknown> | null = null;
  let activeRender: Promise<void> | null = null;
  let gravityTimer: NodeJS.Timeout | undefined;
  const pendingInputs: string[] = [];
  let resolveStart: (() => void) | undefined;
  let startListener: (() => void) | undefined;
  let inputBuffer = "";
  let gameOverShown = false;
  let gameStartedAt = performance.now();
  let displayedElapsedSeconds = 0;

  const restoreTerminal = (): void => {
    process.stdin.off("data", handleInput);
    if (startListener) process.stdin.off("data", startListener);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  };

  const forceQuit = (): never => {
    restoreTerminal();
    console.error("\nCleanup interrupted. Clean up manually with:");
    console.error("npx calendar-tetris cleanup");
    process.exit(130);
  };

  const shutdown = async (): Promise<void> => {
    if (cleanupStarted) return;
    if (shuttingDown) forceQuit();
    shuttingDown = true;
    cleanupStarted = true;
    if (gravityTimer) clearTimeout(gravityTimer);
    pendingInputs.length = 0;
    resolveStart?.();
    restoreTerminal();
    console.log("\nStopped. Cleaning up calendars used for Calendar Tetris.");
    console.log("Press ^C again to force quit. If you do, clean up manually with:");
    console.log("npx calendar-tetris cleanup\n");

    try {
      await currentOperation?.catch(() => {});
      await activeRender?.catch(() => {});
      await renderer.close().catch(() => {});
      await cleanupManagedCalendars();
      console.log("Cleanup complete.");
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      console.error("Cleanup incomplete. Run: npx calendar-tetris cleanup");
      process.exitCode = 1;
    }
  };

  const handleSignal = (): void => {
    if (shuttingDown) forceQuit();
    void shutdown();
  };
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  const phase = async <T>(label: string, operation: () => Promise<T>): Promise<T> => {
    console.log(label);
    const promise = operation();
    currentOperation = promise;
    try {
      return await promise;
    } finally {
      if (currentOperation === promise) currentOperation = null;
    }
  };

  try {
    const calendars = await phase(
      `[1/2] Preparing ${renderer.calendarCount} Game Calendars`,
      async () => {
        const prepared = await renderer.prepareCalendars();
        await recordCalendars(prepared);
        return prepared;
      },
    );
    if (shuttingDown) return;
    if (calendars.length !== renderer.calendarCount) {
      throw new Error(`Prepared ${calendars.length} calendars; expected ${renderer.calendarCount}.`);
    }

    await phase("[2/2] Resetting the board", () => renderer.resetBoard());
    if (shuttingDown) return;
  } catch (error) {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
    restoreTerminal();
    await renderer.close().catch(() => {});
    throw error;
  }

  console.log("\nSetup complete. Focus this terminal and press Enter.\n");
  console.log("← → Move   ↑ Rotate   ↓ Drop   Space Hard drop");
  console.log("C Hold     R Restart  Q Quit\n");
  process.stdout.write("> ");
  await new Promise<void>((resolve) => {
    resolveStart = resolve;
    startListener = resolve;
    process.stdin.resume();
    process.stdin.once("data", startListener);
  });
  resolveStart = undefined;
  if (startListener) process.stdin.off("data", startListener);
  startListener = undefined;
  if (shuttingDown) return;

  gameStartedAt = performance.now();
  const firstRender = renderer.render(game.snapshot, 0);
  currentOperation = firstRender;
  try {
    await firstRender;
  } catch (error) {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
    restoreTerminal();
    await renderer.close().catch(() => {});
    throw error;
  } finally {
    if (currentOperation === firstRender) currentOperation = null;
  }
  if (shuttingDown) return;

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", handleInput);

  const hudSignature = (): string => {
    const snapshot = game.snapshot;
    return [snapshot.score, snapshot.held ?? "", ...snapshot.next].join(":");
  };

  const showGameOver = (): void => {
    if (game.gameOver && !gameOverShown) {
      gameOverShown = true;
      console.log("\nGAME OVER. Press R to restart.");
    }
  };

  const clearGameOver = (): void => {
    if (!gameOverShown) return;
    gameOverShown = false;
    process.stdout.write("\x1B[1A\x1B[2K");
  };

  const stopAfterRenderError = (error: unknown): void => {
    if (shuttingDown) return;
    console.error(`\nCalendar rendering stopped: ${error instanceof Error ? error.message : String(error)}`);
    void shutdown();
  };

  const renderTransition = (transition: () => boolean): void => {
    if (shuttingDown || activeRender) return;
    if (gravityTimer) clearTimeout(gravityTimer);
    gravityTimer = undefined;

    const previousHUD = hudSignature();
    const changed = transition();
    if (!changed) {
      continueInputQueue();
      return;
    }
    if (hudSignature() !== previousHUD) {
      displayedElapsedSeconds = (performance.now() - gameStartedAt) / 1_000;
    }

    const render = renderer.render(game.snapshot, displayedElapsedSeconds);
    activeRender = render;
    void render
      .then(showGameOver)
      .catch(stopAfterRenderError)
      .finally(() => {
        if (activeRender === render) activeRender = null;
        if (shuttingDown) return;
        continueInputQueue();
      });
  };

  function continueInputQueue(): void {
    const next = pendingInputs.shift();
    if (next) dispatchInput(next);
    else armGravity();
  }

  function armGravity(): void {
    if (gravityTimer) clearTimeout(gravityTimer);
    if (shuttingDown || activeRender || game.gameOver) return;
    gravityTimer = setTimeout(() => {
      gravityTimer = undefined;
      renderTransition(() => game.softDrop());
    }, 800);
  }

  function dispatchInput(input: string): void {
    if (shuttingDown) return;
    if (gravityTimer) clearTimeout(gravityTimer);
    gravityTimer = undefined;
    if (activeRender) {
      pendingInputs.push(input);
      return;
    }
    switch (input) {
      case "\u001B[D":
        renderTransition(() => game.moveLeft());
        break;
      case "\u001B[C":
        renderTransition(() => game.moveRight());
        break;
      case "\u001B[A":
        renderTransition(() => game.rotateClockwise());
        break;
      case "\u001B[B":
        renderTransition(() => game.softDrop());
        break;
      case " ":
        renderTransition(() => game.hardDrop());
        break;
      case "c":
      case "C":
        renderTransition(() => game.hold());
        break;
      case "r":
      case "R":
        clearGameOver();
        renderTransition(() => {
          game.reset();
          gameStartedAt = performance.now();
          displayedElapsedSeconds = 0;
          return true;
        });
        break;
      default:
        continueInputQueue();
    }
  }

  function handleInput(buffer: Buffer): void {
    inputBuffer += buffer.toString("utf8");
    while (inputBuffer.length > 0) {
      let input: string;
      if (inputBuffer.startsWith("\u001B")) {
        if (inputBuffer.length < 3) return;
        const direction = inputBuffer[2];
        if ((inputBuffer[1] === "[" || inputBuffer[1] === "O") && direction && "ABCD".includes(direction)) {
          input = `\u001B[${direction}`;
          inputBuffer = inputBuffer.slice(3);
        } else {
          input = inputBuffer[0] ?? "";
          inputBuffer = inputBuffer.slice(1);
        }
      } else {
        input = inputBuffer[0] ?? "";
        inputBuffer = inputBuffer.slice(1);
      }

      if (input === "\u0003") {
        if (shuttingDown) forceQuit();
        void shutdown();
        return;
      }
      if (input === "q" || input === "Q") {
        void shutdown();
        return;
      }
      dispatchInput(input);
    }
  }

  armGravity();
}

async function requestCalendarAccess(
  renderer: CalendarRenderer,
  whileWaiting: () => void,
): Promise<void> {
  const showPermissionMessage = (): void => {
    console.log("Calendar Tetris needs permissions to control Calendar.");
    console.log("Choose Allow when the permission prompt appears.\n");
  };
  const access = renderer.requestAccess().then(
    () => ({ granted: true as const }),
    (error: unknown) => ({ granted: false as const, error }),
  );
  const firstResult = await Promise.race([
    access,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_500)),
  ]);

  if (firstResult === null) {
    showPermissionMessage();
    whileWaiting();
    const finalResult = await access;
    if (!finalResult.granted) throw finalResult.error;
    return;
  }
  if (!firstResult.granted) {
    showPermissionMessage();
    throw firstResult.error;
  }
}

function titleFor(optionsValue: Options): string {
  const details: string[] = [];
  if (!optionsValue.hud) details.push("HUD Off");
  if (optionsValue.compact) details.push("5-Column");
  return ["Calendar Tetris", ...details].join(" · ");
}
