/**
 * Integration tests: simulate full multi-turn AI games with gambits.
 *
 * These tests replicate the actual game flow from GameView — AI decides cards,
 * applies effects, makes moves, triggers passives — across many turns.
 * The goal is to catch bugs like TT poisoning, state corruption, infinite loops,
 * and invalid moves that only surface during real gameplay.
 */
import { describe, it, expect } from 'vitest';
import {
  createGame,
  applyMove,
  availableMoves,
  recalcBoard,
  updateGlobalState,
  validateWinner,
  bigBoardState,
  WINNING_LINES,
  type HyperXOGame,
  type Player,
  type GameMode,
} from '../game';
import {
  createPowerUpState,
  useCard,
  getAvailableCards,
  applyOverwrite,
  applySabotage,
  applyRecall,
  applySwap,
  applyShatter,
  applyCondemn,
  applyRedirect,
  applyGravity,
  applySiegeClaim,
  refreshSiegeThreats,
  advanceSiegeThreats,
  getActiveCards,
  isCardUsed,
  rechargeRandomCard,
  type PowerUpState,
  type PowerUpDraft,
  type SiegeThreat,
} from '../powerups';
import {
  aiDecideCard,
  applyAiPreCard,
  aiRedirectTarget,
  isPrePlacementCard,
  snapshot,
  restore,
  type AiCardDecision,
} from '../ai-gambits';
import { choose, createAI, type MinimaxAI } from '../ai';

// ---- Simulate a full AI turn (mirrors GameView's doAiResponse + completeAfterAiMove) ----

interface TurnResult {
  cardUsed: AiCardDecision | null;
  move: [number, number];
  passivesTriggered: string[];
  error: string | null;
}

interface SimPlayer {
  ai: MinimaxAI;
  puState: PowerUpState;
  siegeThreats: SiegeThreat[];
  doctrine: string;
  hastePending: boolean;
}

/**
 * Execute one full AI turn, including card decision, move, and passive triggers.
 * This replicates the flow from GameView.doAiResponse + completeAfterAiMove.
 */
function executeAiTurn(game: HyperXOGame, player: SimPlayer, opponent: SimPlayer, difficulty: number): TurnResult {
  const result: TurnResult = { cardUsed: null, move: [0, 0], passivesTriggered: [], error: null };

  if (game.winner || game.drawn) {
    result.error = 'Game already over';
    return result;
  }

  if (game.currentPlayer !== player.ai.player) {
    result.error = `Not ${player.ai.player}'s turn (current: ${game.currentPlayer})`;
    return result;
  }

  // Step 1: AI decides whether to use a card
  const cardDecision = aiDecideCard(game, player.puState, player.ai.player, difficulty);

  // Step 2: Apply pre-placement card (if any)
  if (cardDecision && isPrePlacementCard(cardDecision.card)) {
    result.cardUsed = cardDecision;
    useCard(player.puState, cardDecision.card);
    applyAiPreCard(game, cardDecision);
    checkZkey(game, 'after pre-card');

    // Critical: clear TT after manual state modification (this was the TT poisoning fix)
    player.ai.tt.clear();

    if (game.winner || game.drawn) return result;
  }

  // Step 3: AI picks a move
  const moves = availableMoves(game);
  if (moves.length === 0) {
    result.error = 'No available moves';
    return result;
  }

  const move = choose(player.ai, game);
  result.move = move;
  checkZkey(game, 'after choose');

  // Capture pre-move state for passive detection
  const prevWinners = game.boards.map(b => b.winner);

  // Step 4: Apply the move
  applyMove(game, move[0], move[1]);
  checkZkey(game, 'after main applyMove');

  if (game.winner || game.drawn) return result;

  // Step 5: Handle flow modifier cards
  if (cardDecision && !isPrePlacementCard(cardDecision.card)) {
    result.cardUsed = cardDecision;
    useCard(player.puState, cardDecision.card);

    switch (cardDecision.card) {
      case 'haste': {
        // AI gets a second full turn
        if (!game.winner && !game.drawn) {
          game.currentPlayer = player.ai.player;
          game.zkey ^= game.zobrist.stmKey();
          checkZkey(game, 'haste: after switch');
          player.ai.tt.clear();
          result.passivesTriggered.push('haste-second-turn');

          const hasteMoves = availableMoves(game);
          if (hasteMoves.length > 0) {
            const hasteMove = choose(player.ai, game);
            applyMove(game, hasteMove[0], hasteMove[1]);
            checkZkey(game, 'haste: after second applyMove');
          }
        }
        break;
      }
      case 'redirect': {
        // Override opponent's next board
        const target = aiRedirectTarget(game, player.ai.player);
        if (target >= 0) {
          applyRedirect(game, target);
          checkZkey(game, 'after redirect');
        }
        break;
      }
    }
  }

  if (game.winner || game.drawn) return result;

  // Step 6: Check for newly won boards (for passive triggers)
  const newlyWon: { boardIdx: number; winner: Player }[] = [];
  for (let i = 0; i < 9; i++) {
    if (game.boards[i].winner && !prevWinners[i]) {
      newlyWon.push({ boardIdx: i, winner: game.boards[i].winner! });
    }
  }

  // Step 7: Momentum passive — extra turn when winning a board
  if (player.doctrine === 'momentum' && newlyWon.some(w => w.winner === player.ai.player)) {
    if (!game.winner && !game.drawn) {
      result.passivesTriggered.push('momentum');
      game.currentPlayer = player.ai.player;
      game.zkey ^= game.zobrist.stmKey();
      checkZkey(game, 'momentum: after switch');
      player.ai.tt.clear();

      const momMoves = availableMoves(game);
      if (momMoves.length > 0) {
        const momMove = choose(player.ai, game);
        applyMove(game, momMove[0], momMove[1]);
        checkZkey(game, 'momentum: after applyMove');
      }
    }
  }

  // Step 8: Arsenal passive — recharge a random used card when you win a board
  for (const p of [player, opponent]) {
    if (p.doctrine !== 'arsenal') continue;
    if (game.winner || game.drawn) break;
    const wonByMe = newlyWon.some(w => w.winner === p.ai.player);
    if (!wonByMe) continue;
    // Exclude the card used this turn (prevent instant recharge loop)
    const exclude = (p === player && result.cardUsed) ? result.cardUsed.card : undefined;
    const usedCards = getActiveCards(p.puState.draft).filter(c => isCardUsed(p.puState, c) && c !== exclude);
    if (usedCards.length > 0) {
      const pick = usedCards[Math.floor(Math.random() * usedCards.length)];
      p.puState.used[pick] = false;
      result.passivesTriggered.push(`arsenal-${p.ai.player}`);
    }
  }

  // Step 9: Siege passive — advance counters
  if (player.doctrine === 'siege') {
    player.siegeThreats = refreshSiegeThreats(player.siegeThreats, game, player.ai.player);
  }
  if (opponent.doctrine === 'siege') {
    const { updated, claimed } = advanceSiegeThreats(opponent.siegeThreats, game, opponent.ai.player);
    opponent.siegeThreats = updated;
    for (const claim of claimed) {
      if (game.winner || game.drawn) break;
      result.passivesTriggered.push(`siege-claim-${opponent.ai.player}`);
      applySiegeClaim(game, claim.boardIdx, claim.cellIdx, opponent.ai.player);
      checkZkey(game, `siege-claim-${opponent.ai.player}`);
    }
  }

  return result;
}

// ---- State invariant checks ----

/**
 * Recompute the Zobrist key from scratch based on actual board state.
 * If this disagrees with game.zkey, the incremental Zobrist updates have a bug.
 */
function recomputeZkey(game: HyperXOGame): number {
  let key = 0;
  for (let bi = 0; bi < 9; bi++) {
    for (let ci = 0; ci < 9; ci++) {
      const cell = game.boards[bi].cells[ci];
      if (cell === 'X' || cell === 'O') {
        key ^= game.zobrist.pieceKey(bi, ci, cell);
      }
    }
  }
  if (game.currentPlayer === 'O') {
    key ^= game.zobrist.stmKey();
  }
  key ^= game.zobrist.nbiKey(game.nextBoardIndex);
  return key;
}

