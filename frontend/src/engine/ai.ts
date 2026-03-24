import {
  type HyperXOGame,
  type Player,
  type Cell,
  WINNING_LINES,
  availableMoves,
  applyMove,
  undoMove,
  captureUndo,
  bigBoardState,
  computeConquestScores,
} from './game';

// TT entry flags
const EXACT = 0, LOWER = 1, UPPER = 2;

const TT_MAX_SIZE = 600_000;

interface TTEntry {
  depth: number;
  score: number;
  flag: number;
  bestMove: [number, number] | null;
}

/** Card context for card-aware evaluation. */
export interface CardContext {
  /** AI's remaining unused active cards */
  myCards: string[];
  /** Opponent's remaining unused active cards */
  opponentCards: string[];
}

export interface MinimaxAI {
  player: Player;
  depth: number;
  blunderRate: number;
  tt: Map<number, TTEntry>;
  cardCtx: CardContext | null;
}

export function createAI(player: Player, depth: number, blunderRate = 0): MinimaxAI {
  return { player, depth, blunderRate, tt: new Map(), cardCtx: null };
}

// Difficulty presets: [depth, blunderRate]
export const DIFFICULTY_PRESETS: Record<number, { depth: number; blunderRate: number }> = {
  3: { depth: 3, blunderRate: 0.35 },
  5: { depth: 5, blunderRate: 0.10 },
  8: { depth: 8, blunderRate: 0.0 },
};

export function choose(ai: MinimaxAI, game: HyperXOGame): [number, number] {
  if (game.currentPlayer !== ai.player) {
    throw new Error("It is not this AI player's turn");
  }

  const moves = availableMoves(game);
  if (moves.length === 0) throw new Error('No valid moves available');

  // Blunder: occasionally pick a random move
  if (ai.blunderRate > 0 && Math.random() < ai.blunderRate) {
    return moves[Math.floor(Math.random() * moves.length)];
  }

  // Cap TT
  if (ai.tt.size > TT_MAX_SIZE) ai.tt.clear();

  let bestMove: [number, number] | null = null;
  let prevScore = 0;
  const ASPIRATION_MARGIN = 50;

  for (let d = 1; d <= Math.max(1, ai.depth); d++) {
    const alpha = prevScore - ASPIRATION_MARGIN;
    const beta = prevScore + ASPIRATION_MARGIN;
    let [score, move] = minimax(ai, game, d, d, alpha, beta, true);

    if (score <= alpha || score >= beta) {
      [score, move] = minimax(ai, game, d, d, -Infinity, Infinity, true);
    }

    if (move !== null) bestMove = move;
    prevScore = score;
  }

  return bestMove ?? moves[0];
}

function movesEqual(a: [number, number] | null, b: [number, number]): boolean {
  return a !== null && a[0] === b[0] && a[1] === b[1];
}

