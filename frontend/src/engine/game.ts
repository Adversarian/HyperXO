export type GameMode = 'classic' | 'sudden-death' | 'misere' | 'conquest';
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
  condemned: boolean;
}

export function createSmallBoard(): SmallBoard {
  return { cells: Array(9).fill(''), winner: null, drawn: false, condemned: false };
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
  mode: GameMode;
  conquestBonusBoards: number[];
}

export function createGame(mode: GameMode = 'classic', conquestBonusBoards?: number[]): HyperXOGame {
  const zobrist = new Zobrist();
  let bonus: number[] = [];
  if (mode === 'conquest') {
    if (conquestBonusBoards) {
      bonus = conquestBonusBoards;
    } else {
      const indices = [0, 1, 2, 3, 4, 5, 6, 7, 8];
      for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }
      bonus = indices.slice(0, 3).sort((a, b) => a - b);
    }
  }
  const game: HyperXOGame = {
    boards: Array.from({ length: 9 }, () => createSmallBoard()),
    currentPlayer: 'X',
    nextBoardIndex: null,
    winner: null,
    drawn: false,
    zobrist,
    zkey: 0,
    mode,
    conquestBonusBoards: bonus,
  };
  game.zkey ^= zobrist.nbiKey(null);
  return game;
}

// ---------- Conquest scoring ----------

export function computeConquestScores(game: HyperXOGame): { X: number; O: number } {
  let X = 0, O = 0;
  const bonusSet = new Set(game.conquestBonusBoards);
  for (let i = 0; i < 9; i++) {
    const winner = game.boards[i].winner;
    if (!winner) continue;
    const value = bonusSet.has(i) ? 2 : 1;
    if (winner === 'X') X += value;
    else O += value;
  }
  return { X, O };
}

// ---------- Queries ----------

/** Independently verify that game.winner matches the actual board state. */
export function validateWinner(game: HyperXOGame): string | null {
  const bb = bigBoardState(game);

  if (game.mode === 'sudden-death') {
    const firstWon = game.boards.find(b => b.winner);
    const expected = firstWon ? firstWon.winner : null;
    if (game.winner !== expected) {
      return `sudden-death: expected winner=${expected}, got winner=${game.winner}`;
    }
    return null;
  }

  if (game.mode === 'conquest') {
    const scores = computeConquestScores(game);
    const bonusSet = new Set(game.conquestBonusBoards);
    let remainingPoints = 0;
    for (let i = 0; i < 9; i++) {
      const b = game.boards[i];
      if (!b.winner && !b.drawn && !b.condemned) remainingPoints += bonusSet.has(i) ? 2 : 1;
    }
    const allFinished = remainingPoints === 0;

    // Check early termination
    if (scores.X > scores.O + remainingPoints) {
      if (game.winner !== 'X') return `conquest: X should win by early termination (${scores.X} vs max ${scores.O + remainingPoints})`;
      return null;
    }
    if (scores.O > scores.X + remainingPoints) {
      if (game.winner !== 'O') return `conquest: O should win by early termination (${scores.O} vs max ${scores.X + remainingPoints})`;
      return null;
    }

    if (allFinished || availableMoves(game).length === 0) {
      if (scores.X > scores.O) {
        if (game.winner !== 'X') return `conquest: X should win (${scores.X}-${scores.O})`;
      } else if (scores.O > scores.X) {
        if (game.winner !== 'O') return `conquest: O should win (${scores.O}-${scores.X})`;
      } else {
        const xBonus = game.conquestBonusBoards.filter(i => game.boards[i].winner === 'X').length;
        const oBonus = game.conquestBonusBoards.filter(i => game.boards[i].winner === 'O').length;
        if (xBonus > oBonus) {
          if (game.winner !== 'X') return `conquest: X should win tiebreaker (${xBonus} vs ${oBonus} bonus boards)`;
        } else if (oBonus > xBonus) {
          if (game.winner !== 'O') return `conquest: O should win tiebreaker (${oBonus} vs ${xBonus} bonus boards)`;
        } else {
          if (!game.drawn) return `conquest: should be draw (${scores.X}-${scores.O}, equal bonus boards)`;
        }
      }
      return null;
    }

    // Game should still be in progress
    if (game.winner || game.drawn) return `conquest: game should be in progress but winner=${game.winner} drawn=${game.drawn}`;
    return null;
  }

  // Classic / Misère: check macro lines
  let lineWinner: Player | null = null;
  for (const [a, b, c] of WINNING_LINES) {
    if ((bb[a] === 'X' || bb[a] === 'O') && bb[a] === bb[b] && bb[b] === bb[c]) {
      if (game.mode === 'misere') {
        lineWinner = bb[a] === 'X' ? 'O' : 'X';
      } else {
        lineWinner = bb[a] as Player;
      }
      break;
    }
  }

  if (game.winner !== lineWinner) {
    return `${game.mode}: expected winner=${lineWinner}, got winner=${game.winner}, bigBoard=[${bb}]`;
  }

  // Validate early macro draw: if game.drawn is true and no winner, check that
  // every macro line is indeed blocked (or no moves remain)
  if (game.drawn && !game.winner) {
    let anyOpen = false;
    for (const [a, b, c] of WINNING_LINES) {
      const marks = [bb[a], bb[b], bb[c]];
      if (!marks.includes('X') || !marks.includes('O')) {
        anyOpen = true;
        break;
      }
    }
    if (anyOpen && availableMoves(game).length > 0) {
      return `${game.mode}: game marked drawn but macro line still open, bigBoard=[${bb}]`;
    }
  }

  return null;
}

