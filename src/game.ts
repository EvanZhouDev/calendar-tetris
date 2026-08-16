export type GameMode = "standard" | "compact";

export type PieceID =
  | "I"
  | "O"
  | "J"
  | "L"
  | "T"
  | "S"
  | "Z"
  | "I3"
  | "D"
  | "L3";

export interface Point {
  x: number;
  y: number;
}

export interface PieceDefinition {
  id: PieceID;
  label: string;
  color: string;
  cells: readonly Point[];
  boxSize: number;
  rotation: "none" | "standard" | "line" | "compact";
}

export interface Rules {
  mode: GameMode;
  width: number;
  height: number;
  pieces: readonly PieceDefinition[];
}

export interface ActivePiece {
  id: PieceID;
  rotation: number;
  x: number;
  y: number;
}

export interface GameSnapshot {
  width: number;
  height: number;
  settled: ReadonlyArray<ReadonlyArray<PieceID | null>>;
  active: ActivePiece;
  activeCells: readonly Point[];
  held: PieceID | null;
  next: readonly PieceID[];
  score: number;
  lines: number;
  gameOver: boolean;
}

const colors = {
  cyan: "#00BCD4",
  yellow: "#FFD60A",
  purple: "#AF52DE",
  green: "#34C759",
  red: "#FF3B30",
  blue: "#007AFF",
  orange: "#FF9500",
} as const;

const standardPieces: readonly PieceDefinition[] = [
  piece("I", "I", colors.cyan, [[0, 1], [1, 1], [2, 1], [3, 1]], 4, "line"),
  piece("O", "O", colors.yellow, [[1, 0], [2, 0], [1, 1], [2, 1]], 4, "none"),
  piece("T", "T", colors.purple, [[1, 0], [0, 1], [1, 1], [2, 1]], 3, "standard"),
  piece("S", "S", colors.green, [[1, 0], [2, 0], [0, 1], [1, 1]], 3, "standard"),
  piece("Z", "Z", colors.red, [[0, 0], [1, 0], [1, 1], [2, 1]], 3, "standard"),
  piece("J", "J", colors.blue, [[0, 0], [0, 1], [1, 1], [2, 1]], 3, "standard"),
  piece("L", "L", colors.orange, [[2, 0], [0, 1], [1, 1], [2, 1]], 3, "standard"),
];

const compactPieces: readonly PieceDefinition[] = [
  piece("I3", "I", colors.cyan, [[0, 1], [1, 1], [2, 1]], 3, "compact"),
  piece("D", "Domino", colors.yellow, [[0, 0], [1, 0]], 2, "compact"),
  piece("L3", "L", colors.orange, [[0, 0], [0, 1], [1, 1]], 2, "compact"),
  piece("T", "T", colors.purple, [[1, 0], [0, 1], [1, 1], [2, 1]], 3, "standard"),
  piece("S", "S", colors.green, [[1, 0], [2, 0], [0, 1], [1, 1]], 3, "standard"),
  piece("Z", "Z", colors.red, [[0, 0], [1, 0], [1, 1], [2, 1]], 3, "standard"),
];

export const standardRules: Rules = {
  mode: "standard",
  width: 10,
  height: 20,
  pieces: standardPieces,
};

export const compactRules: Rules = {
  mode: "compact",
  width: 5,
  height: 10,
  pieces: compactPieces,
};

const standardKicks: ReadonlyArray<readonly Point[]> = [
  points([[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]]),
  points([[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]]),
  points([[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]]),
  points([[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]]),
];

const lineKicks: ReadonlyArray<readonly Point[]> = [
  points([[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]]),
  points([[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]]),
  points([[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]]),
  points([[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]]),
];

const compactKicks: readonly Point[] = [
  point([0, 0]),
  point([-1, 0]),
  point([1, 0]),
  point([0, -1]),
  point([-2, 0]),
  point([2, 0]),
];

export class TetrisGame {
  readonly rules: Rules;
  score = 0;
  lines = 0;
  gameOver = false;

  private board: Array<Array<PieceID | null>>;
  private active: ActivePiece;
  private queue: PieceID[] = [];
  private held: PieceID | null = null;
  private holdUsed = false;
  private readonly definitions: ReadonlyMap<PieceID, PieceDefinition>;

  constructor(
    rules: Rules = standardRules,
    private readonly random: () => number = Math.random,
  ) {
    this.rules = rules;
    this.definitions = new Map(rules.pieces.map((definition) => [definition.id, definition]));
    this.board = emptyBoard(rules.width, rules.height);
    this.active = this.spawnState(rules.pieces[0]?.id ?? "T");
    this.spawnNext();
  }

  get snapshot(): GameSnapshot {
    this.fillQueue(3);
    return {
      width: this.rules.width,
      height: this.rules.height,
      settled: this.board.map((row) => [...row]),
      active: { ...this.active },
      activeCells: this.cellsFor(this.active),
      held: this.held,
      next: this.queue.slice(0, 3),
      score: this.score,
      lines: this.lines,
      gameOver: this.gameOver,
    };
  }

  definition(id: PieceID): PieceDefinition {
    const definition = this.definitions.get(id);
    if (!definition) throw new TypeError(`Unknown piece ${id} for ${this.rules.mode} mode.`);
    return definition;
  }

  moveLeft(): boolean {
    return this.move(-1, 0);
  }

  moveRight(): boolean {
    return this.move(1, 0);
  }

  softDrop(): boolean {
    if (this.gameOver) return false;
    if (this.move(0, 1)) return true;
    this.lockPiece();
    return true;
  }

