import {
  type HyperXOGame,
  type Player,
  WINNING_LINES,
  recalcBoard,
  updateGlobalState,
  sanitizeNextBoardIndex,
} from './game';

// ---- Card types ----

export type PowerUpCategory = 'strike' | 'tactics' | 'disruption' | 'doctrine';

export type StrikeCard = 'gravity' | 'haste' | 'overwrite';
export type TacticsCard = 'redirect' | 'recall' | 'condemn';
export type DisruptionCard = 'swap' | 'shatter' | 'sabotage';
export type DoctrineCard = 'momentum' | 'siege' | 'arsenal';

export type ActiveCard = StrikeCard | TacticsCard | DisruptionCard;
export type PowerUpCard = ActiveCard | DoctrineCard;

// ---- Card definitions ----

export interface CardDef {
  id: PowerUpCard;
  name: string;
  category: PowerUpCategory;
  description: string;
  flavor: string;
  passive: boolean;
  targetType: 'none' | 'board' | 'opponent-cell';
}

export const CARD_CATALOG: Record<PowerUpCard, CardDef> = {
  // Strike
  'gravity': {
    id: 'gravity',
    name: 'Gravity',
    category: 'strike',
    description: 'All pieces on a board fall to the bottom of their columns.',
    flavor: 'Physics',
    passive: false,
    targetType: 'board',
  },
  'haste': {
    id: 'haste',
    name: 'Haste',
    category: 'strike',
    description: 'Take two consecutive turns.',
    flavor: 'Tempo',
    passive: false,
    targetType: 'none',
  },
  'overwrite': {
    id: 'overwrite',
    name: 'Overwrite',
    category: 'strike',
    description: 'Replace one opponent piece on a live board with yours.',
    flavor: 'Surgical',
    passive: false,
    targetType: 'opponent-cell',
  },
  // Tactics
  'redirect': {
    id: 'redirect',
    name: 'Redirect',
    category: 'tactics',
    description: 'Choose which board your opponent is sent to.',
    flavor: 'Control',
    passive: false,
    targetType: 'board',
  },
  'recall': {
    id: 'recall',
    name: 'Recall',
    category: 'tactics',
    description: 'Relocate one of your pieces to a different board.',
    flavor: 'Reposition',
    passive: false,
    targetType: 'none',
  },
  'condemn': {
    id: 'condemn',
    name: 'Condemn',
    category: 'tactics',
    description: 'Permanently remove a board from play.',
    flavor: 'Strategic',
    passive: false,
    targetType: 'board',
  },
  // Disruption
  'swap': {
    id: 'swap',
    name: 'Swap',
    category: 'disruption',
    description: 'Exchange all X and O pieces on a live board.',
    flavor: 'Chaos',
    passive: false,
    targetType: 'board',
  },
  'shatter': {
    id: 'shatter',
    name: 'Shatter',
    category: 'disruption',
    description: 'Wipe all pieces from a board, revoke win.',
    flavor: 'Nuclear',
    passive: false,
    targetType: 'board',
  },
  'sabotage': {
    id: 'sabotage',
    name: 'Sabotage',
    category: 'disruption',
    description: 'Remove one opponent piece from any board.',
    flavor: 'Precise',
    passive: false,
    targetType: 'opponent-cell',
  },
  // Doctrine
  'momentum': {
    id: 'momentum',
    name: 'Momentum',
    category: 'doctrine',
    description: 'When you win a board, take an extra turn.',
    flavor: 'Snowball',
    passive: true,
    targetType: 'none',
  },
  'siege': {
    id: 'siege',
    name: 'Siege',
    category: 'doctrine',
    description: '2-in-a-row unchallenged for 3 turns auto-claims the cell.',
    flavor: 'Pressure',
    passive: true,
    targetType: 'none',
  },
  'arsenal': {
    id: 'arsenal',
    name: 'Arsenal',
    category: 'doctrine',
    description: 'When you win a board, recharge a random used card (not the one played this turn).',
    flavor: 'Resupply',
    passive: true,
    targetType: 'none',
  },
};

