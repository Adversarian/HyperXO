import {
  type HyperXOGame,
  type Player,
  WINNING_LINES,
  availableMoves,
  applyMove,
  captureUndo,
  undoMove,
  bigBoardState,
  recalcBoard,
  updateGlobalState,
} from './game';
import {
  type PowerUpDraft,
  type PowerUpState,
  type ActiveCard,
  type PowerUpCard,
  STRIKE_CARDS,
  TACTICS_CARDS,
  DISRUPTION_CARDS,
  DOCTRINE_CARDS,
  CARD_FLASH_COLORS,
  getAvailableCards,
  applyOverwrite,
  applySabotage,
  applyRecall,
  applySwap,
  applyShatter,
  applyCondemn,
} from './powerups';
import { evaluateForPlayer, choose, createAI } from './ai';
import { computeConquestScores } from './game';

// ---- Snapshot / Restore (for simulating card effects) ----

interface GameSnapshot {
  cells: ('X' | 'O' | '')[][];
  winners: (Player | null)[];
  drawn: boolean[];
  condemned: boolean[];
  winner: Player | null;
  gameDrawn: boolean;
  currentPlayer: Player;
  nextBoardIndex: number | null;
  zkey: number;
}

export function snapshot(game: HyperXOGame): GameSnapshot {
  return {
    cells: game.boards.map(b => [...b.cells]),
    winners: game.boards.map(b => b.winner),
    drawn: game.boards.map(b => b.drawn),
    condemned: game.boards.map(b => b.condemned),
    winner: game.winner,
    gameDrawn: game.drawn,
    currentPlayer: game.currentPlayer,
    nextBoardIndex: game.nextBoardIndex,
    zkey: game.zkey,
  };
}

export function restore(game: HyperXOGame, snap: GameSnapshot): void {
  for (let i = 0; i < 9; i++) {
    game.boards[i].cells = [...snap.cells[i]];
    game.boards[i].winner = snap.winners[i];
    game.boards[i].drawn = snap.drawn[i];
    game.boards[i].condemned = snap.condemned[i];
  }
  game.winner = snap.winner;
  game.drawn = snap.gameDrawn;
  game.currentPlayer = snap.currentPlayer;
  game.nextBoardIndex = snap.nextBoardIndex;
  game.zkey = snap.zkey;
}

// ---- AI Ban + Draft ----

function weightedPick<T>(arr: readonly T[], weights: number[]): T {
  if (arr.length === 0) throw new Error('Cannot pick from empty array');
  if (arr.length === 1) return arr[0];
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < arr.length; i++) {
    r -= weights[i];
    if (r <= 0) return arr[i];
  }
  return arr[arr.length - 1];
}

/** Filter an array and its paired weights by removing banned entries. */
function filterBanned<T extends string>(
  arr: readonly T[], weights: number[], banned: Set<string>,
): { items: T[]; weights: number[] } {
  const items: T[] = [];
  const w: number[] = [];
  for (let i = 0; i < arr.length; i++) {
    if (!banned.has(arr[i])) { items.push(arr[i]); w.push(weights[i]); }
  }
  return { items, weights: w };
}

// Card threat rankings by mode (higher = more dangerous to face).
// Used by AI to decide what to ban.
const CARD_THREAT_CLASSIC: Record<string, number> = {
  'haste': 8, 'overwrite': 7, 'sabotage': 6, 'shatter': 6,
  'redirect': 5, 'double-down': 5, 'momentum': 5, 'arsenal': 5,
  'condemn': 4, 'recall': 4, 'swap': 4, 'siege': 3,
};
const CARD_THREAT_SUDDEN_DEATH: Record<string, number> = {
  'haste': 10, 'overwrite': 9, 'double-down': 8, 'sabotage': 7,
  'shatter': 7, 'redirect': 4, 'momentum': 4, 'arsenal': 4,
  'condemn': 3, 'recall': 3, 'swap': 3, 'siege': 2,
};
const CARD_THREAT_MISERE: Record<string, number> = {
  'swap': 9, 'condemn': 7, 'shatter': 7, 'sabotage': 6,
  'overwrite': 5, 'redirect': 5, 'arsenal': 5, 'momentum': 4,
  'recall': 4, 'haste': 3, 'double-down': 3, 'siege': 3,
};
const CARD_THREAT_CONQUEST: Record<string, number> = {
  'shatter': 9, 'haste': 8, 'overwrite': 7, 'sabotage': 7,
  'condemn': 6, 'momentum': 6, 'double-down': 5, 'arsenal': 5,
  'redirect': 4, 'swap': 4, 'recall': 4, 'siege': 3,
};