function minimax(
  ai: MinimaxAI,
  game: HyperXOGame,
  depth: number,
  maxDepth: number,
  alpha: number,
  beta: number,
  maximizing: boolean,
): [number, [number, number] | null] {
  // Terminal / leaf
  if (game.winner || game.drawn) return [evaluateTerminal(ai, game, depth), null];
  if (depth === 0) return [evaluate(ai, game), null];

  const key = game.zkey;

  // TT probe
  const ttHit = ai.tt.get(key);
  if (ttHit && ttHit.depth >= depth) {
    if (ttHit.flag === EXACT) return [ttHit.score, ttHit.bestMove];
    if (ttHit.flag === LOWER) alpha = Math.max(alpha, ttHit.score);
    else if (ttHit.flag === UPPER) beta = Math.min(beta, ttHit.score);
    if (alpha >= beta) return [ttHit.score, ttHit.bestMove];
  }

  // Move ordering
  const moves = availableMoves(game);
  const current = game.currentPlayer;
  const opponent: Player = current === 'X' ? 'O' : 'X';

  let pv: [number, number] | null = null;
  if (ttHit?.bestMove) {
    const pvIdx = moves.findIndex(m => movesEqual(ttHit.bestMove, m));
    if (pvIdx >= 0) {
      pv = moves[pvIdx];
      moves.splice(pvIdx, 1);
    }
  }

  moves.sort((a, b) => moveHeuristic(game, b, current, opponent) - moveHeuristic(game, a, current, opponent));

  if (pv !== null) moves.unshift(pv);

  let bestMove: [number, number] | null = null;
  const origAlpha = alpha;

  if (maximizing) {
    let value = -Infinity;
    for (const move of moves) {
      const [bi, ci] = move;
      const undo = captureUndo(game, bi);

      applyMove(game, bi, ci);
      const [score] = minimax(ai, game, depth - 1, maxDepth, alpha, beta, false);
      undoMove(game, bi, ci, undo);

      if (score > value) { value = score; bestMove = move; }
      alpha = Math.max(alpha, value);
      if (alpha >= beta) break;
    }
    const flag = value >= beta ? LOWER : value <= origAlpha ? UPPER : EXACT;
    ai.tt.set(key, { depth, score: value, flag, bestMove });
    return [value, bestMove];
  } else {
    let value = Infinity;
    for (const move of moves) {
      const [bi, ci] = move;
      const undo = captureUndo(game, bi);

      applyMove(game, bi, ci);
      const [score] = minimax(ai, game, depth - 1, maxDepth, alpha, beta, true);
      undoMove(game, bi, ci, undo);

      if (score < value) { value = score; bestMove = move; }
      beta = Math.min(beta, value);
      if (alpha >= beta) break;
    }
    const flag = value <= origAlpha ? UPPER : value >= beta ? LOWER : EXACT;
    ai.tt.set(key, { depth, score: value, flag, bestMove });
    return [value, bestMove];
  }
}

// ---- Heuristics ----

function isWinningMoveLocal(cells: Cell[], player: Player, cell: number): boolean {
  if (cells[cell] !== '') return false;
  for (const [a, b, c] of WINNING_LINES) {
    if (cell !== a && cell !== b && cell !== c) continue;
    const trio = [cells[a], cells[b], cells[c]];
    if (trio.filter(t => t === player).length === 2 && trio.filter(t => t === '').length === 1) return true;
  }
  return false;
}

function twoInARowThreats(cells: Cell[], player: Player): number {
  let cnt = 0;
  for (const [a, b, c] of WINNING_LINES) {
    const trio = [cells[a], cells[b], cells[c]];
    if (trio.filter(t => t === player).length === 2 && trio.filter(t => t === '').length === 1) cnt++;
  }
  return cnt;
}

const CORNERS = new Set([0, 2, 6, 8]);

function moveHeuristic(game: HyperXOGame, move: [number, number], current: Player, opponent: Player): number {
  const [i, j] = move;
  const board = game.boards[i];

  if (isWinningMoveLocal(board.cells, current, j)) return 1000;
  if (isWinningMoveLocal(board.cells, opponent, j)) return 900;

  let score = 0;

  const tgt = game.boards[j];
  if (tgt.winner === current) score += 6;
  else if (tgt.winner === opponent) score -= 6;
  else if (tgt.drawn || tgt.cells.every(c => c !== '')) score -= 3;
  else {
    score += 1.5 * twoInARowThreats(tgt.cells, current) - twoInARowThreats(tgt.cells, opponent);
  }

  score += j === 4 ? 0.4 : CORNERS.has(j) ? 0.2 : 0.1;
  return score;
}

/** Evaluate a position from a given player's perspective (no search, just heuristic). */
export function evaluateForPlayer(game: HyperXOGame, player: Player, cardCtx?: CardContext | null): number {
  if (game.winner === player) return 10000;
  if (game.winner !== null) return -10000;
  if (game.drawn) return 0;
  const tempAi: MinimaxAI = { player, depth: 0, blunderRate: 0, tt: new Map(), cardCtx: cardCtx ?? null };
  return evaluate(tempAi, game);
}

function evaluateTerminal(ai: MinimaxAI, game: HyperXOGame, remainingDepth: number): number {
  if (game.winner === ai.player) return 10000 + remainingDepth;
  if (game.winner !== null) return -10000 - remainingDepth;
  return 0;
}