  dropToBottom(): boolean {
    if (this.gameOver) return false;
    while (this.move(0, 1)) {}
    return true;
  }

  lockGroundedPiece(): boolean {
    if (this.gameOver) return false;
    if (!this.collides({ ...this.active, y: this.active.y + 1 })) return false;
    this.lockPiece();
    return true;
  }

  rotateClockwise(): boolean {
    if (this.gameOver) return false;
    const definition = this.definition(this.active.id);
    if (definition.rotation === "none") return false;

    const nextRotation = (this.active.rotation + 1) % 4;
    const kicks = this.kicksFor(definition, this.active.rotation);
    for (const kick of kicks) {
      const candidate = {
        ...this.active,
        rotation: nextRotation,
        x: this.active.x + kick.x,
        y: this.active.y + kick.y,
      };
      if (!this.collides(candidate)) {
        this.active = candidate;
        return true;
      }
    }
    return false;
  }

  hold(): boolean {
    if (this.gameOver || this.holdUsed) return false;

    const outgoing = this.active.id;
    if (this.held === null) {
      this.held = outgoing;
      this.spawnNext(false);
    } else {
      const incoming = this.held;
      this.held = outgoing;
      this.active = this.spawnState(incoming);
      if (this.collides(this.active)) this.gameOver = true;
    }
    this.holdUsed = true;
    return true;
  }

  reset(): void {
    this.board = emptyBoard(this.rules.width, this.rules.height);
    this.queue = [];
    this.held = null;
    this.holdUsed = false;
    this.score = 0;
    this.lines = 0;
    this.gameOver = false;
    this.spawnNext();
  }

  private move(deltaX: number, deltaY: number): boolean {
    if (this.gameOver) return false;
    const candidate = {
      ...this.active,
      x: this.active.x + deltaX,
      y: this.active.y + deltaY,
    };
    if (this.collides(candidate)) return false;
    this.active = candidate;
    return true;
  }

  private lockPiece(): void {
    for (const cell of this.cellsFor(this.active)) {
      if (cell.y < 0) {
        this.gameOver = true;
        return;
      }
      const row = this.board[cell.y];
      if (row) row[cell.x] = this.active.id;
    }

    const remaining = this.board.filter((row) => row.some((cell) => cell === null));
    const removed = this.rules.height - remaining.length;
    this.board = [
      ...Array.from({ length: removed }, () => emptyRow(this.rules.width)),
      ...remaining,
    ];
    this.lines += removed;
    this.score += [0, 100, 300, 500, 800][removed] ?? removed * 200;
    this.spawnNext();
  }

  private spawnNext(resetHold = true): void {
    this.fillQueue(1);
    const id = this.queue.shift() ?? this.rules.pieces[0]?.id ?? "T";
    this.active = this.spawnState(id);
    if (this.collides(this.active)) this.gameOver = true;
    if (resetHold) this.holdUsed = false;
  }

  private spawnState(id: PieceID): ActivePiece {
    const definition = this.definition(id);
    return {
      id,
      rotation: 0,
      x: Math.floor((this.rules.width - definition.boxSize) / 2),
      y: 0,
    };
  }

  private fillQueue(count: number): void {
    while (this.queue.length < count) {
      const bag = this.rules.pieces.map((piece) => piece.id);
      for (let index = bag.length - 1; index > 0; index -= 1) {
        const other = Math.floor(this.random() * (index + 1));
        [bag[index], bag[other]] = [bag[other] as PieceID, bag[index] as PieceID];
      }
      this.queue.push(...bag);
    }
  }

  private cellsFor(active: ActivePiece): Point[] {
    const definition = this.definition(active.id);
    let cells = definition.cells.map((cell) => ({ ...cell }));
    if (definition.rotation === "none") return cells.map((cell) => offset(cell, active));

    for (let turn = 0; turn < active.rotation; turn += 1) {
      cells = cells.map((cell) => ({
        x: definition.boxSize - 1 - cell.y,
        y: cell.x,
      }));
    }
    return cells.map((cell) => offset(cell, active));
  }

  private collides(active: ActivePiece): boolean {
    return this.cellsFor(active).some((cell) => {
      if (cell.x < 0 || cell.x >= this.rules.width || cell.y >= this.rules.height) return true;
      if (cell.y < 0) return false;
      return this.board[cell.y]?.[cell.x] !== null;
    });
  }

  private kicksFor(definition: PieceDefinition, rotation: number): readonly Point[] {
    if (definition.rotation === "line") return lineKicks[rotation] ?? compactKicks;
    if (definition.rotation === "standard") return standardKicks[rotation] ?? compactKicks;
    return compactKicks;
  }
}

function piece(
  id: PieceID,
  label: string,
  color: string,
  cells: ReadonlyArray<readonly [number, number]>,
  boxSize: number,
  rotation: PieceDefinition["rotation"],
): PieceDefinition {
  return { id, label, color, cells: cells.map(point), boxSize, rotation };
}

function point([x, y]: readonly [number, number]): Point {
  return { x, y };
}

function points(values: ReadonlyArray<readonly [number, number]>): Point[] {
  return values.map(point);
}

function offset(pointValue: Point, active: ActivePiece): Point {
  return { x: pointValue.x + active.x, y: pointValue.y + active.y };
}

function emptyRow(width: number): Array<PieceID | null> {
  return Array.from({ length: width }, () => null);
}

function emptyBoard(width: number, height: number): Array<Array<PieceID | null>> {
  return Array.from({ length: height }, () => emptyRow(width));
}