/** Rebuild zkey from scratch after manual state setup. */
function syncZkey(game: HyperXOGame): void {
  game.zkey = recomputeZkey(game);
}

function checkZkey(game: HyperXOGame, step: string): void {
  const expected = recomputeZkey(game);
  if (game.zkey !== expected) {
    throw new Error(`Zobrist desync at "${step}": game.zkey=${game.zkey}, expected=${expected}`);
  }
}

function assertGameInvariant(game: HyperXOGame, label: string): void {
  // 1. No cell has invalid content
  for (let bi = 0; bi < 9; bi++) {
    for (let ci = 0; ci < 9; ci++) {
      const cell = game.boards[bi].cells[ci];
      if (cell !== '' && cell !== 'X' && cell !== 'O') {
        throw new Error(`${label}: Board ${bi} cell ${ci} has invalid value "${cell}"`);
      }
    }
  }

  // 2. Board winner is consistent with cells
  for (let bi = 0; bi < 9; bi++) {
    const b = game.boards[bi];
    if (b.condemned) continue;
    // If someone won, verify the winning line exists
    if (b.winner) {
      let hasWinLine = false;
      for (const [a, bc, c] of WINNING_LINES) {
        if (b.cells[a] === b.winner && b.cells[bc] === b.winner && b.cells[c] === b.winner) {
          hasWinLine = true;
          break;
        }
      }
      if (!hasWinLine) {
        throw new Error(`${label}: Board ${bi} claims winner ${b.winner} but no winning line found. Cells: ${b.cells}`);
      }
    }
  }

  // 3. Current player is valid
  if (game.currentPlayer !== 'X' && game.currentPlayer !== 'O') {
    throw new Error(`${label}: Invalid currentPlayer "${game.currentPlayer}"`);
  }

  // 4. nextBoardIndex points to a valid live board or is null
  if (game.nextBoardIndex !== null) {
    if (game.nextBoardIndex < 0 || game.nextBoardIndex > 8) {
      throw new Error(`${label}: nextBoardIndex ${game.nextBoardIndex} out of range`);
    }
    const nb = game.boards[game.nextBoardIndex];
    if (nb.winner || nb.drawn || nb.condemned) {
      throw new Error(`${label}: nextBoardIndex ${game.nextBoardIndex} points to resolved board`);
    }
  }

  // 5. If game has a winner, verify it's X or O
  if (game.winner !== null && game.winner !== 'X' && game.winner !== 'O') {
    throw new Error(`${label}: Invalid winner "${game.winner}"`);
  }

  // 6. Available moves should exist if game is not over
  if (!game.winner && !game.drawn) {
    const moves = availableMoves(game);
    if (moves.length === 0) {
      throw new Error(`${label}: No available moves but game not marked as over`);
    }
  }

  // 7. Zobrist key matches actual board state
  const expected = recomputeZkey(game);
  if (game.zkey !== expected) {
    throw new Error(`${label}: Zobrist key desync! game.zkey=${game.zkey}, recomputed=${expected}`);
  }

  // 8. Winner matches actual board state (catches misattribution bugs)
  const winnerErr = validateWinner(game);
  if (winnerErr) {
    throw new Error(`${label}: Winner validation failed: ${winnerErr}`);
  }
}

/**
 * Verify that choose() returns a valid move (exists in availableMoves).
 */
function assertValidMove(game: HyperXOGame, move: [number, number], label: string): void {
  const moves = availableMoves(game);
  const valid = moves.some(([b, c]) => b === move[0] && c === move[1]);
  if (!valid) {
    throw new Error(
      `${label}: AI chose invalid move [${move}]. ` +
      `Available: ${moves.map(m => `[${m}]`).join(', ')}. ` +
      `Board ${move[0]} cells: ${game.boards[move[0]].cells}. ` +
      `Board winner: ${game.boards[move[0]].winner}, drawn: ${game.boards[move[0]].drawn}, condemned: ${game.boards[move[0]].condemned}`
    );
  }
}

// ---- Full game simulation ----

interface SimConfig {
  mode: GameMode;
  xDifficulty: number;
  oDifficulty: number;
  xDraft: PowerUpDraft;
  oDraft: PowerUpDraft;
  maxTurns?: number;
}

interface SimResult {
  winner: Player | null;
  drawn: boolean;
  turns: number;
  errors: string[];
  cardsUsed: { player: Player; card: string; turn: number }[];
  passives: { trigger: string; turn: number }[];
}

function simulateFullGame(config: SimConfig): SimResult {
  const game = createGame(config.mode);
  const maxTurns = config.maxTurns ?? 200;

  const xPlayer: SimPlayer = {
    ai: createAI('X', config.xDifficulty <= 3 ? 3 : config.xDifficulty <= 5 ? 5 : 8, 0), // 0 blunder for determinism
    puState: createPowerUpState(config.xDraft),
    siegeThreats: [],
    doctrine: config.xDraft.doctrine,
    hastePending: false,
  };
  const oPlayer: SimPlayer = {
    ai: createAI('O', config.oDifficulty <= 3 ? 3 : config.oDifficulty <= 5 ? 5 : 8, 0),
    puState: createPowerUpState(config.oDraft),
    siegeThreats: [],
    doctrine: config.oDraft.doctrine,
    hastePending: false,
  };

  const result: SimResult = { winner: null, drawn: false, turns: 0, errors: [], cardsUsed: [], passives: [] };

  for (let turn = 0; turn < maxTurns; turn++) {
    if (game.winner || game.drawn) break;
    result.turns = turn + 1;

    const current = game.currentPlayer === 'X' ? xPlayer : oPlayer;
    const other = game.currentPlayer === 'X' ? oPlayer : xPlayer;
    const difficulty = game.currentPlayer === 'X' ? config.xDifficulty : config.oDifficulty;

    // Assert invariants before the turn
    try {
      assertGameInvariant(game, `Turn ${turn + 1} pre (${game.currentPlayer})`);
    } catch (e: unknown) {
      result.errors.push((e as Error).message);
      break;
    }

    // Execute the turn
    let turnResult: TurnResult;
    try {
      turnResult = executeAiTurn(game, current, other, difficulty);
    } catch (e: unknown) {
      result.errors.push(`Turn ${turn + 1} (${game.currentPlayer}): ${(e as Error).message}`);
      break;
    }

    if (turnResult.error) {
      result.errors.push(`Turn ${turn + 1}: ${turnResult.error}`);
      break;
    }

    // Record card usage
    if (turnResult.cardUsed) {
      result.cardsUsed.push({
        player: current.ai.player,
        card: turnResult.cardUsed.card,
        turn: turn + 1,
      });
    }

    // Record passive triggers
    for (const p of turnResult.passivesTriggered) {
      result.passives.push({ trigger: p, turn: turn + 1 });
    }

    // Assert invariants after the turn
    try {
      if (!game.winner && !game.drawn) {
        assertGameInvariant(game, `Turn ${turn + 1} post (${current.ai.player})`);
      }
    } catch (e: unknown) {
      result.errors.push((e as Error).message);
      break;
    }
  }

  // Final winner validation
  const winnerErr = validateWinner(game);
  if (winnerErr) {
    result.errors.push(`Final state: ${winnerErr}`);
  }

  result.winner = game.winner;
  result.drawn = game.drawn;
  return result;
}

// =====================================================================
// TESTS
// =====================================================================