function evaluate(ai: MinimaxAI, game: HyperXOGame): number {
  switch (game.mode) {
    case 'sudden-death': return evaluateSuddenDeath(ai, game);
    case 'misere': return evaluateMisere(ai, game);
    case 'conquest': return evaluateConquest(ai, game);
    default: return evaluateClassic(ai, game);
  }
}

function evaluateClassic(ai: MinimaxAI, game: HyperXOGame): number {
  const me = ai.player;
  const opp: Player = me === 'X' ? 'O' : 'X';
  const ctx = ai.cardCtx;

  let score = 0;

  // Macro line potential
  const bb = bigBoardState(game);
  for (const [a, b, c] of WINNING_LINES) {
    const marks = [bb[a], bb[b], bb[c]];
    if (marks.includes('G')) continue;
    const m = marks.filter(x => x === me).length;
    const o = marks.filter(x => x === opp).length;
    if (m && o) continue;
    if (m) score += 4 ** m;
    if (o) score -= 4 ** o;
  }

  // Macro geometry
  if (bb[4] === me) score += 0.6;
  else if (bb[4] === opp) score -= 0.6;
  for (const k of [0, 2, 6, 8]) {
    if (bb[k] === me) score += 0.3;
    else if (bb[k] === opp) score -= 0.3;
  }

  // Micro-board detail
  for (let bi = 0; bi < 9; bi++) {
    const board = game.boards[bi];
    if (board.winner === me) { score += 40; continue; }
    if (board.winner === opp) { score -= 40; continue; }
    if (board.drawn) continue;

    for (const [a, b, c] of WINNING_LINES) {
      const trio = [board.cells[a], board.cells[b], board.cells[c]];
      if (!trio.includes(opp)) {
        const cnt = trio.filter(t => t === me).length;
        if (cnt === 1) score += 1;
        else if (cnt === 2) score += 5;
      }
      if (!trio.includes(me)) {
        const cnt = trio.filter(t => t === opp).length;
        if (cnt === 1) score -= 1;
        else if (cnt === 2) score -= 5;
      }
    }

    if (board.cells[4] === me) score += 0.3;
    else if (board.cells[4] === opp) score -= 0.3;
  }

  // ---- Card-aware adjustments ----
  if (ctx) score += cardAdjustments(game, bb, me, opp, ctx);

  return score;
}

/**
 * Adjust evaluation based on both players' remaining cards.
 * Positive = favors `me`, negative = favors `opp`.
 */