/** AI picks one card to ban based on game mode and difficulty. */
export function aiBan(
  difficulty: number,
  mode: string,
): PowerUpCard {
  const threats = mode === 'sudden-death' ? CARD_THREAT_SUDDEN_DEATH
    : mode === 'misere' ? CARD_THREAT_MISERE
    : mode === 'conquest' ? CARD_THREAT_CONQUEST
    : CARD_THREAT_CLASSIC;

  const allCards: PowerUpCard[] = [
    ...STRIKE_CARDS, ...TACTICS_CARDS, ...DISRUPTION_CARDS, ...DOCTRINE_CARDS,
  ];

  if (difficulty <= 3) {
    // Easy: random ban
    return allCards[Math.floor(Math.random() * allCards.length)];
  }

  // Medium/Hard: ban the most threatening card (with some randomness for medium)
  const sorted = [...allCards].sort((a, b) => (threats[b] ?? 0) - (threats[a] ?? 0));

  if (difficulty <= 5) {
    // Medium: pick from top 3
    const top = sorted.slice(0, 3);
    return top[Math.floor(Math.random() * top.length)];
  }

  // Hard: always ban the most threatening card
  return sorted[0];
}

/** AI drafts cards, respecting banned cards. */
export function aiDraft(difficulty: number, banned?: Set<string>): PowerUpDraft {
  const b = banned ?? new Set();

  if (difficulty <= 3) {
    const pick = <T extends string>(arr: readonly T[]) => {
      const available = arr.filter(c => !b.has(c));
      return available[Math.floor(Math.random() * available.length)];
    };
    return {
      strike: pick(STRIKE_CARDS),
      tactics: pick(TACTICS_CARDS),
      disruption: pick(DISRUPTION_CARDS),
      doctrine: pick(DOCTRINE_CARDS),
    };
  }

  // Card order: [double-down, haste, overwrite], [redirect, recall, condemn],
  //             [swap, shatter, sabotage], [momentum, siege, arsenal]
  const isHard = difficulty > 5;
  const s = filterBanned(STRIKE_CARDS, isHard ? [1, 3, 4] : [2, 3, 3], b);
  const t = filterBanned(TACTICS_CARDS, isHard ? [4, 2, 2] : [3, 2, 2], b);
  const d = filterBanned(DISRUPTION_CARDS, isHard ? [1, 2, 4] : [2, 2, 3], b);
  const o = filterBanned(DOCTRINE_CARDS, isHard ? [4, 1, 3] : [3, 1, 3], b);
  return {
    strike: weightedPick(s.items, s.weights),
    tactics: weightedPick(t.items, t.weights),
    disruption: weightedPick(d.items, d.weights),
    doctrine: weightedPick(o.items, o.weights),
  };
}

// ---- Card Decision Types ----

export interface AiCardDecision {
  card: ActiveCard;
  boardIdx?: number;
  cellIdx?: number;
  fromBoard?: number;
  fromCell?: number;
  toBoard?: number;
  toCell?: number;
}

// ---- Pre-placement card evaluators ----

function evalOverwrite(
  game: HyperXOGame, aiPlayer: Player, baseScore: number,
): { boardIdx: number; cellIdx: number; improvement: number } | null {
  const opponent: Player = aiPlayer === 'X' ? 'O' : 'X';
  const snap = snapshot(game);
  let best: { boardIdx: number; cellIdx: number; improvement: number } | null = null;

  for (let bi = 0; bi < 9; bi++) {
    const b = game.boards[bi];
    if (b.condemned || b.winner || b.drawn) continue;
    for (let ci = 0; ci < 9; ci++) {
      if (b.cells[ci] !== opponent) continue;
      try {
        applyOverwrite(game, bi, ci);
        const improvement = evaluateForPlayer(game, aiPlayer) - baseScore;
        if (!best || improvement > best.improvement) {
          best = { boardIdx: bi, cellIdx: ci, improvement };
        }
      } catch { /* invalid target */ }
      restore(game, snap);
    }
  }
  return best;
}

