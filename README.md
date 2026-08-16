# 📅 Calendar Tetris

Play Tetris in Apple Calendar.

![](./assets/5-col-demo.png)
*5-Column mode with HUD off. Run with `npx calendar-tetris --5-col --no-hud`*

## Run

![](./assets/terminal-demo.png)

Run the CLI and follow the instructions to get started. Calendar Tetris requires macOS.

```sh
npx calendar-tetris
```

Control Calendar Tetris by entering keys into your terminal.

> [!WARNING]
> **Calendar Tetris requires permission to control your calendar.**
> It creates and uses its own calendars and should never affect your existing calendars.
> Nonetheless, if you have important information in your calendar, proceed with caution.


## Modes

![](./assets/10-col-demo.png)
*Default mode of 10 columns with HUD. Run with `npx calendar-tetris`*

### `--no-hud`

You can hide the HUD (Hold, Up Next, and the header) with the `--no-hud` flag.

```sh
npx calendar-tetris --no-hud
```

### `--5-col`

You can play a modified 5-column version of Tetris with the `--5-col` flag. It has the I (3-cell), Domino (2-cell), L, T, S, and Z pieces.
This mode has better performance since there are fewer events being created and edited.

```sh
npx calendar-tetris --5-col
```


## Cleanup

Calendar Tetris should automatically clean up any Calendars created during the game.

However, if the process was force-quit before automatic cleanup completed, run:

~~~sh
npx calendar-tetris cleanup
~~~

Cleanup should only ever remove game calendars created by Calendar Tetris. You can also safely manually perform cleanup by deleting calendars whose names start with `__CALENDAR_TETRIS__*`.

## How Does it Work?

Calendar Tetris controls your calendar with AppleScript and EventKit.
By creating calendars for every color needed, Calendar Tetris can create and edit events in the proper-colored calendars to turn events into Tetris blocks falling down your calendar.

## Development

~~~sh
npm install
npm test
~~~

The test suite compiles every AppleScript without launching or contacting Calendar.