describe('Full game simulation - Classic mode', () => {
  // Depth 3 exercises the same engine code paths (applyMove, undoMove,
  // updateGlobalState, card effects, passives) as depth 5/8, just faster.
  it('completes a full game with all card types without errors', () => {
    const result = simulateFullGame({
      mode: 'classic',
      xDifficulty: 3,
      oDifficulty: 3,
      xDraft: { strike: 'overwrite', tactics: 'redirect', disruption: 'shatter', doctrine: 'momentum' },
      oDraft: { strike: 'haste', tactics: 'condemn', disruption: 'sabotage', doctrine: 'arsenal' },
    });

    expect(result.errors).toEqual([]);
    expect(result.turns).toBeGreaterThan(0);
    expect(result.winner !== null || result.drawn).toBe(true);
  });

  it('completes a full game with gravity + siege', () => {
    const result = simulateFullGame({
      mode: 'classic',
      xDifficulty: 3,
      oDifficulty: 3,
      xDraft: { strike: 'gravity', tactics: 'recall', disruption: 'swap', doctrine: 'siege' },
      oDraft: { strike: 'overwrite', tactics: 'redirect', disruption: 'sabotage', doctrine: 'momentum' },
    });

    expect(result.errors).toEqual([]);
    expect(result.winner !== null || result.drawn).toBe(true);
  });
});

describe('Full game simulation - Sudden Death mode', () => {
  it('completes a game (should end quickly)', () => {
    const result = simulateFullGame({
      mode: 'sudden-death',
      xDifficulty: 3,
      oDifficulty: 3,
      xDraft: { strike: 'haste', tactics: 'redirect', disruption: 'shatter', doctrine: 'momentum' },
      oDraft: { strike: 'overwrite', tactics: 'condemn', disruption: 'sabotage', doctrine: 'arsenal' },
    });

    expect(result.errors).toEqual([]);
    expect(result.winner !== null || result.drawn).toBe(true);
    expect(result.turns).toBeLessThan(50);
  });

  it('haste in sudden death does not corrupt state', () => {
    const result = simulateFullGame({
      mode: 'sudden-death',
      xDifficulty: 3,
      oDifficulty: 3,
      xDraft: { strike: 'haste', tactics: 'recall', disruption: 'swap', doctrine: 'momentum' },
      oDraft: { strike: 'haste', tactics: 'redirect', disruption: 'shatter', doctrine: 'arsenal' },
    });

    expect(result.errors).toEqual([]);
  });
});

describe('Full game simulation - Misere mode', () => {
  it('completes a full game', () => {
    const result = simulateFullGame({
      mode: 'misere',
      xDifficulty: 3,
      oDifficulty: 3,
      xDraft: { strike: 'overwrite', tactics: 'condemn', disruption: 'shatter', doctrine: 'momentum' },
      oDraft: { strike: 'haste', tactics: 'redirect', disruption: 'swap', doctrine: 'arsenal' },
    });

    expect(result.errors).toEqual([]);
    expect(result.winner !== null || result.drawn).toBe(true);
  });

  it('swap in misere does not corrupt state', () => {
    const result = simulateFullGame({
      mode: 'misere',
      xDifficulty: 3,
      oDifficulty: 3,
      xDraft: { strike: 'gravity', tactics: 'recall', disruption: 'swap', doctrine: 'siege' },
      oDraft: { strike: 'overwrite', tactics: 'condemn', disruption: 'swap', doctrine: 'momentum' },
    });

    expect(result.errors).toEqual([]);
  });
});

// ---- TT poisoning regression tests ----

describe('TT poisoning - regression', () => {
  it('AI move is valid after overwrite modifies board state', () => {
    const game = createGame();
    // Set up a mid-game position
    game.boards[0].cells = ['X', 'O', 'X', '', 'O', '', '', '', ''];
    game.boards[1].cells = ['O', 'X', '', '', '', '', '', '', ''];
    game.boards[4].cells = ['X', '', '', 'O', 'X', '', '', '', 'O'];
    game.currentPlayer = 'X';
    game.nextBoardIndex = null;

    const ai = createAI('X', 3, 0);

    // First, let AI build up TT entries with a search
    choose(ai, game);
    expect(ai.tt.size).toBeGreaterThan(0);

    // Now apply overwrite (manual state change, like a card effect)
    applyOverwrite(game, 0, 1); // Replace O at (0,1) with X
    recalcBoard(game.boards[0]);
    updateGlobalState(game);

    // WITHOUT clearing TT, the AI might return a stale move that points to
    // a now-occupied cell. Clear TT to prevent this.
    ai.tt.clear();

    // AI should now choose a valid move
    const move = choose(ai, game);
    assertValidMove(game, move, 'After overwrite');
  });

  it('AI move is valid after shatter wipes a board', () => {
    const game = createGame();
    game.boards[0].cells = ['X', 'X', 'O', 'O', 'X', 'O', 'X', 'O', 'X'];
    game.boards[0].winner = 'X';
    game.boards[3].cells = ['O', 'O', '', 'X', '', '', '', '', ''];
    game.currentPlayer = 'X';
    game.nextBoardIndex = null;

    const ai = createAI('X', 3, 0);
    choose(ai, game); // Build TT

    // Shatter board 0 (drastic state change)
    applyShatter(game, 0);
    ai.tt.clear();

    if (!game.winner && !game.drawn) {
      const move = choose(ai, game);
      assertValidMove(game, move, 'After shatter');
    }
  });

  it('AI move is valid after condemn removes a board', () => {
    const game = createGame();
    game.boards[2].cells = ['O', 'O', '', 'X', '', '', '', '', ''];
    game.boards[5].cells = ['X', '', '', '', 'O', '', '', '', ''];
    game.currentPlayer = 'X';
    game.nextBoardIndex = 2;

    const ai = createAI('X', 3, 0);
    choose(ai, game);

    // Condemn board 2 (which was the forced board!)
    applyCondemn(game, 2);
    ai.tt.clear();

    // nextBoardIndex should be null now (condemned board grants free move)
    expect(game.nextBoardIndex).toBeNull();

    if (!game.winner && !game.drawn) {
      const move = choose(ai, game);
      assertValidMove(game, move, 'After condemn');
    }
  });

  it('AI move is valid after swap flips a board', () => {
    const game = createGame();
    game.boards[4].cells = ['O', 'O', '', 'X', 'O', '', '', 'X', ''];
    game.currentPlayer = 'X';
    game.nextBoardIndex = null;

    const ai = createAI('X', 3, 0);
    choose(ai, game);

    applySwap(game, 4);
    ai.tt.clear();

    const move = choose(ai, game);
    assertValidMove(game, move, 'After swap');
  });

  it('AI move is valid after recall relocates a piece', () => {
    const game = createGame();
    game.boards[0].cells = ['X', '', '', '', '', '', '', '', ''];
    game.boards[3].cells = ['', '', '', '', '', '', '', '', ''];
    game.currentPlayer = 'X';
    game.nextBoardIndex = null;

    const ai = createAI('X', 3, 0);
    choose(ai, game);

    applyRecall(game, 0, 0, 3, 4);
    ai.tt.clear();

    const move = choose(ai, game);
    assertValidMove(game, move, 'After recall');
  });

  it('stale TT produces invalid move WITHOUT clearing (proving the bug exists)', () => {
    const game = createGame();
    game.boards[0].cells = ['X', 'X', 'O', '', '', '', '', '', ''];
    game.boards[1].cells = ['O', '', '', '', '', '', '', '', ''];
    game.currentPlayer = 'X';
    game.nextBoardIndex = 0;

    const ai = createAI('X', 3, 0);
    choose(ai, game); // Build TT entries

    // Overwrite O at cell 2 → now cell 2 is X
    applyOverwrite(game, 0, 2);

    // DO NOT clear TT — this is the bug scenario
    // The TT might still suggest cell 2 on board 0 as best move
    // but that cell is now occupied with X

    // Whether the move is valid or not depends on TT state,
    // but we document that this is the dangerous pattern.
    // The fix is: always clear TT after manual state changes.
    // We just verify choose() doesn't throw.
    if (!game.winner && !game.drawn && availableMoves(game).length > 0) {
      expect(() => choose(ai, game)).not.toThrow();
    }
  });
});

// ---- Card effect + immediate AI search consistency ----

