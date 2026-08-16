#!/usr/bin/env node

import { CalendarRenderer } from "./calendar.js";
import { cleanupManagedCalendars } from "./cleanup.js";
import { compactRules, standardRules, TetrisGame } from "./game.js";

interface Options {
  command: "run" | "cleanup" | "help" | "version";
  compact: boolean;
  hud: boolean;
}

const useColor = Boolean(process.stdout.isTTY && !("NO_COLOR" in process.env));

const style = {
  title: (text: string): string => ansi("1;36", text),
  bold: (text: string): string => ansi("1", text),
  success: (text: string): string => ansi("1;32", text),
  warning: (text: string): string => ansi("33", text),
  danger: (text: string): string => ansi("1;31", text),
  key: (text: string): string => ansi("1", text),
  callToAction: (text: string): string => ansi("1;33", text),
  dim: (text: string): string => ansi("2", text),
} as const;

try {
  const options = parseOptions(process.argv.slice(2));
  if (options.command === "help") showHelp();
  else if (options.command === "version") console.log("0.1.0");
  else if (options.command === "cleanup") await runCleanup();
  else await runGame(options);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n${style.danger(message)}`);
  const automationDenied = message.includes("-1743")
    || message.toLowerCase().includes("not authorized")
    || message.includes("Calendar Automation access");
  if (automationDenied) {
    console.error("\nAllow your terminal to control Calendar in:");
    console.error("System Settings → Privacy & Security → Automation");
  }
  if (message.includes("Full Calendar Access")) {
    console.error("\nAllow Full Calendar Access in:");
    console.error("System Settings → Privacy & Security → Calendars");
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
  console.log(style.title("Calendar Tetris"));
  console.log(style.warning("Cleaning up calendars used for Calendar Tetris."));
  await cleanupManagedCalendars((message) => console.log(formatStep(message)));
  console.log(style.success("Cleanup complete."));
}

async function runGame(optionsValue: Options): Promise<void> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("Calendar Tetris requires an interactive terminal.");
  }

  const renderer = new CalendarRenderer({ compact: optionsValue.compact, hud: optionsValue.hud });
  const rules = optionsValue.compact ? compactRules : standardRules;
  const game = new TetrisGame(rules);

  console.log(style.title(titleFor(optionsValue)));
  console.log();
  let instructionsShown = false;
  const showInstructions = (): void => {
    if (instructionsShown) return;
    instructionsShown = true;
    console.log(`${style.bold("Setting up.")} While you’re waiting...\n`);
    console.log(`${style.dim("1.")} Place both Calendar and this terminal in view.`);
    console.log(`${style.dim("2.")} Set Calendar to Week View (${style.key("⌘2")}) and Go to Today (${style.key("⌘T")}).`);
    console.log(`${style.dim("3.")} Scroll up to the top of Calendar.\n`);
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
    console.error(`\n${style.danger("Cleanup interrupted.")} Clean up manually with:`);
    console.error(style.key("npx calendar-tetris cleanup"));
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
    console.log(`\n${style.warning("Stopped. Cleaning up calendars used for Calendar Tetris.")}`);
    console.log(style.dim("Press ^C again to force quit. If you do, clean up manually with:"));
    console.log(`${style.dim("npx calendar-tetris cleanup")}\n`);

    try {
      await currentOperation?.catch(() => {});
      await activeRender?.catch(() => {});
      await renderer.close().catch(() => {});
      await cleanupManagedCalendars();
      console.log(style.success("Cleanup complete."));
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
    console.log(formatStep(label));
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
      () => renderer.prepareCalendars(),
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

  console.log(`\n${style.success("Setup complete.")}\n`);
  console.log(`${style.key("← →")} ${style.dim("Move")}   ${style.key("↑")} ${style.dim("Rotate")}   ${style.key("↓")} ${style.dim("Drop")}   ${style.key("Space")} ${style.dim("Hard drop")}`);
  console.log(`${style.key("C")} ${style.dim("Hold")}     ${style.key("R")} ${style.dim("Restart")}  ${style.key("Q")} ${style.dim("Quit")}\n`);
  console.log(`Focus this terminal and press ${style.callToAction("Enter")} to start.\n`);
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
  console.log(`${style.success("Game started.")}\n`);

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
      console.log(`\n${style.danger("GAME OVER.")} Press ${style.key("R")} to restart.`);
    }
  };

  const clearGameOver = (): void => {
    if (!gameOverShown) return;
    gameOverShown = false;
    process.stdout.write("\x1B[1A\x1B[2K");
  };

  const stopAfterRenderError = (error: unknown): void => {
    if (shuttingDown) return;
    console.error(`\n${style.danger("Calendar rendering stopped:")} ${error instanceof Error ? error.message : String(error)}`);
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
    const queued = pendingInputs.splice(0);
    if (queued.length === 0) {
      armGravity();
      return;
    }
    // Calendar can finish only one frame at a time. Apply every key received
    // during that frame, then draw their combined result once instead of
    // making the player wait through a stale frame for every queued key.
    renderTransition(() => {
      let changed = false;
      for (const input of queued) changed = applyInput(input) || changed;
      return changed;
    });
  }

  function armGravity(): void {
    if (gravityTimer) clearTimeout(gravityTimer);
    if (shuttingDown || activeRender || game.gameOver) return;
    gravityTimer = setTimeout(() => {
      gravityTimer = undefined;
      renderTransition(() => game.softDrop());
    }, 600);
  }

  function dispatchInput(input: string): void {
    if (shuttingDown) return;
    if (gravityTimer) clearTimeout(gravityTimer);
    gravityTimer = undefined;
    if (activeRender) {
      pendingInputs.push(input);
      return;
    }
    renderTransition(() => applyInput(input));
  }

  function applyInput(input: string): boolean {
    switch (input) {
      case "\u001B[D":
        return game.moveLeft();
      case "\u001B[C":
        return game.moveRight();
      case "\u001B[A":
        return game.rotateClockwise();
      case "\u001B[B":
        return game.softDrop();
      case " ":
        return game.hardDrop();
      case "c":
      case "C":
        return game.hold();
      case "r":
      case "R":
        clearGameOver();
        game.reset();
        gameStartedAt = performance.now();
        displayedElapsedSeconds = 0;
        return true;
      default:
        return false;
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
    console.log(style.warning("Calendar Tetris needs permissions to control Calendar."));
    console.log(`Choose ${style.key("Allow")} when the permission prompt appears.\n`);
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

function ansi(codes: string, text: string): string {
  return useColor ? `\u001B[${codes}m${text}\u001B[0m` : text;
}

function formatStep(message: string): string {
  return message.replace(/^(\[\d+\/\d+\])/u, (counter) => style.dim(counter));
}
