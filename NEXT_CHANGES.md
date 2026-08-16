# Calendar Tetris: next changes

Status: implemented. This document records the requested cleanup, input, startup, and playfield-buffer behavior.

## Outcome

Both game modes should fill the 12:00 AM–12:00 PM Calendar viewport, begin pieces in a short spawn buffer above the main matrix, respond to terminal input as soon as the renderer is available, and remove every owned game calendar reliably on quit or explicit cleanup.

## 1. Repair cleanup

### Current failure

The `892:910` error points to `calendarIdentifier` in the cleanup discovery script. Calendar sometimes rejects that EventKit-backed property even for a calendar the game created. Cleanup should not depend on it.

### New cleanup contract

- Remove `calendarIdentifier` from cleanup discovery, deletion, postcondition checks, and persisted state.
- Discover calendars primarily by the exact ownership marker: `Owned by Calendar Tetris v1`.
- Also recognize a legacy partial calendar only when all three conditions hold:
  - its name starts with `__CALENDAR_TETRIS__`;
  - its description is blank;
  - it contains zero events.
- Never clear or delete a calendar with a different nonblank marker.
- Before clearing a managed calendar, verify that every event carries the game ownership marker.
- Clear events and delete calendars by managed name/reference, not EventKit identifier.
- Treat Calendar's command reply as advisory. After every delete, query the postcondition in a fresh AppleScript process:
  - calendar absent: success, even if deletion returned `-10000`;
  - calendar still present: retry with a bounded delay;
  - calendar still present after retries: report its name as remaining.
- Do not use `save` or `get count of calendars` as a synchronization barrier. Those calls have also produced `-10000`; a direct existence query is the useful barrier.
- Q, Ctrl-C, and `calendar-tetris cleanup` use this same cleanup path.

### Cleanup error output

Do not print a raw character range as the only diagnosis. A terminal failure should look like:

~~~text
Cleanup incomplete.
Calendar still contains 1 Calendar Tetris calendar:
  __CALENDAR_TETRIS__S

Try again: npx calendar-tetris cleanup
Last Calendar response: ...
~~~

## 2. Render terminal actions immediately

Calendar writes must remain serialized because the renderer plans each frame from the last acknowledged visible frame. The input scheduler can still remove unnecessary waiting.

### Required behavior

- If no Calendar write is active, apply a user action and submit its render immediately in the same input task.
- Cancel the pending gravity timer as soon as user input arrives.
- If a write is active, queue user commands in order; do not overwrite all pending input with one `pendingInput` value.
- When the active write is acknowledged, process queued user input and submit the next frame immediately. Never wait for the next gravity interval.
- User commands have priority over a queued gravity step. Gravity is disposable; user input is not.
- Rearm gravity only after the render queue is empty.
- Keep at most one Calendar write in flight so the backend does not advance several frames beyond what Calendar visibly acknowledged.

### Hard drop

Hard drop should be one logical input/render transaction:

1. Compute the landing position.
2. Lock the piece.
3. Clear completed lines.
4. Spawn the next piece.
5. Submit the resulting frame immediately.

The current intermediate "show landed piece, wait for acknowledgement, then lock and render again" path doubles hard-drop latency and should be removed.

## 3. Defer the first piece until Enter

Startup should prepare an empty board, then wait. The first active piece must not appear in Calendar before the user presses Enter.

### Revised startup sequence

~~~text
[1/2] Preparing 7 Game Calendars
[2/2] Resetting the board

Setup complete. Focus this terminal and press Enter.

← → Move   ↑ Rotate   ↓ Drop   Space Hard drop
C Hold     R Restart  Q Quit
~~~

After Enter:

- submit the first piece immediately;
- wait for that frame to be acknowledged;
- start gravity and accept gameplay input;
- do not add a per-frame terminal log.

## 4. Use the full 12-hour Calendar height

The renderer's origin moves from 1:00 AM to 12:00 AM. Both modes end exactly at 12:00 PM.

| Mode | Columns | Cell height | Total rendered rows | Spawn buffer | Main matrix | Calendar span |
|---|---:|---:|---:|---:|---:|---|
| Standard | 10 | 30 minutes | 24 | 4 rows | 20 rows | 12:00 AM–12:00 PM |
| 5-Column | 5 | 60 minutes | 12 | 2 rows | 10 rows | 12:00 AM–12:00 PM |