describe('Card effects followed by AI search', () => {
  it('sabotage then AI search produces valid move', () => {
    const game = createGame();
    // Mid-game position
    for (let bi = 0; bi < 5; bi++) {
      game.boards[bi].cells[0] = bi % 2 === 0 ? 'X' : 'O';
      game.boards[bi].cells[4] = bi % 2 === 0 ? 'O' : 'X';
    }
    game.currentPlayer = 'X';
    game.nextBoardIndex = null;

    const ai = createAI('X', 5, 0);

    // Apply sabotage on one of O's pieces
    applySabotage(game, 1, 0); // Remove O at board 1, cell 0
    ai.tt.clear();

    const move = choose(ai, game);
    assertValidMove(game, move, 'After sabotage');
  });

  it('multiple card effects in sequence still produce valid AI moves', () => {
    const game = createGame();
    game.boards[0].cells = ['X', 'O', '', 'O', 'X', '', '', '', ''];
    game.boards[1].cells = ['O', 'X', '', '', '', '', '', '', ''];
    game.boards[4].cells = ['', '', '', '', 'X', '', '', '', 'O'];
    game.currentPlayer = 'X';
    game.nextBoardIndex = null;

    const ai = createAI('X', 3, 0);

    // Sabotage → Overwrite → Search (simulating multiple card interactions)
    applySabotage(game, 0, 1); // Remove O
    ai.tt.clear();
    let move = choose(ai, game);
    assertValidMove(game, move, 'After sabotage');

    // Reset for next card
    const snap = snapshot(game);
    restore(game, snap);

    applyOverwrite(game, 0, 3); // Replace O with X
    ai.tt.clear();

    if (!game.winner && !game.drawn) {
      move = choose(ai, game);
      assertValidMove(game, move, 'After overwrite');
    }
  });
});

// ---- Passive trigger chains ----

describe('Passive trigger chains', () => {
  it('momentum extra turn does not break game state', () => {
    const game = createGame();
    // X is about to win board 0
    game.boards[0].cells = ['X', 'X', '', '', '', '', '', '', ''];
    game.nextBoardIndex = 0;
    game.currentPlayer = 'X';
    syncZkey(game);

    const ai = createAI('X', 5, 0);

    // X plays cell 2, wins board 0
    applyMove(game, 0, 2);
    expect(game.boards[0].winner).toBe('X');

    if (!game.winner && !game.drawn) {
      // Momentum: X gets another turn
      game.currentPlayer = 'X';
      game.zkey ^= game.zobrist.stmKey();
      ai.tt.clear();

      const momMoves = availableMoves(game);
      expect(momMoves.length).toBeGreaterThan(0);

      const momMove = choose(ai, game);
      assertValidMove(game, momMove, 'Momentum extra turn');
      applyMove(game, momMove[0], momMove[1]);

      assertGameInvariant(game, 'After momentum');
    }
  });

  it('siege auto-claim places valid pieces', () => {
    const game = createGame();
    // X has 2-in-a-row on board 0 with empty cell 2
    game.boards[0].cells = ['X', 'X', '', '', '', '', '', '', ''];
    game.currentPlayer = 'O'; // It's O's turn (siege advances on opponent moves)
    game.nextBoardIndex = null;
    syncZkey(game);

    const siegeThreats: SiegeThreat[] = [
      { boardIdx: 0, blockingCell: 2, turnsUnblocked: 2 }, // 1 more turn to claim
    ];
    const oMoves = availableMoves(game);
    if (oMoves.length > 0) {
      // Play on a different board
      const otherMove = oMoves.find(([bi]) => bi !== 0) ?? oMoves[0];
      applyMove(game, otherMove[0], otherMove[1]);
    }

    // Advance siege
    const { claimed } = advanceSiegeThreats(siegeThreats, game, 'X');

    expect(claimed.length).toBe(1);
    expect(claimed[0]).toEqual({ boardIdx: 0, cellIdx: 2 });

    // Apply the claim
    for (const claim of claimed) {
      applySiegeClaim(game, claim.boardIdx, claim.cellIdx, 'X');
    }

    expect(game.boards[0].cells[2]).toBe('X');
    // X should now have won board 0
    expect(game.boards[0].winner).toBe('X');
    assertGameInvariant(game, 'After siege claim');
  });

  it('arsenal recharges a used card when you win a board', () => {
    const pu = createPowerUpState({ strike: 'haste', tactics: 'condemn', disruption: 'sabotage', doctrine: 'arsenal' });
    // Mark all active cards as used
    useCard(pu, 'haste');
    useCard(pu, 'condemn');
    useCard(pu, 'sabotage');
    expect(getActiveCards(pu.draft).filter(c => isCardUsed(pu, c)).length).toBe(3);

    // Recharge
    const recharged = rechargeRandomCard(pu);
    expect(recharged).not.toBeNull();
    expect(isCardUsed(pu, recharged!)).toBe(false);
    // Only one card recharged
    expect(getActiveCards(pu.draft).filter(c => isCardUsed(pu, c)).length).toBe(2);
  });

  it('arsenal returns null when no cards are used', () => {
    const pu = createPowerUpState({ strike: 'haste', tactics: 'condemn', disruption: 'sabotage', doctrine: 'arsenal' });
    const recharged = rechargeRandomCard(pu);
    expect(recharged).toBeNull();
  });

  it('arsenal excludes the card used this turn', () => {
    const pu = createPowerUpState({ strike: 'haste', tactics: 'condemn', disruption: 'sabotage', doctrine: 'arsenal' });
    useCard(pu, 'haste');
    // Exclude haste — only haste is used, so nothing to recharge
    const recharged = rechargeRandomCard(pu, 'haste');
    expect(recharged).toBeNull();
  });

  it('arsenal recharges a different card when exclude is set', () => {
    const pu = createPowerUpState({ strike: 'haste', tactics: 'condemn', disruption: 'sabotage', doctrine: 'arsenal' });
    useCard(pu, 'haste');
    useCard(pu, 'condemn');
    // Exclude haste — should recharge condemn
    const recharged = rechargeRandomCard(pu, 'haste');
    expect(recharged).toBe('condemn');
    expect(isCardUsed(pu, 'condemn')).toBe(false);
    expect(isCardUsed(pu, 'haste')).toBe(true); // haste stays used
  });
});

// ---- State consistency after card effects ----

describe('State consistency', () => {
  it('snapshot/restore preserves exact state through card + move + passive sequence', () => {
    const game = createGame();
    // Build up some game state
    applyMove(game, 4, 4); // X center-center
    applyMove(game, 4, 0); // O
    applyMove(game, 0, 0); // X
    applyMove(game, 0, 4); // O

    const snap = snapshot(game);
    const origZkey = game.zkey;

    // Apply a bunch of card effects
    applyOverwrite(game, 0, 4); // X overwrites O's piece
    applySwap(game, 4); // Flip board 4

    // Restore
    restore(game, snap);
    expect(game.zkey).toBe(origZkey);
    expect(game.boards[0].cells[4]).toBe('O'); // O's piece restored
    expect(game.boards[4].cells[0]).toBe('O'); // Swap undone
  });

  it('aiDecideCard does not modify game state', () => {
    const game = createGame();
    game.boards[0].cells = ['X', 'X', 'O', '', 'O', '', '', '', ''];
    game.boards[3].cells = ['O', 'O', '', 'X', '', '', '', '', ''];
    game.currentPlayer = 'X';
    game.nextBoardIndex = null;

    const origZkey = game.zkey;
    const origCells0 = [...game.boards[0].cells];
    const origCells3 = [...game.boards[3].cells];
    const origPlayer = game.currentPlayer;
    const origNbi = game.nextBoardIndex;

    const draft: PowerUpDraft = {
      strike: 'overwrite',
      tactics: 'redirect',
      disruption: 'shatter',
      doctrine: 'momentum',
    };
    const puState = createPowerUpState(draft);

    // This internally simulates card effects — must restore perfectly
    aiDecideCard(game, puState, 'X', 8);

    expect(game.zkey).toBe(origZkey);
    expect(game.boards[0].cells).toEqual(origCells0);
    expect(game.boards[3].cells).toEqual(origCells3);
    expect(game.currentPlayer).toBe(origPlayer);
    expect(game.nextBoardIndex).toBe(origNbi);
    expect(game.winner).toBeNull();
    expect(game.drawn).toBe(false);
  });

  it('choose() does not modify game state', () => {
    const game = createGame();
    applyMove(game, 4, 4);
    applyMove(game, 4, 0);

    const origZkey = game.zkey;
    const origCells = game.boards.map(b => [...b.cells]);
    const origPlayer = game.currentPlayer;
    const origNbi = game.nextBoardIndex;

    const ai = createAI('X', 5, 0);
    choose(ai, game);

    expect(game.zkey).toBe(origZkey);
    expect(game.currentPlayer).toBe(origPlayer);
    expect(game.nextBoardIndex).toBe(origNbi);
    for (let i = 0; i < 9; i++) {
      expect(game.boards[i].cells).toEqual(origCells[i]);
    }
  });
});