function evalSabotage(
  game: HyperXOGame, aiPlayer: Player, baseScore: number,
): { boardIdx: number; cellIdx: number; improvement: number } | null {
  const opponent: Player = aiPlayer === 'X' ? 'O' : 'X';
  const snap = snapshot(game);
  let best: { boardIdx: number; cellIdx: number; improvement: number } | null = null;

  for (let bi = 0; bi < 9; bi++) {
    const b = game.boards[bi];
    if (b.condemned) continue;
    for (let ci = 0; ci < 9; ci++) {
      if (b.cells[ci] !== opponent) continue;
      try {
        applySabotage(game, bi, ci);
        const improvement = evaluateForPlayer(game, aiPlayer) - baseScore;
        if (!best || improvement > best.improvement) {
          best = { boardIdx: bi, cellIdx: ci, improvement };
        }
      } catch { /* invalid */ }
      restore(game, snap);
    }
  }
  return best;
}

function evalRecall(
  game: HyperXOGame, aiPlayer: Player, baseScore: number,
): { fromBoard: number; fromCell: number; toBoard: number; toCell: number; improvement: number } | null {
  const snap = snapshot(game);
  let best: { fromBoard: number; fromCell: number; toBoard: number; toCell: number; improvement: number } | null = null;

  for (let fbi = 0; fbi < 9; fbi++) {
    const fb = game.boards[fbi];
    if (fb.condemned || fb.winner || fb.drawn) continue;
    for (let fci = 0; fci < 9; fci++) {
      if (fb.cells[fci] !== aiPlayer) continue;
      for (let tbi = 0; tbi < 9; tbi++) {
        if (tbi === fbi) continue;
        const tb = game.boards[tbi];
        if (tb.condemned || tb.winner || tb.drawn) continue;
        for (let tci = 0; tci < 9; tci++) {
          if (tb.cells[tci] !== '') continue;
          try {
            applyRecall(game, fbi, fci, tbi, tci);
            const improvement = evaluateForPlayer(game, aiPlayer) - baseScore;
            if (!best || improvement > best.improvement) {
              best = { fromBoard: fbi, fromCell: fci, toBoard: tbi, toCell: tci, improvement };
            }
          } catch { /* invalid */ }
          restore(game, snap);
        }
      }
    }
  }
  return best;
}

function evalSwap(
  game: HyperXOGame, aiPlayer: Player, baseScore: number,
): { boardIdx: number; improvement: number } | null {
  const snap = snapshot(game);
  let best: { boardIdx: number; improvement: number } | null = null;

  for (let bi = 0; bi < 9; bi++) {
    const b = game.boards[bi];
    if (b.condemned || b.winner || b.drawn) continue;
    if (!b.cells.some(c => c !== '')) continue;
    try {
      applySwap(game, bi);
      const improvement = evaluateForPlayer(game, aiPlayer) - baseScore;
      if (!best || improvement > best.improvement) {
        best = { boardIdx: bi, improvement };
      }
    } catch { /* invalid */ }
    restore(game, snap);
  }
  return best;
}

function evalShatter(
  game: HyperXOGame, aiPlayer: Player, baseScore: number,
): { boardIdx: number; improvement: number } | null {
  const snap = snapshot(game);
  let best: { boardIdx: number; improvement: number } | null = null;

  for (let bi = 0; bi < 9; bi++) {
    const b = game.boards[bi];
    if (b.condemned) continue;
    // Never shatter our own won boards
    if (b.winner === aiPlayer) continue;
    if (!b.cells.some(c => c !== '') && !b.winner) continue;
    try {
      applyShatter(game, bi);
      const improvement = evaluateForPlayer(game, aiPlayer) - baseScore;
      if (!best || improvement > best.improvement) {
        best = { boardIdx: bi, improvement };
      }
    } catch { /* invalid */ }
    restore(game, snap);
  }
  return best;
}