// ---- Category card lists ----

export const STRIKE_CARDS: StrikeCard[] = ['gravity', 'haste', 'overwrite'];
export const TACTICS_CARDS: TacticsCard[] = ['redirect', 'recall', 'condemn'];
export const DISRUPTION_CARDS: DisruptionCard[] = ['swap', 'shatter', 'sabotage'];
export const DOCTRINE_CARDS: DoctrineCard[] = ['momentum', 'siege', 'arsenal'];

export const CATEGORIES: { key: PowerUpCategory; label: string; cards: PowerUpCard[] }[] = [
  { key: 'strike', label: 'Strike', cards: STRIKE_CARDS },
  { key: 'tactics', label: 'Tactics', cards: TACTICS_CARDS },
  { key: 'disruption', label: 'Disruption', cards: DISRUPTION_CARDS },
  { key: 'doctrine', label: 'Doctrine', cards: DOCTRINE_CARDS },
];

// ---- UI constants ----

export const CATEGORY_COLORS: Record<PowerUpCategory, {
  bg: string; ring: string; text: string; used: string; active: string;
}> = {
  strike:     { bg: 'bg-rose-500/15',   ring: 'ring-rose-500/60',   text: 'text-rose-400',   used: 'text-rose-800',   active: 'bg-rose-500/20 ring-rose-500/60' },
  tactics:    { bg: 'bg-sky-500/15',    ring: 'ring-sky-500/60',    text: 'text-sky-400',    used: 'text-sky-800',    active: 'bg-sky-500/20 ring-sky-500/60' },
  disruption: { bg: 'bg-violet-500/15', ring: 'ring-violet-500/60', text: 'text-violet-400', used: 'text-violet-800', active: 'bg-violet-500/20 ring-violet-500/60' },
  doctrine:   { bg: 'bg-amber-500/15',  ring: 'ring-amber-500/60',  text: 'text-amber-400',  used: 'text-amber-800',  active: 'bg-amber-500/20 ring-amber-500/60' },
};

export const CARD_FLASH_COLORS: Partial<Record<ActiveCard, string>> = {
  gravity: 'amber',
  overwrite: 'rose',
  sabotage: 'violet',
  recall: 'sky',
  swap: 'violet',
  shatter: 'rose',
  condemn: 'zinc',
};

// ---- Draft ----

export interface PowerUpDraft {
  strike: StrikeCard;
  tactics: TacticsCard;
  disruption: DisruptionCard;
  doctrine: DoctrineCard;
}

export function createDefaultDraft(): PowerUpDraft {
  return {
    strike: 'gravity',
    tactics: 'recall',
    disruption: 'swap',
    doctrine: 'momentum',
  };
}

export function isDraftComplete(partial: Partial<PowerUpDraft>): partial is PowerUpDraft {
  return !!(partial.strike && partial.tactics && partial.disruption && partial.doctrine);
}

// ---- In-game state ----

export interface PowerUpState {
  draft: PowerUpDraft;
  used: Record<string, boolean>;
}

export function createPowerUpState(draft: PowerUpDraft): PowerUpState {
  return { draft, used: {} };
}

export function getActiveCards(draft: PowerUpDraft): ActiveCard[] {
  return [draft.strike, draft.tactics, draft.disruption];
}

export function isCardUsed(state: PowerUpState, card: ActiveCard): boolean {
  return !!state.used[card];
}

export function useCard(state: PowerUpState, card: ActiveCard): void {
  state.used[card] = true;
}

export function getAvailableCards(state: PowerUpState): ActiveCard[] {
  return getActiveCards(state.draft).filter(c => !isCardUsed(state, c));
}

// ---- Two-player context ----

export interface PowerUpGameContext {
  X: PowerUpState;
  O: PowerUpState;
}

export function createPowerUpGameContext(xDraft: PowerUpDraft, oDraft: PowerUpDraft): PowerUpGameContext {
  return {
    X: createPowerUpState(xDraft),
    O: createPowerUpState(oDraft),
  };
}

