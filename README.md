# Calendar Tetris

Play Tetris in Apple Calendar. Calendar is the display; your terminal is the
controller.

## Run

Calendar Tetris requires macOS, Apple Calendar, and Node.js 20 or newer.

~~~sh
npx calendar-tetris
~~~

During setup, place Calendar and the terminal side by side, switch Calendar to
Week View, go to Today, and scroll to the top. Return focus to the terminal and
press Enter.

The board fills the midnight-to-noon viewport. Pieces enter through a short
12:00–2:00 AM buffer before reaching the main matrix.

Calendar Tetris asks for permission to control Calendar on its first run. It
creates dedicated calendars for the game and removes them when you quit.

## Options

~~~sh
# Compact five-column board with I, Domino, L, T, S, and Z pieces.
npx calendar-tetris --5-col

# Hide Score, Hold, Up Next, title, and elapsed time.
npx calendar-tetris --no-hud

# Combine both options.
npx calendar-tetris --5-col --no-hud
~~~

## Controls

- **Left/Right arrows:** Move
- **Up arrow:** Rotate clockwise
- **Down arrow:** Soft drop
- **Space:** Hard drop
- **C:** Hold
- **R:** Restart
- **Q** or **Control-C:** Quit and clean up

Normal gameplay does not log frames or status lines in the terminal. When the
game ends, it prints `GAME OVER. Press R to restart.`

## Cleanup

If the process was force-quit before automatic cleanup completed, run:

~~~sh
npx calendar-tetris cleanup
~~~

Cleanup verifies calendar ownership markers before deleting anything. It also
recognizes an empty partial calendar from an interrupted setup, but never
removes a nonempty unowned calendar. Cleanup removes all game calendars and
their contained events directly in one EventKit commit; it does not delete
events one at a time. Before changing anything, it requests Calendar Automation
and Full Calendar Access when macOS has not already decided those permissions.

## Development

~~~sh
npm install
npm test
~~~

The test suite compiles every AppleScript without launching or contacting
Calendar.