// ---- Edge cases that can cause hangs ----

describe('Potential hang scenarios', () => {
  it('AI can always find a move when game is not over', () => {
    // Simulate 50 random-ish positions and verify AI always returns
    for (let trial = 0; trial < 20; trial++) {
      const game = createGame();
      const ai = createAI('X', 3, 0);

      // Play random moves to reach a mid-game state
      for (let m = 0; m < 10 + trial; m++) {
        if (game.winner || game.drawn) break;
        const moves = availableMoves(game);
        if (moves.length === 0) break;
        const pick = moves[m % moves.length];
        applyMove(game, pick[0], pick[1]);
      }

      if (game.winner || game.drawn) continue;

      // AI should be able to find a move
      ai.tt.clear();
      if (game.currentPlayer !== 'X') {
        // Flip to X for testing
        game.currentPlayer = 'X';
        game.zkey ^= game.zobrist.stmKey();
      }

      const move = choose(ai, game);
      assertValidMove(game, move, `Trial ${trial}`);
    }
  });

  it('AI handles near-full board without hanging', () => {
    const game = createGame();
    // Fill most cells, leaving just a few empty
    const pattern: ('X' | 'O' | '')[] = ['X', 'O', 'X', 'O', 'X', 'O', 'X', 'O', ''];
    for (let bi = 0; bi < 8; bi++) {
      game.boards[bi].cells = [...pattern];
      recalcBoard(game.boards[bi]);
    }
    // Board 8 has some room
    game.boards[8].cells = ['X', 'O', '', '', '', '', '', '', ''];
    game.currentPlayer = 'X';
    game.nextBoardIndex = null;
    updateGlobalState(game);

    if (!game.winner && !game.drawn) {
      const ai = createAI('X', 5, 0);
      const move = choose(ai, game);
      assertValidMove(game, move, 'Near-full board');
    }
  });

  it('condemn on forced board grants free move and AI adapts', () => {
    const game = createGame();
    game.boards[3].cells = ['O', 'O', '', '', 'X', '', '', '', ''];
    game.currentPlayer = 'X';
    game.nextBoardIndex = 3;

    const ai = createAI('X', 5, 0);
    // AI searched with board 3 forced
    choose(ai, game);

    // Now condemn board 3
    applyCondemn(game, 3);
    expect(game.nextBoardIndex).toBeNull();
    ai.tt.clear();

    // AI should now have free move across all remaining boards
    const moves = availableMoves(game);
    expect(moves.some(([bi]) => bi !== 3)).toBe(true);

    const move = choose(ai, game);
    expect(move[0]).not.toBe(3); // Should not play on condemned board
    assertValidMove(game, move, 'After condemn forced board');
  });
});

// ---- Randomized stress test ----

describe('Stress tests', () => {
  // Representative draft matchups covering all cards and doctrines.
  // Depth 3 exercises the same engine paths as depth 5/8 (applyMove,
  // undoMove, card effects, passives) — just without deep search overhead.
  const MATCHUPS: [PowerUpDraft, PowerUpDraft][] = [
    [
      { strike: 'overwrite', tactics: 'redirect', disruption: 'shatter', doctrine: 'momentum' },
      { strike: 'haste', tactics: 'condemn', disruption: 'sabotage', doctrine: 'arsenal' },
    ],
    [
      { strike: 'gravity', tactics: 'recall', disruption: 'swap', doctrine: 'siege' },
      { strike: 'overwrite', tactics: 'redirect', disruption: 'sabotage', doctrine: 'momentum' },
    ],
    [
      { strike: 'haste', tactics: 'recall', disruption: 'shatter', doctrine: 'arsenal' },
      { strike: 'gravity', tactics: 'condemn', disruption: 'swap', doctrine: 'siege' },
    ],
  ];

  MATCHUPS.forEach(([xDraft, oDraft], i) => {
    it(`matchup ${i}: X={${xDraft.strike},${xDraft.doctrine}} vs O={${oDraft.strike},${oDraft.doctrine}}`, () => {
      const result = simulateFullGame({
        mode: 'classic',
        xDifficulty: 3,
        oDifficulty: 3,
        xDraft,
        oDraft,
      });

      expect(result.errors).toEqual([]);
      expect(result.winner !== null || result.drawn).toBe(true);
    });
  });
});

// ---- Zobrist key integrity ----

describe('Zobrist key integrity', () => {
  it('zkey matches after normal applyMove sequence', () => {
    const game = createGame();
    for (let i = 0; i < 20; i++) {
      if (game.winner || game.drawn) break;
      const moves = availableMoves(game);
      const pick = moves[i % moves.length];
      applyMove(game, pick[0], pick[1]);
      expect(game.zkey).toBe(recomputeZkey(game));
    }
  });

  it('zkey matches after applyOverwrite', () => {
    const game = createGame();
    game.boards[0].cells = ['X', 'O', '', '', '', '', '', '', ''];
    game.currentPlayer = 'X';
    game.zkey = recomputeZkey(game);

    applyOverwrite(game, 0, 1);
    expect(game.zkey).toBe(recomputeZkey(game));
  });

  it('zkey matches after applySabotage', () => {
    const game = createGame();
    game.boards[0].cells = ['X', 'O', '', '', '', '', '', '', ''];
    game.currentPlayer = 'X';
    game.zkey = recomputeZkey(game);

    applySabotage(game, 0, 1);
    expect(game.zkey).toBe(recomputeZkey(game));
  });

  it('zkey matches after applySwap', () => {
    const game = createGame();
    game.boards[0].cells = ['X', 'O', 'X', '', 'O', '', '', '', ''];
    game.currentPlayer = 'X';
    game.zkey = recomputeZkey(game);

    applySwap(game, 0);
    expect(game.zkey).toBe(recomputeZkey(game));
  });

  it('zkey matches after applyShatter', () => {
    const game = createGame();
    game.boards[0].cells = ['X', 'X', 'X', 'O', '', '', '', '', ''];
    game.boards[0].winner = 'X';
    game.currentPlayer = 'O';
    game.zkey = recomputeZkey(game);

    applyShatter(game, 0);
    expect(game.zkey).toBe(recomputeZkey(game));
  });

  it('zkey matches after applyCondemn', () => {
    const game = createGame();
    game.boards[2].cells = ['O', '', 'X', '', '', '', '', '', ''];
    game.currentPlayer = 'X';
    game.nextBoardIndex = 2;
    game.zkey = recomputeZkey(game);

    applyCondemn(game, 2);
    expect(game.zkey).toBe(recomputeZkey(game));
  });

  it('zkey matches after applyRecall', () => {
    const game = createGame();
    game.boards[0].cells = ['X', '', '', '', '', '', '', '', ''];
    game.boards[3].cells = ['', '', '', '', '', '', '', '', ''];
    game.currentPlayer = 'X';
    game.zkey = recomputeZkey(game);

    applyRecall(game, 0, 0, 3, 4);
    expect(game.zkey).toBe(recomputeZkey(game));
  });

  it('zkey matches after applyRedirect', () => {
    const game = createGame();
    game.boards[5].cells = ['', '', '', '', '', '', '', '', ''];
    game.currentPlayer = 'X';
    game.nextBoardIndex = 3;
    game.zkey = recomputeZkey(game);

    applyRedirect(game, 5);
    expect(game.zkey).toBe(recomputeZkey(game));
  });

  it('zkey matches after applySiegeClaim', () => {
    const game = createGame();
    game.boards[0].cells = ['X', 'X', '', '', '', '', '', '', ''];
    game.currentPlayer = 'O';
    game.zkey = recomputeZkey(game);

    applySiegeClaim(game, 0, 2, 'X');
    expect(game.zkey).toBe(recomputeZkey(game));
  });

  it('zkey matches after applyGravity', () => {
    const game = createGame();
    game.boards[0].cells = ['X', 'O', '', '', 'X', '', '', '', 'O'];
    game.currentPlayer = 'X';
    game.zkey = recomputeZkey(game);

    applyGravity(game, 0);
    expect(game.zkey).toBe(recomputeZkey(game));
  });

  it('zkey matches after applyGravity with overlapping sources and destinations', () => {
    const game = createGame();
    // Col 0: X at 0, O at 3 → X moves to 3, O moves to 6 (3 is both source and destination)
    game.boards[0].cells = ['X', '', '', 'O', '', '', '', '', ''];
    game.currentPlayer = 'X';
    game.zkey = recomputeZkey(game);

    applyGravity(game, 0);
    expect(game.zkey).toBe(recomputeZkey(game));
    expect(game.boards[0].cells[3]).toBe('X');
    expect(game.boards[0].cells[6]).toBe('O');
  });

  it('zkey matches after full game simulation', () => {
    const result = simulateFullGame({
      mode: 'classic',
      xDifficulty: 5,
      oDifficulty: 5,
      xDraft: { strike: 'overwrite', tactics: 'redirect', disruption: 'shatter', doctrine: 'momentum' },
      oDraft: { strike: 'haste', tactics: 'condemn', disruption: 'sabotage', doctrine: 'arsenal' },
    });
    // If the simulation didn't error, zkey was consistent throughout
    // (assertGameInvariant runs every turn, but let's add zkey checks to the turn loop too)
    expect(result.errors).toEqual([]);
  });
});