function evalCondemn(
  game: HyperXOGame, aiPlayer: Player, baseScore: number,
): { boardIdx: number; improvement: number } | null {
  const snap = snapshot(game);
  let best: { boardIdx: number; improvement: number } | null = null;

  for (let bi = 0; bi < 9; bi++) {
    const b = game.boards[bi];
    if (b.winner || b.drawn || b.condemned) continue;
    try {
      applyCondemn(game, bi);
      const improvement = evaluateForPlayer(game, aiPlayer) - baseScore;
      if (!best || improvement > best.improvement) {
        best = { boardIdx: bi, improvement };
      }
    } catch { /* invalid */ }
    restore(game, snap);
  }
  return best;
}

// ---- Flow modifier evaluators (simulation-based) ----

/**
 * Find the best single move for a player using shallow evaluation.
 * Returns [boardIdx, cellIdx, score] or null if no moves.
 */
function bestMoveShallow(game: HyperXOGame, player: Player): [number, number, number] | null {
  const moves = availableMoves(game);
  if (moves.length === 0) return null;

  let bestMove: [number, number] | null = null;
  let bestScore = -Infinity;
  const snap = snapshot(game);

  for (const [bi, ci] of moves) {
    applyMove(game, bi, ci);
    const score = evaluateForPlayer(game, player);
    if (score > bestScore) {
      bestScore = score;
      bestMove = [bi, ci];
    }
    restore(game, snap);
  }

  return bestMove ? [bestMove[0], bestMove[1], bestScore] : null;
}

/**
 * Double Down: simulate placing two pieces on the same board.
 * Try all valid boards, pick best two cells, measure real improvement.
 */
function evalDoubleDown(game: HyperXOGame, aiPlayer: Player, baseScore: number): number {
  const snap = snapshot(game);
  let bestImprovement = 0;

  for (let bi = 0; bi < 9; bi++) {
    const b = game.boards[bi];
    if (b.condemned || b.winner || b.drawn) continue;
    if (game.nextBoardIndex !== null && game.nextBoardIndex !== bi) continue;

    const emptyCells: number[] = [];
    for (let ci = 0; ci < 9; ci++) {
      if (b.cells[ci] === '') emptyCells.push(ci);
    }
    if (emptyCells.length < 2) continue;

    // Try all pairs of empty cells on this board
    for (let i = 0; i < emptyCells.length; i++) {
      for (let j = i + 1; j < emptyCells.length; j++) {
        const c1 = emptyCells[i], c2 = emptyCells[j];

        // Simulate: place both pieces (manually to avoid player switching)
        game.boards[bi].cells[c1] = aiPlayer;
        game.zkey ^= game.zobrist.pieceKey(bi, c1, aiPlayer);
        game.boards[bi].cells[c2] = aiPlayer;
        game.zkey ^= game.zobrist.pieceKey(bi, c2, aiPlayer);

        // Recalc board state after both placements
        recalcBoard(game.boards[bi]);
        updateGlobalState(game);

        const improvement = evaluateForPlayer(game, aiPlayer) - baseScore;
        bestImprovement = Math.max(bestImprovement, improvement);

        restore(game, snap);
      }
    }
  }

  return bestImprovement;
}

/**
 * Haste: simulate two consecutive best moves, measure total improvement.
 * Uses shallow eval to pick the best move at each step.
 */
function evalHaste(game: HyperXOGame, aiPlayer: Player, baseScore: number): number {
  const snap = snapshot(game);
  let bestImprovement = 0;

  // Find best first move
  const moves1 = availableMoves(game);
  if (moves1.length === 0) return 0;

  // Sample top moves for first placement (limit to avoid O(n^2) explosion)
  // Score each first move, take top 10
  const scored1: { move: [number, number]; score: number }[] = [];
  for (const [bi, ci] of moves1) {
    applyMove(game, bi, ci);
    scored1.push({ move: [bi, ci], score: evaluateForPlayer(game, aiPlayer) });
    restore(game, snap);
  }
  scored1.sort((a, b) => b.score - a.score);
  const top1 = scored1.slice(0, 10);

  for (const { move: m1 } of top1) {
    // Apply first move
    applyMove(game, m1[0], m1[1]);
    if (game.winner || game.drawn) {
      const improvement = evaluateForPlayer(game, aiPlayer) - baseScore;
      bestImprovement = Math.max(bestImprovement, improvement);
      restore(game, snap);
      continue;
    }

    // Undo the player switch (haste keeps the same player)
    game.currentPlayer = aiPlayer;
    game.zkey ^= game.zobrist.stmKey();

    // Find best second move
    const best2 = bestMoveShallow(game, aiPlayer);
    if (best2) {
      const improvement = best2[2] - baseScore;
      bestImprovement = Math.max(bestImprovement, improvement);
    }

    restore(game, snap);
  }

  return bestImprovement;
}

