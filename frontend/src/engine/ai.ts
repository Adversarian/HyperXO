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

export interface MinimaxAI {
  player: Player;
  depth: number;
  blunderRate: number;
  tt: Map<number, TTEntry>;
}

export function createAI(player: Player, depth: number, blunderRate = 0): MinimaxAI {
  return { player, depth, blunderRate, tt: new Map() };
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
    let alpha = prevScore - ASPIRATION_MARGIN;
    let beta = prevScore + ASPIRATION_MARGIN;
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
  let moves = availableMoves(game);
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

function evaluateTerminal(ai: MinimaxAI, game: HyperXOGame, remainingDepth: number): number {
  if (game.winner === ai.player) return 10000 + remainingDepth;
  if (game.winner !== null) return -10000 - remainingDepth;
  return 0;
}

function evaluate(ai: MinimaxAI, game: HyperXOGame): number {
  switch (game.mode) {
    case 'sudden-death': return evaluateSuddenDeath(ai, game);
    case 'misere': return evaluateMisere(ai, game);
    default: return evaluateClassic(ai, game);
  }
}

function evaluateClassic(ai: MinimaxAI, game: HyperXOGame): number {
  const me = ai.player;
  const opp: Player = me === 'X' ? 'O' : 'X';

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
  for (const board of game.boards) {
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

  return score;
}

function evaluateSuddenDeath(ai: MinimaxAI, game: HyperXOGame): number {
  const me = ai.player;
  const opp: Player = me === 'X' ? 'O' : 'X';
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

  return score;
}

function evaluateMisere(ai: MinimaxAI, game: HyperXOGame): number {
  const me = ai.player;
  const opp: Player = me === 'X' ? 'O' : 'X';
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

  return score;
}
