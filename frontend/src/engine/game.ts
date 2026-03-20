export type Player = 'X' | 'O';
export type Cell = 'X' | 'O' | '';

export const WINNING_LINES: readonly [number, number, number][] = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

// ---------- Zobrist hashing (32-bit) ----------

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0);
  };
}

export class Zobrist {
  pieceTable: number[][][]; // [big][cell][0=X, 1=O]
  sideToMove: number;
  nextBoardKey: number[]; // [0..8, 9=free]

  constructor(seed = 7777) {
    const rng = mulberry32(seed);
    this.pieceTable = Array.from({ length: 9 }, () =>
      Array.from({ length: 9 }, () => [rng(), rng()])
    );
    this.sideToMove = rng();
    this.nextBoardKey = Array.from({ length: 10 }, () => rng());
  }

  pieceKey(big: number, cell: number, player: Player): number {
    return this.pieceTable[big][cell][player === 'X' ? 0 : 1];
  }

  stmKey(): number {
    return this.sideToMove;
  }

  nbiKey(nbi: number | null): number {
    return this.nextBoardKey[nbi ?? 9];
  }
}

// ---------- Small board ----------

export interface SmallBoard {
  cells: Cell[];
  winner: Player | null;
  drawn: boolean;
}

export function createSmallBoard(): SmallBoard {
  return { cells: Array(9).fill(''), winner: null, drawn: false };
}

// ---------- Game state ----------

export interface HyperXOGame {
  boards: SmallBoard[];
  currentPlayer: Player;
  nextBoardIndex: number | null;
  winner: Player | null;
  drawn: boolean;
  zobrist: Zobrist;
  zkey: number;
}

export function createGame(): HyperXOGame {
  const zobrist = new Zobrist();
  const game: HyperXOGame = {
    boards: Array.from({ length: 9 }, () => createSmallBoard()),
    currentPlayer: 'X',
    nextBoardIndex: null,
    winner: null,
    drawn: false,
    zobrist,
    zkey: 0,
  };
  game.zkey ^= zobrist.nbiKey(null);
  return game;
}

// ---------- Queries ----------

export function bigBoardState(game: HyperXOGame): string[] {
  return game.boards.map(b =>
    b.winner === 'X' ? 'X'
    : b.winner === 'O' ? 'O'
    : b.drawn ? 'G'
    : '.'
  );
}

function isLive(b: SmallBoard): boolean {
  return !b.winner && !b.drawn && b.cells.some(c => c === '');
}

export function availableMoves(game: HyperXOGame): [number, number][] {
  const moves: [number, number][] = [];

  if (game.nextBoardIndex !== null && isLive(game.boards[game.nextBoardIndex])) {
    const i = game.nextBoardIndex;
    const b = game.boards[i];
    for (let j = 0; j < 9; j++) {
      if (b.cells[j] === '') moves.push([i, j]);
    }
    return moves;
  }

  for (let i = 0; i < 9; i++) {
    if (isLive(game.boards[i])) {
      for (let j = 0; j < 9; j++) {
        if (game.boards[i].cells[j] === '') moves.push([i, j]);
      }
    }
  }
  return moves;
}

// ---------- State for undo ----------

export interface UndoState {
  player: Player;
  prevNextBoardIndex: number | null;
  prevBoardWinner: Player | null;
  prevBoardDrawn: boolean;
  prevWinner: Player | null;
  prevDrawn: boolean;
}

export function captureUndo(game: HyperXOGame, big: number): UndoState {
  const board = game.boards[big];
  return {
    player: game.currentPlayer,
    prevNextBoardIndex: game.nextBoardIndex,
    prevBoardWinner: board.winner,
    prevBoardDrawn: board.drawn,
    prevWinner: game.winner,
    prevDrawn: game.drawn,
  };
}

// ---------- Mutations ----------

function updateGlobalState(game: HyperXOGame): void {
  const bb = bigBoardState(game);
  for (const [a, b, c] of WINNING_LINES) {
    if ((bb[a] === 'X' || bb[a] === 'O') && bb[a] === bb[b] && bb[b] === bb[c]) {
      game.winner = bb[a] as Player;
      game.drawn = false;
      return;
    }
  }
  if (availableMoves(game).length === 0) {
    game.winner = null;
    game.drawn = true;
  }
}

export function applyMove(game: HyperXOGame, big: number, cell: number): void {
  const { zobrist } = game;

  // Remove old forced-board component
  game.zkey ^= zobrist.nbiKey(game.nextBoardIndex);

  const player = game.currentPlayer;
  const board = game.boards[big];

  // Place piece
  board.cells[cell] = player;
  game.zkey ^= zobrist.pieceKey(big, cell, player);

  // Update small board state
  board.winner = null;
  board.drawn = false;
  for (const [a, b, c] of WINNING_LINES) {
    const v = board.cells[a];
    if (v !== '' && v === board.cells[b] && v === board.cells[c]) {
      board.winner = v as Player;
      break;
    }
  }
  if (board.winner === null && board.cells.every(c => c !== '')) {
    board.drawn = true;
  }

  // Update macro result
  updateGlobalState(game);

  // Compute next forced board
  const tb = game.boards[cell];
  game.nextBoardIndex = (tb.winner || tb.drawn || tb.cells.every(c => c !== '')) ? null : cell;

  // Add new forced-board component
  game.zkey ^= zobrist.nbiKey(game.nextBoardIndex);

  // Switch player
  game.currentPlayer = player === 'X' ? 'O' : 'X';
  game.zkey ^= zobrist.stmKey();
}

export function undoMove(game: HyperXOGame, big: number, cell: number, undo: UndoState): void {
  const { zobrist } = game;

  // Undo player switch
  game.zkey ^= zobrist.stmKey();
  game.currentPlayer = undo.player;

  // Undo forced-board
  game.zkey ^= zobrist.nbiKey(game.nextBoardIndex);
  game.nextBoardIndex = undo.prevNextBoardIndex;
  game.zkey ^= zobrist.nbiKey(game.nextBoardIndex);

  // Undo macro state
  game.winner = undo.prevWinner;
  game.drawn = undo.prevDrawn;

  // Undo small board state
  const board = game.boards[big];
  board.winner = undo.prevBoardWinner;
  board.drawn = undo.prevBoardDrawn;

  // Remove piece
  game.zkey ^= zobrist.pieceKey(big, cell, undo.player);
  board.cells[cell] = '';
}