// ---- Active card effects ----

// Recall: move one of your own pieces from a live board to an empty cell on another live board
export function applyRecall(
  game: HyperXOGame,
  fromBoard: number, fromCell: number,
  toBoard: number, toCell: number,
): void {
  const player = game.currentPlayer;
  const src = game.boards[fromBoard];
  const dst = game.boards[toBoard];

  if (src.condemned || src.winner || src.drawn) throw new Error('Source must be live');
  if (src.cells[fromCell] !== player) throw new Error('Can only recall own piece');
  if (fromBoard === toBoard) throw new Error('Must move to different board');
  if (dst.condemned || dst.winner || dst.drawn) throw new Error('Destination must be live');
  if (dst.cells[toCell] !== '') throw new Error('Destination must be empty');

  // Remove from source
  game.zkey ^= game.zobrist.pieceKey(fromBoard, fromCell, player);
  src.cells[fromCell] = '';
  recalcBoard(src);
  updateGlobalState(game);

  // Place at destination
  dst.cells[toCell] = player;
  game.zkey ^= game.zobrist.pieceKey(toBoard, toCell, player);
  recalcBoard(dst);
  updateGlobalState(game);
  sanitizeNextBoardIndex(game);
}

// Sabotage: remove one opponent piece
export function applySabotage(game: HyperXOGame, boardIdx: number, cellIdx: number): void {
  const board = game.boards[boardIdx];
  const opponent: Player = game.currentPlayer === 'X' ? 'O' : 'X';
  if (board.condemned) throw new Error('Cannot target condemned board');
  if (board.cells[cellIdx] !== opponent) throw new Error('Can only sabotage opponent piece');

  game.zkey ^= game.zobrist.pieceKey(boardIdx, cellIdx, opponent);
  board.cells[cellIdx] = '';

  recalcBoard(board);
  updateGlobalState(game);
  sanitizeNextBoardIndex(game);
}

// Overwrite: replace one opponent piece with yours
export function applyOverwrite(game: HyperXOGame, boardIdx: number, cellIdx: number): void {
  const board = game.boards[boardIdx];
  const player = game.currentPlayer;
  const opponent: Player = player === 'X' ? 'O' : 'X';
  if (board.condemned || board.winner || board.drawn) throw new Error('Cannot target resolved board');
  if (board.cells[cellIdx] !== opponent) throw new Error('Can only overwrite opponent piece');

  game.zkey ^= game.zobrist.pieceKey(boardIdx, cellIdx, opponent);
  board.cells[cellIdx] = player;
  game.zkey ^= game.zobrist.pieceKey(boardIdx, cellIdx, player);

  recalcBoard(board);
  updateGlobalState(game);
  sanitizeNextBoardIndex(game);
}

// Swap: exchange all X↔O on a board
export function applySwap(game: HyperXOGame, boardIdx: number): void {
  const board = game.boards[boardIdx];
  if (board.condemned || board.winner || board.drawn) throw new Error('Can only swap live board');

  for (let i = 0; i < 9; i++) {
    const cell = board.cells[i];
    if (cell === 'X') {
      game.zkey ^= game.zobrist.pieceKey(boardIdx, i, 'X');
      board.cells[i] = 'O';
      game.zkey ^= game.zobrist.pieceKey(boardIdx, i, 'O');
    } else if (cell === 'O') {
      game.zkey ^= game.zobrist.pieceKey(boardIdx, i, 'O');
      board.cells[i] = 'X';
      game.zkey ^= game.zobrist.pieceKey(boardIdx, i, 'X');
    }
  }

  recalcBoard(board);
  updateGlobalState(game);
  sanitizeNextBoardIndex(game);
}