export function bigBoardState(game: HyperXOGame): string[] {
  return game.boards.map(b =>
    b.winner === 'X' ? 'X'
    : b.winner === 'O' ? 'O'
    : (b.drawn || b.condemned) ? 'G'
    : '.'
  );
}

function isLive(b: SmallBoard): boolean {
  return !b.winner && !b.drawn && !b.condemned && b.cells.some(c => c === '');
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

// ---------- Next-board sanitizer ----------

/** If nextBoardIndex points to a resolved/full board, reset to null (free move). */
export function sanitizeNextBoardIndex(game: HyperXOGame): void {
  if (game.nextBoardIndex !== null) {
    const nb = game.boards[game.nextBoardIndex];
    if (nb.winner || nb.drawn || nb.condemned || nb.cells.every(c => c !== '')) {
      game.zkey ^= game.zobrist.nbiKey(game.nextBoardIndex);
      game.nextBoardIndex = null;
      game.zkey ^= game.zobrist.nbiKey(null);
    }
  }
}

// ---------- Mutations ----------

export function recalcBoard(board: SmallBoard): void {
  if (board.condemned) return;
  board.winner = null;
  board.drawn = false;
  for (const [a, b, c] of WINNING_LINES) {
    const v = board.cells[a];
    if (v !== '' && v === board.cells[b] && v === board.cells[c]) {
      board.winner = v as Player;
      break;
    }
  }
  if (!board.winner && board.cells.every(c => c !== '')) {
    board.drawn = true;
  }
}

export function updateGlobalState(game: HyperXOGame): void {
  // Reset previous result — card effects can revoke wins
  game.winner = null;
  game.drawn = false;

  if (game.mode === 'sudden-death') {
    for (const b of game.boards) {
      if (b.winner) {
        game.winner = b.winner;
        return;
      }
    }
    if (availableMoves(game).length === 0) {
      game.drawn = true;
    }
    return;
  }

  if (game.mode === 'conquest') {
    const scores = computeConquestScores(game);
    const bonusSet = new Set(game.conquestBonusBoards);
    let remainingPoints = 0;
    for (let i = 0; i < 9; i++) {
      const b = game.boards[i];
      if (!b.winner && !b.drawn && !b.condemned) remainingPoints += bonusSet.has(i) ? 2 : 1;
    }

    // Early termination: trailing player can't catch up
    if (scores.X > scores.O + remainingPoints) { game.winner = 'X'; return; }
    if (scores.O > scores.X + remainingPoints) { game.winner = 'O'; return; }

    // All boards finished or no moves left
    if (remainingPoints === 0 || availableMoves(game).length === 0) {
      if (scores.X > scores.O) { game.winner = 'X'; return; }
      if (scores.O > scores.X) { game.winner = 'O'; return; }
      // Tiebreaker: more bonus boards captured
      const xBonus = game.conquestBonusBoards.filter(i => game.boards[i].winner === 'X').length;
      const oBonus = game.conquestBonusBoards.filter(i => game.boards[i].winner === 'O').length;
      if (xBonus > oBonus) { game.winner = 'X'; return; }
      if (oBonus > xBonus) { game.winner = 'O'; return; }
      game.drawn = true;
      return;
    }
    return;
  }

  // Classic and Misère both check for 3-in-a-row on the macro board
  const bb = bigBoardState(game);
  for (const [a, b, c] of WINNING_LINES) {
    if ((bb[a] === 'X' || bb[a] === 'O') && bb[a] === bb[b] && bb[b] === bb[c]) {
      if (game.mode === 'misere') {
        game.winner = bb[a] === 'X' ? 'O' : 'X';
      } else {
        game.winner = bb[a] as Player;
      }
      return;
    }
  }

  // Early macro draw: if every macro winning line is blocked
  // (contains boards won by different players), neither player can win.
  let anyMacroLineOpen = false;
  for (const [a, b, c] of WINNING_LINES) {
    const marks = [bb[a], bb[b], bb[c]];
    const hasX = marks.includes('X');
    const hasO = marks.includes('O');
    // A line is still open if it doesn't have BOTH X and O board winners
    if (!hasX || !hasO) {
      anyMacroLineOpen = true;
      break;
    }
  }
  if (!anyMacroLineOpen) {
    game.drawn = true;
    return;
  }

  if (availableMoves(game).length === 0) {
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

  // Update small board state (includes early draw detection)
  recalcBoard(board);

  // Update macro result
  updateGlobalState(game);

  // Compute next forced board
  const tb = game.boards[cell];
  game.nextBoardIndex = (tb.winner || tb.drawn || tb.condemned || tb.cells.every(c => c !== '')) ? null : cell;

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