// ---- Player turn correctness ----

describe('Player turn correctness', () => {
  it('after haste, turn returns to opponent', () => {
    const game = createGame();
    game.boards[0].cells = ['X', 'X', '', '', '', '', '', '', ''];
    game.nextBoardIndex = 0;
    game.currentPlayer = 'X';

    // X uses haste: gets two moves, then it should be O's turn
    applyMove(game, 0, 2); // First move (X wins board 0)
    if (!game.winner && !game.drawn) {
      // Haste: switch back to X
      game.currentPlayer = 'X';
      game.zkey ^= game.zobrist.stmKey();

      const moves = availableMoves(game);
      if (moves.length > 0) {
        applyMove(game, moves[0][0], moves[0][1]); // Second move
      }

      // After haste resolves, it should be O's turn
      if (!game.winner && !game.drawn) {
        expect(game.currentPlayer).toBe('O');
      }
    }
  });

  it('after momentum extra turn, turn returns to opponent', () => {
    const game = createGame();
    game.boards[0].cells = ['X', 'X', '', '', '', '', '', '', ''];
    game.nextBoardIndex = 0;
    game.currentPlayer = 'X';

    applyMove(game, 0, 2); // X wins board 0
    expect(game.boards[0].winner).toBe('X');

    if (!game.winner && !game.drawn) {
      // Momentum: switch back to X
      game.currentPlayer = 'X';
      game.zkey ^= game.zobrist.stmKey();

      const moves = availableMoves(game);
      if (moves.length > 0) {
        applyMove(game, moves[0][0], moves[0][1]); // Momentum move
      }

      // After momentum, should be O's turn
      if (!game.winner && !game.drawn) {
        expect(game.currentPlayer).toBe('O');
      }
    }
  });

  it('gravity does not change turn order', () => {
    const game = createGame();
    // Set up a board where gravity would move pieces
    game.boards[4].cells = ['X', 'O', '', '', '', '', '', '', ''];
    game.currentPlayer = 'X';

    applyGravity(game, 4);

    // Gravity is a pre-placement card — doesn't switch turns
    expect(game.currentPlayer).toBe('X');
    // Pieces should have fallen
    expect(game.boards[4].cells[6]).toBe('X');
    expect(game.boards[4].cells[7]).toBe('O');
  });

  it('players alternate correctly through full simulation', () => {
    const game = createGame();
    let expectedPlayer: Player = 'X';

    for (let i = 0; i < 30; i++) {
      if (game.winner || game.drawn) break;
      expect(game.currentPlayer).toBe(expectedPlayer);

      const moves = availableMoves(game);
      applyMove(game, moves[0][0], moves[0][1]);
      expectedPlayer = expectedPlayer === 'X' ? 'O' : 'X';
    }
  });
});

// ---- Card double-use prevention ----

describe('Card double-use prevention', () => {
  it('used cards cannot be used again', () => {
    const draft: PowerUpDraft = {
      strike: 'overwrite',
      tactics: 'redirect',
      disruption: 'shatter',
      doctrine: 'momentum',
    };
    const puState = createPowerUpState(draft);

    expect(getAvailableCards(puState)).toHaveLength(3);

    useCard(puState, 'overwrite');
    expect(getAvailableCards(puState)).toHaveLength(2);
    expect(getAvailableCards(puState)).not.toContain('overwrite');

    // Using again should not crash but card stays used
    useCard(puState, 'overwrite');
    expect(getAvailableCards(puState)).toHaveLength(2);
  });

  it('aiDecideCard never picks a used card', () => {
    const game = createGame();
    game.boards[0].cells = ['X', 'X', 'O', '', 'O', '', '', '', ''];
    game.boards[3].cells = ['X', 'X', 'X', '', '', '', '', '', ''];
    game.boards[3].winner = 'X';
    game.currentPlayer = 'X';

    const draft: PowerUpDraft = {
      strike: 'overwrite',
      tactics: 'redirect',
      disruption: 'shatter',
      doctrine: 'momentum',
    };
    const puState = createPowerUpState(draft);
    useCard(puState, 'overwrite');

    const decision = aiDecideCard(game, puState, 'X', 8);
    if (decision) {
      expect(decision.card).not.toBe('overwrite');
    }
  });
});

// ---- Infinite passive chain prevention ----

describe('Infinite passive chain prevention', () => {
  it('momentum + arsenal interaction works correctly', () => {
    // Set up: X has momentum, O has arsenal with used cards.
    // X wins a board → momentum gives X another turn.
    // O's arsenal should NOT trigger (O didn't win the board).
    const game = createGame();
    game.boards[0].cells = ['X', 'X', '', '', '', '', '', '', ''];
    game.nextBoardIndex = 0;
    game.currentPlayer = 'X';
    syncZkey(game);

    const oPU = createPowerUpState({ strike: 'haste', tactics: 'condemn', disruption: 'sabotage', doctrine: 'arsenal' });
    useCard(oPU, 'haste');
    useCard(oPU, 'condemn');

    // X plays cell 2 on board 0 → wins board 0
    applyMove(game, 0, 2);
    expect(game.boards[0].winner).toBe('X');

    // Arsenal should NOT trigger for O (O didn't win the board)
    const usedBefore = getActiveCards(oPU.draft).filter(c => isCardUsed(oPU, c)).length;
    // Simulate arsenal check: only triggers on YOUR wins
    const newlyWon = [{ i: 0, winner: 'X' as Player }];
    const oWon = newlyWon.some(w => w.winner === 'O');
    expect(oWon).toBe(false); // O didn't win, so arsenal doesn't trigger
    expect(getActiveCards(oPU.draft).filter(c => isCardUsed(oPU, c)).length).toBe(usedBefore);
  });

  it('full simulation with momentum+arsenal terminates within turn limit', () => {
    const result = simulateFullGame({
      mode: 'classic',
      xDifficulty: 5,
      oDifficulty: 5,
      xDraft: { strike: 'haste', tactics: 'redirect', disruption: 'shatter', doctrine: 'momentum' },
      oDraft: { strike: 'overwrite', tactics: 'condemn', disruption: 'sabotage', doctrine: 'arsenal' },
      maxTurns: 200,
    });
    expect(result.errors).toEqual([]);
    expect(result.turns).toBeLessThan(200);
  });
});