function cardAdjustments(
  game: HyperXOGame,
  bb: string[],
  me: Player,
  opp: Player,
  ctx: CardContext,
): number {
  const { myCards, opponentCards } = ctx;
  let adj = 0;

  // --- Opponent card threats ---

  // Opponent has shatter → our won boards are fragile (could be revoked)
  if (opponentCards.includes('shatter')) {
    for (const board of game.boards) {
      if (board.winner === me) adj -= 8;  // discount won boards (40 → effectively 32)
      if (board.winner === opp) adj += 5; // their won boards are also fragile (we could shatter too)
    }
  }

  // Opponent has overwrite → our single-piece blocks are unreliable
  if (opponentCards.includes('overwrite')) {
    for (const board of game.boards) {
      if (board.winner || board.drawn || board.condemned) continue;
      for (const [a, b, c] of WINNING_LINES) {
        const trio = [board.cells[a], board.cells[b], board.cells[c]];
        const oppCount = trio.filter(t => t === opp).length;
        const meCount = trio.filter(t => t === me).length;
        // Opponent has 2-in-a-row blocked by our single piece → block is unreliable
        if (oppCount === 2 && meCount === 1) adj -= 3;
      }
    }
  }

  // Opponent has sabotage → our won boards with thin wins are fragile
  if (opponentCards.includes('sabotage')) {
    for (const board of game.boards) {
      if (board.winner !== me) continue;
      // Count winning lines — if only one winning line, sabotage can break it
      let winningLines = 0;
      for (const [a, b, c] of WINNING_LINES) {
        const trio = [board.cells[a], board.cells[b], board.cells[c]];
        if (trio.every(t => t === me)) winningLines++;
      }
      if (winningLines === 1) adj -= 5; // single winning line = fragile
    }
  }

  // Opponent has condemn → boards that are sole links in our macro lines are vulnerable
  if (opponentCards.includes('condemn')) {
    for (const [a, b, c] of WINNING_LINES) {
      const marks = [bb[a], bb[b], bb[c]];
      const myCount = marks.filter(m => m === me).length;
      const openCount = marks.filter(m => m === '.').length;
      // We have 2 on this macro line, 1 open → opponent could condemn the open one
      if (myCount === 2 && openCount === 1) adj -= 4;
    }
  }

  // Opponent has swap → boards where we dominate could be flipped
  if (opponentCards.includes('swap')) {
    for (const board of game.boards) {
      if (board.winner || board.drawn || board.condemned) continue;
      const myPieces = board.cells.filter(c => c === me).length;
      const oppPieces = board.cells.filter(c => c === opp).length;
      // We have significantly more pieces → vulnerable to swap
      if (myPieces >= oppPieces + 2) adj -= 3;
    }
  }

  // Opponent has haste → their 2-in-a-row threats are more dangerous
  if (opponentCards.includes('haste')) {
    for (const board of game.boards) {
      if (board.winner || board.drawn || board.condemned) continue;
      for (const [a, b, c] of WINNING_LINES) {
        const trio = [board.cells[a], board.cells[b], board.cells[c]];
        if (trio.filter(t => t === opp).length === 2 && trio.filter(t => t === '').length === 1) {
          adj -= 2; // each opponent threat is scarier with haste
        }
      }
    }
  }

  // Opponent has redirect → our board direction control is less reliable
  if (opponentCards.includes('redirect')) {
    adj -= 2; // small flat penalty for reduced positional control
  }

  // --- Our card potential ---

  // We have overwrite → opponent's single-piece blocks are less of a problem
  if (myCards.includes('overwrite')) {
    for (const board of game.boards) {
      if (board.winner || board.drawn || board.condemned) continue;
      for (const [a, b, c] of WINNING_LINES) {
        const trio = [board.cells[a], board.cells[b], board.cells[c]];
        const meCount = trio.filter(t => t === me).length;
        const oppCount = trio.filter(t => t === opp).length;
        // We have 2-in-a-row blocked by single opponent piece → we can remove it
        if (meCount === 2 && oppCount === 1) adj += 3;
      }
    }
  }

  // We have shatter → opponent's won boards are less permanent
  if (myCards.includes('shatter')) {
    for (const board of game.boards) {
      if (board.winner === opp) adj += 5;
    }
  }

  // We have sabotage → opponent's thin wins are vulnerable
  if (myCards.includes('sabotage')) {
    for (const board of game.boards) {
      if (board.winner !== opp) continue;
      let winningLines = 0;
      for (const [a, b, c] of WINNING_LINES) {
        const trio = [board.cells[a], board.cells[b], board.cells[c]];
        if (trio.every(t => t === opp)) winningLines++;
      }
      if (winningLines === 1) adj += 4;
    }
  }

  // We have haste → our threats are more potent
  if (myCards.includes('haste')) {
    for (const board of game.boards) {
      if (board.winner || board.drawn || board.condemned) continue;
      for (const [a, b, c] of WINNING_LINES) {
        const trio = [board.cells[a], board.cells[b], board.cells[c]];
        if (trio.filter(t => t === me).length === 2 && trio.filter(t => t === '').length === 1) {
          adj += 2;
        }
      }
    }
  }

  // Opponent has gravity → board rearrangement threat
  if (opponentCards.includes('gravity')) adj -= 3;
  // We have gravity → potential to create winning lines
  if (myCards.includes('gravity')) adj += 2;

  return adj;
}