/**
 * Redirect: measure how much control we gain by choosing opponent's next board.
 * Value = (opponent's score on worst board) - (opponent's score on best board).
 * Higher spread = redirect is more valuable.
 */
function evalRedirect(game: HyperXOGame, aiPlayer: Player, _baseScore: number): number {
  const opponent: Player = aiPlayer === 'X' ? 'O' : 'X';
  const snap = snapshot(game);

  // Evaluate opponent's best move value when directed to each board
  const boardValues: number[] = [];

  for (let bi = 0; bi < 9; bi++) {
    const b = game.boards[bi];
    if (b.winner || b.drawn || b.condemned) continue;
    if (!b.cells.some(c => c === '')) continue;

    // Simulate: opponent is forced to this board
    game.zkey ^= game.zobrist.nbiKey(game.nextBoardIndex);
    game.nextBoardIndex = bi;
    game.zkey ^= game.zobrist.nbiKey(bi);
    // Pretend it's opponent's turn
    game.currentPlayer = opponent;
    game.zkey ^= game.zobrist.stmKey();

    const best = bestMoveShallow(game, opponent);
    // Opponent's best score on this board (from opponent's view)
    boardValues.push(best ? best[2] : 0);

    restore(game, snap);
  }

  if (boardValues.length < 2) return 0;

  // The value of redirect: difference between the worst and best board for opponent
  // (we'd send them to the worst, they'd naturally go to the best)
  const worstForOpponent = Math.min(...boardValues);
  const bestForOpponent = Math.max(...boardValues);
  const spread = bestForOpponent - worstForOpponent;

  // Convert to AI improvement: opponent being on their worst board vs natural
  // is worth roughly half the spread (since natural direction is random-ish, not always best)
  return spread * 0.5;
}

// ---- Main card decision function ----

const PRE_PLACEMENT_CARDS = new Set<ActiveCard>([
  'overwrite', 'sabotage', 'recall', 'swap', 'shatter', 'condemn',
]);

export function isPrePlacementCard(card: ActiveCard): boolean {
  return PRE_PLACEMENT_CARDS.has(card);
}

// ---- Urgency system ----

interface UrgencyContext {
  /** Multiplier for card values (1.0 = neutral, higher = more urgent to act) */
  multiplier: number;
  /** Macro lines where opponent is 1 board from winning */
  opponentMacroThreats: number;
  /** Macro lines where AI is 1 board from winning */
  aiMacroThreats: number;
  /** Fraction of boards decided (0.0 to 1.0) */
  gameProgress: number;
  /** How many active cards the AI still has */
  cardsRemaining: number;
}