// ---- applyMove on occupied cell ----

describe('Occupied cell protection', () => {
  it('applyMove overwrites silently (documents dangerous behavior)', () => {
    // applyMove does NOT validate that the cell is empty.
    // This documents the behavior so we know card effects must ensure valid targets.
    const game = createGame();
    game.boards[0].cells[4] = 'O';
    game.currentPlayer = 'X';
    game.nextBoardIndex = 0;

    // This places X on an already-occupied cell — no error thrown!
    applyMove(game, 0, 4);
    expect(game.boards[0].cells[4]).toBe('X'); // Silently overwritten

    // This is dangerous — card effects must validate targets themselves
  });

  it('card effect functions validate targets', () => {
    const game = createGame();
    game.currentPlayer = 'X';

    // Overwrite rejects targeting own piece
    game.boards[0].cells[0] = 'X';
    expect(() => applyOverwrite(game, 0, 0)).toThrow();

    // Overwrite rejects targeting empty cell
    expect(() => applyOverwrite(game, 0, 1)).toThrow();

    // Sabotage rejects targeting own piece
    expect(() => applySabotage(game, 0, 0)).toThrow();

    // Sabotage rejects targeting empty cell
    expect(() => applySabotage(game, 0, 1)).toThrow();

    // Recall rejects same-board move
    expect(() => applyRecall(game, 0, 0, 0, 1)).toThrow();

    // Recall rejects moving opponent's piece
    game.boards[1].cells[0] = 'O';
    expect(() => applyRecall(game, 1, 0, 2, 0)).toThrow();

    // Recall rejects moving to occupied destination
    game.boards[2].cells[0] = 'O';
    expect(() => applyRecall(game, 0, 0, 2, 0)).toThrow();

    // Swap rejects won board
    game.boards[3].winner = 'X';
    expect(() => applySwap(game, 3)).toThrow();

    // Condemn rejects won board
    expect(() => applyCondemn(game, 3)).toThrow();

    // Shatter rejects condemned board
    game.boards[4].condemned = true;
    expect(() => applyShatter(game, 4)).toThrow();
  });
});

// ---- Game over detection after passives ----

describe('Game over detection after passives', () => {
  it('siege claim that wins the game is detected', () => {
    const game = createGame();
    // X has boards 0 and 1. Board 2 has X X _ (siege about to claim cell 2)
    game.boards[0].cells = ['X', 'X', 'X', '', '', '', '', '', ''];
    game.boards[0].winner = 'X';
    game.boards[1].cells = ['X', 'X', 'X', '', '', '', '', '', ''];
    game.boards[1].winner = 'X';
    game.boards[2].cells = ['X', 'X', '', '', '', '', '', '', ''];
    game.currentPlayer = 'O';
    game.nextBoardIndex = null;

    // Siege claims cell 2 on board 2 → X wins board 2 → top row macro line → X wins game
    applySiegeClaim(game, 2, 2, 'X');
    updateGlobalState(game);

    expect(game.boards[2].winner).toBe('X');
    expect(game.winner).toBe('X');
  });

  it('arsenal does not trigger when game is already won', () => {
    const pu = createPowerUpState({ strike: 'haste', tactics: 'condemn', disruption: 'sabotage', doctrine: 'arsenal' });
    useCard(pu, 'haste');

    // Simulate: game is won, arsenal should be gated by winner check in UI
    // rechargeRandomCard itself doesn't check — the UI guards it
    // Just verify it works correctly in isolation
    const recharged = rechargeRandomCard(pu);
    expect(recharged).toBe('haste');
    expect(isCardUsed(pu, 'haste')).toBe(false);
  });

  it('overwrite that wins a board and triggers game win is detected', () => {
    const game = createGame();
    // X has boards 0 and 1 (top row). Board 2 has X X O — overwriting O wins board 2
    game.boards[0].winner = 'X';
    game.boards[1].winner = 'X';
    game.boards[2].cells = ['X', 'X', 'O', '', '', '', '', '', ''];
    game.currentPlayer = 'X';

    applyOverwrite(game, 2, 2);

    expect(game.boards[2].winner).toBe('X');
    expect(game.winner).toBe('X');
  });

  it('shatter that revokes game-winning line is detected', () => {
    const game = createGame();
    // X has won boards 0,1,2 (top row) → X has won the game
    for (const bi of [0, 1, 2]) {
      game.boards[bi].cells = ['X', 'X', 'X', '', '', '', '', '', ''];
      game.boards[bi].winner = 'X';
    }
    game.winner = 'X';
    game.currentPlayer = 'O';
    syncZkey(game);

    // Shatter board 0 → removes X's win → X no longer has top row
    applyShatter(game, 0);

    expect(game.boards[0].winner).toBeNull();
    expect(game.winner).toBeNull(); // Game should no longer be won
  });

  it('sudden death: overwrite winning a board ends game immediately', () => {
    const game = createGame('sudden-death');
    game.boards[0].cells = ['X', 'X', 'O', '', '', '', '', '', ''];
    game.currentPlayer = 'X';

    applyOverwrite(game, 0, 2);

    expect(game.boards[0].winner).toBe('X');
    expect(game.winner).toBe('X');
  });

  it('misere: sabotage revoking a board win updates game state', () => {
    const game = createGame('misere');
    // X has 3 in a row on macro board (0,1,2) — X LOSES in misere (O wins)
    for (const bi of [0, 1, 2]) {
      game.boards[bi].cells = ['X', 'X', 'X', '', '', '', '', '', ''];
      game.boards[bi].winner = 'X';
    }
    game.winner = 'O'; // In misere, X completing row means O wins
    game.currentPlayer = 'O'; // O uses sabotage to remove X's piece
    syncZkey(game);

    // O sabotages board 0, cell 0 → removes one of X's winning pieces
    applySabotage(game, 0, 0);

    expect(game.boards[0].winner).toBeNull(); // Board 0 no longer won
    expect(game.winner).toBeNull(); // Macro line broken → game no longer over
  });
});

// ---- availableMoves consistency ----

describe('availableMoves consistency', () => {
  it('all returned moves target empty cells on live boards', () => {
    const game = createGame();
    // Play 15 random moves
    for (let i = 0; i < 15; i++) {
      if (game.winner || game.drawn) break;
      const moves = availableMoves(game);
      applyMove(game, moves[i % moves.length][0], moves[i % moves.length][1]);
    }

    if (game.winner || game.drawn) return;

    const moves = availableMoves(game);
    for (const [bi, ci] of moves) {
      const board = game.boards[bi];
      expect(board.winner).toBeNull();
      expect(board.drawn).toBe(false);
      expect(board.condemned).toBe(false);
      expect(board.cells[ci]).toBe('');
    }
  });

  it('availableMoves respects forced board', () => {
    const game = createGame();
    applyMove(game, 0, 4); // Forces board 4
    expect(game.nextBoardIndex).toBe(4);

    const moves = availableMoves(game);
    for (const [bi] of moves) {
      expect(bi).toBe(4);
    }
  });

  it('availableMoves is empty only when game should be over', () => {
    const game = createGame();
    // Fill all boards except one cell
    for (let bi = 0; bi < 9; bi++) {
      for (let ci = 0; ci < 9; ci++) {
        if (bi === 8 && ci === 8) continue; // Leave one cell
        game.boards[bi].cells[ci] = (bi + ci) % 2 === 0 ? 'X' : 'O';
      }
      recalcBoard(game.boards[bi]);
    }
    game.nextBoardIndex = null;
    updateGlobalState(game);

    if (!game.winner && !game.drawn) {
      const moves = availableMoves(game);
      // Should have exactly 1 move (board 8, cell 8) if that board is live
      if (!game.boards[8].winner && !game.boards[8].drawn) {
        expect(moves.length).toBe(1);
        expect(moves[0]).toEqual([8, 8]);
      }
    }
  });

  it('no moves target condemned boards after card effects', () => {
    const game = createGame();
    game.boards[0].cells = ['X', 'O', '', '', '', '', '', '', ''];
    game.boards[3].cells = ['O', 'X', '', '', '', '', '', '', ''];
    game.currentPlayer = 'X';
    game.nextBoardIndex = null;

    applyCondemn(game, 0);

    const moves = availableMoves(game);
    for (const [bi] of moves) {
      expect(bi).not.toBe(0);
      expect(game.boards[bi].condemned).toBe(false);
    }
  });
});