function evaluateSuddenDeath(ai: MinimaxAI, game: HyperXOGame): number {
  const me = ai.player;
  const opp: Player = me === 'X' ? 'O' : 'X';
  const ctx = ai.cardCtx;
  let score = 0;

  // Only micro-board threats matter — any board win ends the game
  for (const board of game.boards) {
    if (board.drawn) continue;

    for (const [a, b, c] of WINNING_LINES) {
      const trio = [board.cells[a], board.cells[b], board.cells[c]];
      if (!trio.includes(opp)) {
        const cnt = trio.filter(t => t === me).length;
        if (cnt === 1) score += 2;
        else if (cnt === 2) score += 15;
      }
      if (!trio.includes(me)) {
        const cnt = trio.filter(t => t === opp).length;
        if (cnt === 1) score -= 2;
        else if (cnt === 2) score -= 15;
      }
    }

    if (board.cells[4] === me) score += 0.5;
    else if (board.cells[4] === opp) score -= 0.5;
  }

  if (ctx) score += cardAdjustmentsSuddenDeath(game, me, opp, ctx);

  return score;
}

/** Card adjustments for sudden death — any board win = game over. */
function cardAdjustmentsSuddenDeath(
  game: HyperXOGame,
  me: Player,
  opp: Player,
  ctx: CardContext,
): number {
  const { myCards, opponentCards } = ctx;
  let adj = 0;

  // Opponent has haste → any opponent 2-in-a-row = near-certain death.
  // In sudden death, haste + one threat = game-winning. Massive danger.
  if (opponentCards.includes('haste')) {
    for (const board of game.boards) {
      if (board.winner || board.drawn || board.condemned) continue;
      for (const [a, b, c] of WINNING_LINES) {
        const trio = [board.cells[a], board.cells[b], board.cells[c]];
        if (trio.filter(t => t === opp).length === 2 && trio.filter(t => t === '').length === 1) {
          adj -= 12; // each opponent threat is near-lethal with haste
        }
      }
    }
  }

  // Opponent has overwrite → our blocked threats don't protect us
  if (opponentCards.includes('overwrite')) {
    for (const board of game.boards) {
      if (board.winner || board.drawn || board.condemned) continue;
      for (const [a, b, c] of WINNING_LINES) {
        const trio = [board.cells[a], board.cells[b], board.cells[c]];
        if (trio.filter(t => t === opp).length === 2 && trio.filter(t => t === me).length === 1) {
          adj -= 8; // our block is removable → threat is almost as bad as open
        }
      }
    }
  }

  // Opponent has gravity → board rearrangement could create winning lines
  if (opponentCards.includes('gravity')) {
    adj -= 5; // general threat: unpredictable board reshuffling
  }

  // Opponent has shatter/sabotage → if we've won a board (game should be over,
  // but with passives the game might continue) these are less relevant in SD.
  // Shatter is mainly defensive in SD (revoke our game-winning board).

  // We have haste → our threats are near-guaranteed wins
  if (myCards.includes('haste')) {
    for (const board of game.boards) {
      if (board.winner || board.drawn || board.condemned) continue;
      for (const [a, b, c] of WINNING_LINES) {
        const trio = [board.cells[a], board.cells[b], board.cells[c]];
        if (trio.filter(t => t === me).length === 2 && trio.filter(t => t === '').length === 1) {
          adj += 10; // each of our threats is near-lethal with haste
        }
      }
    }
  }

  // We have overwrite → blocked 2-in-a-rows are still completable = near-wins
  if (myCards.includes('overwrite')) {
    for (const board of game.boards) {
      if (board.winner || board.drawn || board.condemned) continue;
      for (const [a, b, c] of WINNING_LINES) {
        const trio = [board.cells[a], board.cells[b], board.cells[c]];
        if (trio.filter(t => t === me).length === 2 && trio.filter(t => t === opp).length === 1) {
          adj += 8; // we can remove blocker → near-guaranteed board win → game win
        }
      }
    }
  }

  // We have shatter/sabotage → can revoke opponent's game-winning board
  if (myCards.includes('shatter') || myCards.includes('sabotage')) {
    // Provides a safety net — slightly less panic about opponent winning
    adj += 5;
  }

  return adj;
}