export function computeUrgency(
  game: HyperXOGame,
  puState: PowerUpState,
  aiPlayer: Player,
): UrgencyContext {
  const opponent: Player = aiPlayer === 'X' ? 'O' : 'X';
  const bb = bigBoardState(game);

  let opponentMacroThreats = 0;
  let aiMacroThreats = 0;

  // Conquest mode uses score-based urgency instead of macro line threats
  if (game.mode === 'conquest') {
    const scores = computeConquestScores(game);
    const bonusSet = new Set(game.conquestBonusBoards);
    let remainingPoints = 0;
    for (let i = 0; i < 9; i++) {
      const b = game.boards[i];
      if (!b.winner && !b.drawn && !b.condemned) remainingPoints += bonusSet.has(i) ? 2 : 1;
    }
    const decidedBoards = bb.filter(b => b !== '.').length;
    const gameProgress = decidedBoards / 9;
    const cardsRemaining = getAvailableCards(puState).length;

    let multiplier = 1.0;
    const myScore = scores[aiPlayer];
    const oppScore = scores[opponent];

    // Score pressure: opponent is ahead → urgent
    if (oppScore > myScore + 2) multiplier *= 2.5;
    else if (oppScore > myScore) multiplier *= 1.8;

    // Score opportunity: we're ahead → press advantage
    if (myScore > oppScore + 2) multiplier *= 1.8;
    else if (myScore > oppScore) multiplier *= 1.3;

    // Approaching early termination: remaining points shrinking
    if (remainingPoints <= 3) multiplier *= 1.5;

    multiplier *= 1.0 + gameProgress * 1.5;
    if (cardsRemaining === 1) multiplier *= 0.8;

    return { multiplier, opponentMacroThreats: 0, aiMacroThreats: 0, gameProgress, cardsRemaining };
  }

  for (const [a, b, c] of WINNING_LINES) {
    const marks = [bb[a], bb[b], bb[c]];
    const aiCount = marks.filter(m => m === aiPlayer).length;
    const oppCount = marks.filter(m => m === opponent).length;
    const openCount = marks.filter(m => m === '.').length;

    // Opponent needs 1 more board to win the game
    if (oppCount === 2 && openCount === 1) opponentMacroThreats++;
    // AI needs 1 more board to win the game
    if (aiCount === 2 && openCount === 1) aiMacroThreats++;
  }

  // Game progress: how many boards are decided (won, drawn, condemned)
  const decidedBoards = bb.filter(b => b !== '.').length;
  const gameProgress = decidedBoards / 9;

  const cardsRemaining = getAvailableCards(puState).length;

  // --- Compute multiplier ---
  let multiplier = 1.0;

  // Macro danger: opponent is close to winning → cards become critical
  // Each threat independently boosts urgency (multiple threats = dire situation)
  if (opponentMacroThreats >= 2) multiplier *= 3.5;     // two ways to win = desperate
  else if (opponentMacroThreats === 1) multiplier *= 2.5; // one threat = serious

  // Macro opportunity: AI is close to winning → cards can seal the game
  if (aiMacroThreats >= 2) multiplier *= 2.5;
  else if (aiMacroThreats === 1) multiplier *= 1.8;

  // Late-game scarcity: don't die with cards in hand
  // Ramps up gently: 1.0 at 0% → 1.5 at 50% → 2.0 at 78% → 2.5 at 100%
  multiplier *= 1.0 + gameProgress * 1.5;

  // Last card conservatism: slight penalty when it's your only bullet
  // (this is a soft counter to the late-game ramp — preserves the last card
  //  unless urgency is genuinely high)
  if (cardsRemaining === 1) multiplier *= 0.8;

  return { multiplier, opponentMacroThreats, aiMacroThreats, gameProgress, cardsRemaining };
}

// ---- Card-specific urgency bonuses ----

/** Extra multiplier for cards that directly interact with a contested macro line. */
function cardContextBonus(
  game: HyperXOGame,
  decision: AiCardDecision,
  aiPlayer: Player,
): number {
  // Conquest: macro lines are irrelevant; bonus for targeting high-value boards
  if (game.mode === 'conquest') {
    const targetBoard = decision.boardIdx ?? decision.toBoard;
    if (targetBoard === undefined) return 1.0;
    return new Set(game.conquestBonusBoards).has(targetBoard) ? 1.5 : 1.0;
  }

  const opponent: Player = aiPlayer === 'X' ? 'O' : 'X';
  const bb = bigBoardState(game);

  // Which board does this card primarily affect?
  const targetBoard = decision.boardIdx ?? decision.toBoard;
  if (targetBoard === undefined) return 1.0; // flow modifiers get no extra bonus

  // Check if the target board is on a live macro line
  let onAiMacroLine = false;
  let onOpponentMacroLine = false;
  for (const [a, b, c] of WINNING_LINES) {
    if (a !== targetBoard && b !== targetBoard && c !== targetBoard) continue;
    const marks = [bb[a], bb[b], bb[c]];
    const aiCount = marks.filter(m => m === aiPlayer).length;
    const oppCount = marks.filter(m => m === opponent).length;
    const openCount = marks.filter(m => m === '.').length;

    if (oppCount >= 1 && openCount >= 1 && aiCount === 0) onOpponentMacroLine = true;
    if (aiCount >= 1 && openCount >= 1 && oppCount === 0) onAiMacroLine = true;
    // Especially: board is the missing piece for a 2-in-a-row macro line
    if (oppCount === 2 && openCount === 1 && bb[targetBoard] === '.') onOpponentMacroLine = true;
    if (aiCount === 2 && openCount === 1 && bb[targetBoard] === '.') onAiMacroLine = true;
  }

  let bonus = 1.0;
  if (onOpponentMacroLine) bonus *= 1.5; // disrupting opponent's macro path
  if (onAiMacroLine) bonus *= 1.3;       // advancing AI's macro path
  return bonus;
}