// Shatter: wipe all pieces from a board, revoke win
export function applyShatter(game: HyperXOGame, boardIdx: number): void {
  const board = game.boards[boardIdx];
  if (board.condemned) throw new Error('Cannot shatter condemned board');

  for (let i = 0; i < 9; i++) {
    const cell = board.cells[i];
    if (cell === 'X' || cell === 'O') {
      game.zkey ^= game.zobrist.pieceKey(boardIdx, i, cell);
      board.cells[i] = '';
    }
  }

  board.winner = null;
  board.drawn = false;
  updateGlobalState(game);
  sanitizeNextBoardIndex(game);
}

// Condemn: permanently remove a board from play
export function applyCondemn(game: HyperXOGame, boardIdx: number): void {
  const board = game.boards[boardIdx];
  if (board.winner || board.drawn || board.condemned) throw new Error('Can only condemn live board');

  for (let i = 0; i < 9; i++) {
    const cell = board.cells[i];
    if (cell === 'X' || cell === 'O') {
      game.zkey ^= game.zobrist.pieceKey(boardIdx, i, cell);
      board.cells[i] = '';
    }
  }

  board.condemned = true;
  board.winner = null;
  board.drawn = false;
  updateGlobalState(game);

  // If directed to the now-condemned board, grant free move
  if (game.nextBoardIndex === boardIdx) {
    game.zkey ^= game.zobrist.nbiKey(game.nextBoardIndex);
    game.nextBoardIndex = null;
    game.zkey ^= game.zobrist.nbiKey(null);
  }
}

// Redirect: override opponent's next board (applied AFTER placement)
export function applyRedirect(game: HyperXOGame, targetBoard: number): void {
  const board = game.boards[targetBoard];
  if (board.winner || board.drawn || board.condemned) throw new Error('Redirect target must be live');

  game.zkey ^= game.zobrist.nbiKey(game.nextBoardIndex);
  game.nextBoardIndex = targetBoard;
  game.zkey ^= game.zobrist.nbiKey(game.nextBoardIndex);
}

// Gravity: pieces fall to the bottom of their columns
// Returns a map from old cell index to new cell index for pieces that moved.
export function computeGravity(cells: ('' | 'X' | 'O')[]): Map<number, number> {
  const moves = new Map<number, number>();
  // Process each column (cells 0,3,6 / 1,4,7 / 2,5,8)
  for (let col = 0; col < 3; col++) {
    const colCells = [col, col + 3, col + 6]; // top to bottom
    const pieces: { idx: number; val: 'X' | 'O' }[] = [];
    for (const idx of colCells) {
      if (cells[idx] !== '') pieces.push({ idx, val: cells[idx] as 'X' | 'O' });
    }
    // Place pieces at bottom of column (reverse order: fill from bottom)
    const bottomSlots = [...colCells].reverse(); // [col+6, col+3, col]
    for (let i = 0; i < pieces.length; i++) {
      const targetIdx = bottomSlots[i];
      const sourceIdx = pieces[pieces.length - 1 - i].idx; // bottom-most piece first
      if (sourceIdx !== targetIdx) {
        moves.set(sourceIdx, targetIdx);
      }
    }
  }
  return moves;
}

export function applyGravity(game: HyperXOGame, boardIdx: number): Map<number, number> {
  const board = game.boards[boardIdx];
  if (board.condemned || board.winner || board.drawn) throw new Error('Can only apply gravity to live board');

  const moves = computeGravity(board.cells as ('' | 'X' | 'O')[]);
  if (moves.size === 0) return moves;

  // Remove all moved pieces from Zobrist
  for (const [from] of moves) {
    const piece = board.cells[from] as 'X' | 'O';
    game.zkey ^= game.zobrist.pieceKey(boardIdx, from, piece);
  }

  // Apply the moves to the cells array
  const newCells = [...board.cells] as ('' | 'X' | 'O')[];
  // First clear all source cells that are moving
  for (const [from] of moves) {
    newCells[from] = '';
  }
  // Then place at destinations
  for (const [from, to] of moves) {
    newCells[to] = board.cells[from] as 'X' | 'O';
  }
  for (let i = 0; i < 9; i++) board.cells[i] = newCells[i];

  // Re-add all pieces to Zobrist at their new positions
  for (const [, to] of moves) {
    const piece = board.cells[to] as 'X' | 'O';
    game.zkey ^= game.zobrist.pieceKey(boardIdx, to, piece);
  }

  recalcBoard(board);
  updateGlobalState(game);
  sanitizeNextBoardIndex(game);
  return moves;
}