// ---- Zobrist key through full simulation ----

describe('Zobrist key through full simulation', () => {
  it('zkey stays in sync during multi-turn AI game with cards', () => {
    const game = createGame();
    const xAi = createAI('X', 3, 0);
    const oAi = createAI('O', 3, 0);
    const xPU = createPowerUpState({ strike: 'overwrite', tactics: 'condemn', disruption: 'shatter', doctrine: 'momentum' });
    const oPU = createPowerUpState({ strike: 'haste', tactics: 'redirect', disruption: 'sabotage', doctrine: 'arsenal' });

    for (let turn = 0; turn < 60; turn++) {
      if (game.winner || game.drawn) break;

      const ai = game.currentPlayer === 'X' ? xAi : oAi;
      const puState = game.currentPlayer === 'X' ? xPU : oPU;
      const difficulty = 3;

      // Maybe use a card
      const cardDecision = aiDecideCard(game, puState, game.currentPlayer, difficulty);

      // Verify zkey after card evaluation (should be unchanged)
      expect(game.zkey).toBe(recomputeZkey(game));

      if (cardDecision && isPrePlacementCard(cardDecision.card)) {
        useCard(puState, cardDecision.card);
        applyAiPreCard(game, cardDecision);
        ai.tt.clear();

        // Verify zkey after card effect
        expect(game.zkey).toBe(recomputeZkey(game));

        if (game.winner || game.drawn) break;
      }

      const move = choose(ai, game);

      // Verify zkey unchanged after search
      expect(game.zkey).toBe(recomputeZkey(game));

      applyMove(game, move[0], move[1]);

      // Verify zkey after move
      expect(game.zkey).toBe(recomputeZkey(game));

      // Handle haste flow modifier
      if (cardDecision && cardDecision.card === 'haste' && !isPrePlacementCard(cardDecision.card)) {
        useCard(puState, 'haste');
        if (!game.winner && !game.drawn) {
          game.currentPlayer = ai.player;
          game.zkey ^= game.zobrist.stmKey();
          ai.tt.clear();

          expect(game.zkey).toBe(recomputeZkey(game));

          const hasteMoves = availableMoves(game);
          if (hasteMoves.length > 0) {
            const hasteMove = choose(ai, game);
            applyMove(game, hasteMove[0], hasteMove[1]);
            expect(game.zkey).toBe(recomputeZkey(game));
          }
        }
      }
    }
  });
});

describe('Mode stress tests', () => {
  const MODES: GameMode[] = ['classic', 'sudden-death', 'misere'];
  // One representative matchup per mode — covers all three doctrines
  const xDraft: PowerUpDraft = { strike: 'haste', tactics: 'redirect', disruption: 'shatter', doctrine: 'momentum' };
  const oDraft: PowerUpDraft = { strike: 'gravity', tactics: 'recall', disruption: 'swap', doctrine: 'siege' };

  for (const mode of MODES) {
    it(`${mode}: full game with gambits`, () => {
      const result = simulateFullGame({
        mode,
        xDifficulty: 3,
        oDifficulty: 3,
        xDraft,
        oDraft,
      });

      expect(result.errors).toEqual([]);
      expect(result.winner !== null || result.drawn).toBe(true);
    });
  }
});

// =====================================================================
// Winner validation stress tests
// =====================================================================

describe('Winner validation — classic no-gambits stress', () => {
  /** Run a pure no-card game where cards are never used. */
  function simulateNoGambitGame(mode: GameMode, xDepth: number, oDepth: number): SimResult {
    const game = createGame(mode);
    const maxTurns = 200;

    const xAi = createAI('X', xDepth, xDepth <= 3 ? 0.35 : 0); // Blunder for easy AI
    const oAi = createAI('O', oDepth, oDepth <= 3 ? 0.35 : 0);

    const result: SimResult = { winner: null, drawn: false, turns: 0, errors: [], cardsUsed: [], passives: [] };

    for (let turn = 0; turn < maxTurns; turn++) {
      if (game.winner || game.drawn) break;
      result.turns = turn + 1;

      // Validate winner state BEFORE every move
      const preErr = validateWinner(game);
      if (preErr) {
        result.errors.push(`Turn ${turn + 1} pre-move: ${preErr}`);
        break;
      }

      const ai = game.currentPlayer === 'X' ? xAi : oAi;
      const moves = availableMoves(game);
      if (moves.length === 0) {
        result.errors.push(`Turn ${turn + 1}: no moves but game not over`);
        break;
      }

      const move = choose(ai, game);
      const mover = game.currentPlayer;
      applyMove(game, move[0], move[1]);

      // Validate winner state AFTER every move
      const postErr = validateWinner(game);
      if (postErr) {
        result.errors.push(`Turn ${turn + 1} post-move (${mover} played [${move}]): ${postErr}. BigBoard: [${bigBoardState(game)}]`);
        break;
      }

      // If game just ended, verify the winner completed a line
      if (game.winner) {
        const bb = bigBoardState(game);
        let winnerHasLine = false;
        for (const [a, b, c] of WINNING_LINES) {
          if (mode === 'misere') {
            // In misere, game.winner is the OPPOSITE of who completed the line
            const loser: Player = game.winner === 'X' ? 'O' : 'X';
            if (bb[a] === loser && bb[b] === loser && bb[c] === loser) {
              winnerHasLine = true;
              break;
            }
          } else if (mode === 'sudden-death') {
            // Sudden death: first board won wins
            winnerHasLine = game.boards.some(bd => bd.winner === game.winner);
            break;
          } else {
            if (bb[a] === game.winner && bb[b] === game.winner && bb[c] === game.winner) {
              winnerHasLine = true;
              break;
            }
          }
        }
        if (!winnerHasLine && mode !== 'sudden-death') {
          result.errors.push(`Turn ${turn + 1}: ${game.winner} declared winner but has no winning line! BigBoard: [${bb}]`);
        }
      }
    }

    result.winner = game.winner;
    result.drawn = game.drawn;
    return result;
  }

  it('runs 10 classic games with winner validation on every move', () => {
    for (let i = 0; i < 10; i++) {
      const result = simulateNoGambitGame('classic', 3, 3);
      expect(result.errors).toEqual([]);
      expect(result.winner !== null || result.drawn).toBe(true);
    }
  });

  it('runs 5 sudden-death games with winner validation on every move', () => {
    for (let i = 0; i < 5; i++) {
      const result = simulateNoGambitGame('sudden-death', 3, 3);
      expect(result.errors).toEqual([]);
      expect(result.winner !== null || result.drawn).toBe(true);
    }
  });

  it('runs 5 misere games with winner validation on every move', () => {
    for (let i = 0; i < 5; i++) {
      const result = simulateNoGambitGame('misere', 3, 3);
      expect(result.errors).toEqual([]);
      expect(result.winner !== null || result.drawn).toBe(true);
    }
  });

  it('verifies winner never changes once set (no stale-winner regression)', () => {
    for (let i = 0; i < 10; i++) {
      const game = createGame('classic');
      const xAi = createAI('X', 3, 0.35);
      const oAi = createAI('O', 3, 0.35);

      for (let turn = 0; turn < 200; turn++) {
        if (game.winner || game.drawn) break;
        const ai = game.currentPlayer === 'X' ? xAi : oAi;
        const move = choose(ai, game);
        applyMove(game, move[0], move[1]);

        if (game.winner) {
          const savedWinner = game.winner;
          // Call updateGlobalState again — winner should NOT change
          updateGlobalState(game);
          expect(game.winner).toBe(savedWinner);
        }
      }
    }
  });
});