function evaluateMisere(ai: MinimaxAI, game: HyperXOGame): number {
  const me = ai.player;
  const opp: Player = me === 'X' ? 'O' : 'X';
  const ctx = ai.cardCtx;
  let score = 0;

  // Macro line potential: INVERTED (your lines = danger)
  const bb = bigBoardState(game);
  for (const [a, b, c] of WINNING_LINES) {
    const marks = [bb[a], bb[b], bb[c]];
    if (marks.includes('G')) continue;
    const m = marks.filter(x => x === me).length;
    const o = marks.filter(x => x === opp).length;
    if (m && o) continue;
    if (m) score -= 4 ** m;
    if (o) score += 4 ** o;
  }

  // Macro geometry: inverted
  if (bb[4] === me) score -= 0.6;
  else if (bb[4] === opp) score += 0.6;
  for (const k of [0, 2, 6, 8]) {
    if (bb[k] === me) score -= 0.3;
    else if (bb[k] === opp) score += 0.3;
  }

  // Won boards: slightly negative (more boards = more macro risk)
  for (const board of game.boards) {
    if (board.winner === me) { score -= 8; continue; }
    if (board.winner === opp) { score += 8; continue; }
    if (board.drawn) continue;

    // Micro threats: same direction (tactical board play still matters)
    for (const [a, b, c] of WINNING_LINES) {
      const trio = [board.cells[a], board.cells[b], board.cells[c]];
      if (!trio.includes(opp)) {
        const cnt = trio.filter(t => t === me).length;
        if (cnt === 1) score += 1;
        else if (cnt === 2) score += 3;
      }
      if (!trio.includes(me)) {
        const cnt = trio.filter(t => t === opp).length;
        if (cnt === 1) score -= 1;
        else if (cnt === 2) score -= 3;
      }
    }
  }

  if (ctx) score += cardAdjustmentsMisere(game, bb, me, opp, ctx);

  return score;
}

/** Card adjustments for misère — winning 3 macro boards in a row = you LOSE. */
function cardAdjustmentsMisere(
  game: HyperXOGame,
  bb: string[],
  me: Player,
  opp: Player,
  ctx: CardContext,
): number {
  const { myCards, opponentCards } = ctx;
  let adj = 0;

  // In misère, winning boards is DANGEROUS for you.
  // Cards that cause you to win boards are liabilities.
  // Cards that remove your own wins or force opponent to win are assets.

  // Opponent has swap → they can flip a board THEY won to become OUR win.
  // In misère, that's devastating — their loss becomes our loss.
  if (opponentCards.includes('swap')) {
    for (const board of game.boards) {
      if (board.winner !== opp) continue;
      // Each opponent-won board could be flipped onto us
      // Check if it sits on one of our dangerous macro lines
      const bi = game.boards.indexOf(board);
      for (const [a, b, c] of WINNING_LINES) {
        if (a !== bi && b !== bi && c !== bi) continue;
        const marks = [bb[a], bb[b], bb[c]];
        const myCount = marks.filter(m => m === me).length;
        // If we already have boards on this line, a swap here could complete our losing line
        if (myCount >= 1) adj -= 6;
      }
    }
  }

  // Opponent has condemn → they can remove a board from THEIR dangerous macro line
  // This helps them avoid losing, which is bad for us
  if (opponentCards.includes('condemn')) {
    for (const [a, b, c] of WINNING_LINES) {
      const marks = [bb[a], bb[b], bb[c]];
      const oppCount = marks.filter(m => m === opp).length;
      const openCount = marks.filter(m => m === '.').length;
      // Opponent has 2 on a line → normally they're close to losing.
      // But condemn lets them destroy the open board, escaping the trap.
      if (oppCount === 2 && openCount === 1) adj -= 5;
    }
  }

  // Opponent has shatter → they can revoke their own accidental board wins
  if (opponentCards.includes('shatter')) {
    for (const board of game.boards) {
      if (board.winner === opp) adj -= 3; // their wins are less sticky (they can undo them)
    }
  }

  // Opponent has haste → risky for THEM (might accidentally win boards)
  // So these are actually less threatening in misère
  if (opponentCards.includes('haste')) adj += 3;    // haste is a liability for opponent
  // Gravity could accidentally create wins for either player — slight concern
  if (opponentCards.includes('gravity')) adj -= 2;

  // Opponent has overwrite → they replace our piece with theirs.
  // Could cause THEM to win a board (bad for them in misère) or prevent us from winning
  // (prevents us contributing to our macro danger). Mixed value, slight concern.
  if (opponentCards.includes('overwrite')) adj -= 2;

  // --- Our card potential ---

  // We have condemn → we can remove a board from our own dangerous macro line. Escape valve.
  if (myCards.includes('condemn')) {
    for (const [a, b, c] of WINNING_LINES) {
      const marks = [bb[a], bb[b], bb[c]];
      const myCount = marks.filter(m => m === me).length;
      const openCount = marks.filter(m => m === '.').length;
      if (myCount === 2 && openCount === 1) adj += 5; // we can escape this trap
    }
  }

  // We have shatter → we can revoke our own accidental board wins
  if (myCards.includes('shatter')) {
    for (const board of game.boards) {
      if (board.winner === me) adj += 4; // our wins are less permanently dangerous
    }
  }

  // We have swap → we can flip opponent wins onto them or our wins off us
  if (myCards.includes('swap')) {
    for (const board of game.boards) {
      // We won a board on a dangerous macro line → swap can flip it to opponent
      if (board.winner === me) adj += 3;
    }
  }

  // We have haste → risky for us in misère (might win unwanted boards)
  if (myCards.includes('haste')) adj -= 2;
  // Gravity could create accidental board wins in either direction
  if (myCards.includes('gravity')) adj -= 1;

  return adj;
}