This keeps the existing gameplay matrix sizes while using the formerly empty hours as a natural entry area. In both modes the skyline—the top of the main matrix—is 2:00 AM.

## 5. Tetris buffer semantics

Modern Guideline-based Tetris uses a 10×20 visible matrix with an additional 20-row buffer above it. Pieces spawn in rows 21 and 22 at the bottom of that buffer. A piece may play or lock partially above the skyline; common game-over conditions include spawn overlap (block out) and locking completely above the visible matrix (lock out).

Sources:

- [TetrisWiki: Tetris Guideline](https://tetris.wiki/Tetris_Guideline)
- [TetrisWiki: Playfield and buffer zone](https://tetris.wiki/Playfield)
- [TetrisWiki: Top out variants](https://tetris.wiki/Top_out)

Calendar Tetris cannot render a full 20-row buffer without either extending past noon or making cells too short. It will therefore use a smaller Calendar-adapted buffer while keeping the relevant spawn and top-out behavior.

### Standard mode

- Logical board: 24×10.
- Buffer: rows 0–3, rendered from 12:00–2:00 AM.
- Main matrix: rows 4–23, rendered from 2:00 AM–12:00 PM.
- Spawn standard pieces flat-side down in the bottom two buffer rows, centered using the existing SRS convention.
- Permit movement and rotation in the buffer.
- Permit a piece to lock when at least one block is in the main matrix.
- Game over when a new piece overlaps the stack or a piece locks entirely in the buffer.
- Continue using SRS kicks against the full logical board.

### 5-Column mode

- Logical board: 12×5.
- Buffer: rows 0–1, rendered from 12:00–2:00 AM.
- Main matrix: rows 2–11, rendered from 2:00 AM–12:00 PM.
- Spawn the compact pieces flat-side down inside the two-row buffer.
- Use the same partial-lock and lock-out behavior as standard mode.
- Keep the custom piece set and labels: I, Domino, L, T, S, Z.

### Line clearing

- The board model includes buffer rows so blocks can survive temporarily above the skyline.
- Full lines are cleared and all rows above shift down, including buffer contents.
- The renderer displays buffer cells normally because Calendar has no separate hidden layer. With an empty board, the buffer appears as the desired blank lead-in before the first piece enters the matrix.

## 6. Source-of-truth rule

The last Calendar-acknowledged frame remains the authoritative visible state.

- Do not execute multiple state transitions while an older frame is still being written.
- Queue terminal commands while busy, then apply them as soon as the previous frame is acknowledged.
- Coalescing is allowed only when it preserves command order and produces the same game state; no user command may be silently replaced.
- Line clear, hold, rotation, and hard drop each submit one coherent resulting frame.

## 7. Verification

### Automated

- Every AppleScript compiles without launching Calendar.
- Cleanup scripts contain no `calendarIdentifier` access.
- Cleanup refuses nonblank foreign markers and nonempty unowned calendars.
- Standard rules expose 4 buffer + 20 matrix rows; compact rules expose 2 buffer + 10 matrix rows.
- Standard render events stay within 12:00 AM–12:00 PM at 30 minutes per row.
- Compact render events stay within 12:00 AM–12:00 PM at 60 minutes per row.
- Spawn positions occupy the bottom of each buffer.
- Partial lock above the skyline survives; full lock in the buffer ends the game.
- No first-piece render occurs before Enter.
- An input received during a render is submitted immediately after acknowledgement, ahead of gravity.
- Hard drop produces one resulting render request.

### Manual Calendar smoke test

1. Start each mode and confirm the board is empty while waiting for Enter.
2. Press Enter and confirm the first piece appears in the 12:00–2:00 AM buffer.
3. Confirm standard reaches noon with 20 matrix rows and compact reaches noon with 10 matrix rows.
4. Press movement/rotation/drop during gravity writes and confirm actions are neither lost nor delayed until another gravity tick.
5. Quit with Q and Ctrl-C, then verify every owned calendar is removed.
6. Run `npx calendar-tetris cleanup` twice; both runs should succeed, with the second acting as a no-op.

## Non-goals for this pass

- Rendering all 20 canonical hidden buffer rows.
- Changing scoring, levels, lock delay, next queue, hold rules, or piece colors.
- Parallel Calendar writes; serialization remains necessary to avoid stale render plans and tearing.