// ---- Siege passive helpers ----

export interface SiegeThreat {
  boardIdx: number;
  blockingCell: number;
  turnsUnblocked: number;
}

/** Scan all current 2-in-a-row threats for a player. */
export function scanSiegeThreats(game: HyperXOGame, player: Player): Omit<SiegeThreat, 'turnsUnblocked'>[] {
  const threats: Omit<SiegeThreat, 'turnsUnblocked'>[] = [];
  for (let bi = 0; bi < 9; bi++) {
    const board = game.boards[bi];
    if (board.winner || board.drawn || board.condemned) continue;
    for (const [a, b, c] of WINNING_LINES) {
      const trio = [board.cells[a], board.cells[b], board.cells[c]];
      const playerCount = trio.filter(t => t === player).length;
      const emptyIdx = trio.indexOf('');
      if (playerCount === 2 && emptyIdx !== -1) {
        const blockingCell = [a, b, c][emptyIdx];
        // Avoid duplicate threats for the same blocking cell
        if (!threats.some(t => t.boardIdx === bi && t.blockingCell === blockingCell)) {
          threats.push({ boardIdx: bi, blockingCell });
        }
      }
    }
  }
  return threats;
}

/** Refresh threat list after Siege player's move (detect new threats, keep counters). */
export function refreshSiegeThreats(
  existing: SiegeThreat[],
  game: HyperXOGame,
  player: Player,
): SiegeThreat[] {
  const current = scanSiegeThreats(game, player);
  return current.map(ct => {
    const prev = existing.find(t => t.boardIdx === ct.boardIdx && t.blockingCell === ct.blockingCell);
    return { ...ct, turnsUnblocked: prev?.turnsUnblocked ?? 0 };
  });
}

/** Advance counters after opponent's move. Returns updated threats and any auto-claimed cells. */
export function advanceSiegeThreats(
  existing: SiegeThreat[],
  game: HyperXOGame,
  player: Player,
): { updated: SiegeThreat[]; claimed: { boardIdx: number; cellIdx: number }[] } {
  const current = scanSiegeThreats(game, player);
  const claimed: { boardIdx: number; cellIdx: number }[] = [];
  const updated: SiegeThreat[] = [];

  for (const ct of current) {
    const prev = existing.find(t => t.boardIdx === ct.boardIdx && t.blockingCell === ct.blockingCell);
    const turnsUnblocked = prev ? prev.turnsUnblocked + 1 : 0;
    if (turnsUnblocked >= 3) {
      claimed.push({ boardIdx: ct.boardIdx, cellIdx: ct.blockingCell });
    } else {
      updated.push({ ...ct, turnsUnblocked });
    }
  }

  return { updated, claimed };
}

/** Place a Siege-claimed piece on the board. */
export function applySiegeClaim(game: HyperXOGame, boardIdx: number, cellIdx: number, player: Player): void {
  const board = game.boards[boardIdx];
  board.cells[cellIdx] = player;
  game.zkey ^= game.zobrist.pieceKey(boardIdx, cellIdx, player);
  recalcBoard(board);
  updateGlobalState(game);
  sanitizeNextBoardIndex(game);
}

// ---- Arsenal passive helper ----

/** Recharge a random used active card (excluding a specific card, e.g. the one just played).
 *  Returns the recharged card name or null. */
export function rechargeRandomCard(state: PowerUpState, exclude?: ActiveCard): ActiveCard | null {
  const usedCards = getActiveCards(state.draft).filter(c => isCardUsed(state, c) && c !== exclude);
  if (usedCards.length === 0) return null;
  const pick = usedCards[Math.floor(Math.random() * usedCards.length)];
  state.used[pick] = false;
  return pick;
}