function evaluateConquest(ai: MinimaxAI, game: HyperXOGame): number {
  const me = ai.player;
  const opp: Player = me === 'X' ? 'O' : 'X';
  const ctx = ai.cardCtx;
  const bonusSet = new Set(game.conquestBonusBoards);

  let score = 0;

  // Point differential: the primary driver
  const scores = computeConquestScores(game);
  const myScore = scores[me];
  const oppScore = scores[opp];
  score += (myScore - oppScore) * 30;

  // Micro-board detail: weight threats by board value
  for (let bi = 0; bi < 9; bi++) {
    const board = game.boards[bi];
    const boardValue = bonusSet.has(bi) ? 2 : 1;

    if (board.winner === me) continue; // already counted in point differential
    if (board.winner === opp) continue;
    if (board.drawn || board.condemned) continue;

    for (const [a, b, c] of WINNING_LINES) {
      const trio = [board.cells[a], board.cells[b], board.cells[c]];
      if (!trio.includes(opp)) {
        const cnt = trio.filter(t => t === me).length;
        if (cnt === 1) score += 1 * boardValue;
        else if (cnt === 2) score += 5 * boardValue;
      }
      if (!trio.includes(me)) {
        const cnt = trio.filter(t => t === opp).length;
        if (cnt === 1) score -= 1 * boardValue;
        else if (cnt === 2) score -= 5 * boardValue;
      }
    }

    if (board.cells[4] === me) score += 0.3 * boardValue;
    else if (board.cells[4] === opp) score -= 0.3 * boardValue;
  }

  if (ctx) score += cardAdjustmentsConquest(game, me, opp, ctx, bonusSet);

  return score;
}