// ---- Decision function ----

export function aiDecideCard(
  game: HyperXOGame,
  puState: PowerUpState,
  aiPlayer: Player,
  difficulty: number,
): AiCardDecision | null {
  const available = getAvailableCards(puState);
  if (available.length === 0 || game.winner || game.drawn) return null;

  // Easy AI: 60% of turns doesn't even consider cards (impulsive but inattentive)
  if (difficulty <= 3 && Math.random() > 0.40) return null;

  const urgency = computeUrgency(game, puState, aiPlayer);
  const baseScore = evaluateForPlayer(game, aiPlayer);

  // Base thresholds: INVERTED from intuition
  // Easy = low threshold (impulsive, uses cards on small advantages → wastes them)
  // Hard = high threshold (patient, needs high adjusted value → saves for critical moments)
  const baseThreshold = difficulty <= 3 ? 12 : difficulty <= 5 ? 25 : 45;

  let bestDecision: AiCardDecision | null = null;
  let bestAdjustedValue = baseThreshold;

  for (const card of available) {
    let rawValue = 0;
    let decision: AiCardDecision | null = null;

    switch (card) {
      case 'overwrite': {
        const r = evalOverwrite(game, aiPlayer, baseScore);
        if (r) { rawValue = r.improvement; decision = { card, boardIdx: r.boardIdx, cellIdx: r.cellIdx }; }
        break;
      }
      case 'sabotage': {
        const r = evalSabotage(game, aiPlayer, baseScore);
        if (r) { rawValue = r.improvement; decision = { card, boardIdx: r.boardIdx, cellIdx: r.cellIdx }; }
        break;
      }
      case 'recall': {
        const r = evalRecall(game, aiPlayer, baseScore);
        if (r) { rawValue = r.improvement; decision = { card, fromBoard: r.fromBoard, fromCell: r.fromCell, toBoard: r.toBoard, toCell: r.toCell }; }
        break;
      }
      case 'swap': {
        const r = evalSwap(game, aiPlayer, baseScore);
        if (r) { rawValue = r.improvement; decision = { card, boardIdx: r.boardIdx }; }
        break;
      }
      case 'shatter': {
        const r = evalShatter(game, aiPlayer, baseScore);
        if (r) { rawValue = r.improvement; decision = { card, boardIdx: r.boardIdx }; }
        break;
      }
      case 'condemn': {
        const r = evalCondemn(game, aiPlayer, baseScore);
        if (r) { rawValue = r.improvement; decision = { card, boardIdx: r.boardIdx }; }
        break;
      }
      case 'double-down': {
        rawValue = evalDoubleDown(game, aiPlayer, baseScore);
        if (rawValue > 0) decision = { card };
        break;
      }
      case 'haste': {
        rawValue = evalHaste(game, aiPlayer, baseScore);
        if (rawValue > 0) decision = { card };
        break;
      }
      case 'redirect': {
        rawValue = evalRedirect(game, aiPlayer, baseScore);
        if (rawValue > 0) decision = { card };
        break;
      }
    }

    if (!decision || rawValue <= 0) continue;

    // Apply urgency multiplier + card-specific context bonus
    const contextBonus = cardContextBonus(game, decision, aiPlayer);
    const adjustedValue = rawValue * urgency.multiplier * contextBonus;

    if (adjustedValue > bestAdjustedValue) {
      bestAdjustedValue = adjustedValue;
      bestDecision = decision;
    }
  }

  // Deep verify: for medium/hard AI with a pre-placement candidate,
  // verify with a reduced-depth minimax search to catch multi-ply consequences.
  // Capped at depth 4 to stay under ~500ms.
  if (bestDecision && difficulty > 3 && isPrePlacementCard(bestDecision.card)) {
    const verifyDepth = Math.min(Math.max(1, difficulty - 2), 4);
    if (!deepVerifyCard(game, bestDecision, aiPlayer, verifyDepth)) {
      return null; // heuristic liked it but search says it's not worth it
    }
  }

  return bestDecision;
}