/** Card adjustments for conquest — point-based scoring. */
function cardAdjustmentsConquest(
  game: HyperXOGame,
  me: Player,
  opp: Player,
  ctx: CardContext,
  bonusSet: Set<number>,
): number {
  const { myCards, opponentCards } = ctx;
  let adj = 0;

  // Opponent has shatter → our won boards (especially bonus) are fragile
  if (opponentCards.includes('shatter')) {
    for (let i = 0; i < 9; i++) {
      if (game.boards[i].winner === me) adj -= bonusSet.has(i) ? 12 : 6;
      if (game.boards[i].winner === opp) adj += bonusSet.has(i) ? 8 : 4;
    }
  }

  // Opponent has overwrite → our blocks on high-value boards are unreliable
  if (opponentCards.includes('overwrite')) {
    for (let i = 0; i < 9; i++) {
      const board = game.boards[i];
      if (board.winner || board.drawn || board.condemned) continue;
      const bv = bonusSet.has(i) ? 2 : 1;
      for (const [a, b, c] of WINNING_LINES) {
        const trio = [board.cells[a], board.cells[b], board.cells[c]];
        if (trio.filter(t => t === opp).length === 2 && trio.filter(t => t === me).length === 1)
          adj -= 3 * bv;
      }
    }
  }

  // Opponent has sabotage → our thin wins on valuable boards are fragile
  if (opponentCards.includes('sabotage')) {
    for (let i = 0; i < 9; i++) {
      if (game.boards[i].winner !== me) continue;
      let winLines = 0;
      for (const [a, b, c] of WINNING_LINES) {
        const trio = [game.boards[i].cells[a], game.boards[i].cells[b], game.boards[i].cells[c]];
        if (trio.every(t => t === me)) winLines++;
      }
      if (winLines === 1) adj -= bonusSet.has(i) ? 8 : 4;
    }
  }

  // Opponent has condemn → can remove a high-value board from play (0 points for both)
  if (opponentCards.includes('condemn')) {
    for (let i = 0; i < 9; i++) {
      const board = game.boards[i];
      if (board.winner || board.drawn || board.condemned) continue;
      // If we're likely to win this board and it's valuable, condemn is a threat
      const bv = bonusSet.has(i) ? 2 : 1;
      let myThreats = 0;
      for (const [a, b, c] of WINNING_LINES) {
        const trio = [board.cells[a], board.cells[b], board.cells[c]];
        if (trio.filter(t => t === me).length === 2 && trio.filter(t => t === '').length === 1) myThreats++;
      }
      if (myThreats > 0) adj -= bv * 3;
    }
  }

  // Opponent has haste → their threats on valuable boards are scarier
  if (opponentCards.includes('haste')) {
    for (let i = 0; i < 9; i++) {
      const board = game.boards[i];
      if (board.winner || board.drawn || board.condemned) continue;
      const bv = bonusSet.has(i) ? 2 : 1;
      for (const [a, b, c] of WINNING_LINES) {
        const trio = [board.cells[a], board.cells[b], board.cells[c]];
        if (trio.filter(t => t === opp).length === 2 && trio.filter(t => t === '').length === 1)
          adj -= 2 * bv;
      }
    }
  }

  // --- Our card potential ---

  if (myCards.includes('overwrite')) {
    for (let i = 0; i < 9; i++) {
      const board = game.boards[i];
      if (board.winner || board.drawn || board.condemned) continue;
      const bv = bonusSet.has(i) ? 2 : 1;
      for (const [a, b, c] of WINNING_LINES) {
        const trio = [board.cells[a], board.cells[b], board.cells[c]];
        if (trio.filter(t => t === me).length === 2 && trio.filter(t => t === opp).length === 1)
          adj += 3 * bv;
      }
    }
  }

  if (myCards.includes('shatter')) {
    for (let i = 0; i < 9; i++) {
      if (game.boards[i].winner === opp) adj += bonusSet.has(i) ? 8 : 4;
    }
  }

  if (myCards.includes('haste')) {
    for (let i = 0; i < 9; i++) {
      const board = game.boards[i];
      if (board.winner || board.drawn || board.condemned) continue;
      const bv = bonusSet.has(i) ? 2 : 1;
      for (const [a, b, c] of WINNING_LINES) {
        const trio = [board.cells[a], board.cells[b], board.cells[c]];
        if (trio.filter(t => t === me).length === 2 && trio.filter(t => t === '').length === 1)
          adj += 2 * bv;
      }
    }
  }

  // Gravity: board rearrangement can swing point-valuable boards
  if (opponentCards.includes('gravity')) adj -= 4;
  if (myCards.includes('gravity')) adj += 3;

  return adj;
}