/**
 * Verify a card decision with a reduced-depth minimax search.
 * Compares: (card + best follow-up move) vs (best move without card).
 * Returns true if using the card leads to a better position.
 */
function deepVerifyCard(
  game: HyperXOGame,
  decision: AiCardDecision,
  aiPlayer: Player,
  verifyDepth: number,
): boolean {
  const snap = snapshot(game);

  // Score WITHOUT card: minimax picks best move, evaluate after it
  const baseAi = createAI(aiPlayer, verifyDepth);
  const baseMove = choose(baseAi, game);
  const baseUndo = captureUndo(game, baseMove[0]);
  applyMove(game, baseMove[0], baseMove[1]);
  const baseScore = evaluateForPlayer(game, aiPlayer);
  undoMove(game, baseMove[0], baseMove[1], baseUndo);

  // Score WITH card: apply card, then minimax picks best follow-up move
  applyAiPreCard(game, decision);
  if (game.winner || game.drawn) {
    const cardScore = evaluateForPlayer(game, aiPlayer);
    restore(game, snap);
    return cardScore > baseScore;
  }
  const cardAi = createAI(aiPlayer, verifyDepth);
  const cardMove = choose(cardAi, game);
  const cardUndo = captureUndo(game, cardMove[0]);
  applyMove(game, cardMove[0], cardMove[1]);
  const cardScore = evaluateForPlayer(game, aiPlayer);
  undoMove(game, cardMove[0], cardMove[1], cardUndo);

  restore(game, snap);

  return cardScore > baseScore;
}

// ---- Auto-pick helpers ----

/** Pick the board to redirect opponent to (worst for opponent). */
export function aiRedirectTarget(game: HyperXOGame, aiPlayer: Player): number {
  const opponent: Player = aiPlayer === 'X' ? 'O' : 'X';
  let bestBoard = -1;
  let bestScore = -Infinity;

  for (let bi = 0; bi < 9; bi++) {
    const b = game.boards[bi];
    if (b.winner || b.drawn || b.condemned) continue;

    let score = 0;
    for (const [a, bc, c] of WINNING_LINES) {
      const trio = [b.cells[a], b.cells[bc], b.cells[c]];
      const aiCount = trio.filter(t => t === aiPlayer).length;
      const oppCount = trio.filter(t => t === opponent).length;
      const emptyCount = trio.filter(t => t === '').length;
      // AI 2-in-a-row: opponent must block
      if (aiCount === 2 && emptyCount === 1) score += 100;
      if (aiCount > 0 && oppCount === 0) score += 10;
      if (oppCount > 0 && aiCount === 0) score -= 20;
    }
    // Fewer empty cells = fewer options
    score += (9 - b.cells.filter(c => c === '').length) * 5;

    if (score > bestScore) {
      bestScore = score;
      bestBoard = bi;
    }
  }
  return bestBoard;
}

/** Apply pre-placement card effect to the game. */
export function applyAiPreCard(game: HyperXOGame, decision: AiCardDecision): void {
  switch (decision.card) {
    case 'overwrite':
      applyOverwrite(game, decision.boardIdx!, decision.cellIdx!);
      break;
    case 'sabotage':
      applySabotage(game, decision.boardIdx!, decision.cellIdx!);
      break;
    case 'recall':
      applyRecall(game, decision.fromBoard!, decision.fromCell!, decision.toBoard!, decision.toCell!);
      break;
    case 'swap':
      applySwap(game, decision.boardIdx!);
      break;
    case 'shatter':
      applyShatter(game, decision.boardIdx!);
      break;
    case 'condemn':
      applyCondemn(game, decision.boardIdx!);
      break;
  }
}

/** Get affected board indices for flash effects. */
export function getCardFlashBoards(decision: AiCardDecision): number[] {
  switch (decision.card) {
    case 'overwrite':
    case 'sabotage':
    case 'swap':
    case 'shatter':
    case 'condemn':
      return [decision.boardIdx!];
    case 'recall':
      return [decision.fromBoard!, decision.toBoard!];
    default:
      return [];
  }
}

/** Get flash color for a card effect. */
export function getCardFlashColor(card: ActiveCard): string {
  return CARD_FLASH_COLORS[card] ?? 'indigo';
}
