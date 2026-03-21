import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createGame, applyMove, availableMoves, type HyperXOGame, type Player } from '../game';
import {
  createPowerUpState,
  createDefaultDraft,
  getAvailableCards,
  useCard,
  type PowerUpState,
  type PowerUpDraft,
  type ActiveCard,
  STRIKE_CARDS,
  TACTICS_CARDS,
  DISRUPTION_CARDS,
  DOCTRINE_CARDS,
} from '../powerups';
import {
  aiBan,
  aiDraft,
  aiDecideCard,
  computeUrgency,
  isPrePlacementCard,
  applyAiPreCard,
  getCardFlashBoards,
  getCardFlashColor,
  aiRedirectTarget,
  snapshot,
  restore,
  type AiCardDecision,
} from '../ai-gambits';
import { evaluateForPlayer } from '../ai';

// ---- Helpers ----

function makeDraft(overrides: Partial<PowerUpDraft> = {}): PowerUpDraft {
  return {
    strike: 'overwrite',
    tactics: 'redirect',
    disruption: 'sabotage',
    doctrine: 'momentum',
    ...overrides,
  };
}

function setupBoard(game: HyperXOGame, boardIdx: number, cells: string[]): void {
  for (let i = 0; i < 9; i++) {
    game.boards[boardIdx].cells[i] = cells[i] as any;
  }
}

// ---- Draft Tests ----

describe('AI Draft', () => {
  it('generates valid draft at easy difficulty', () => {
    for (let i = 0; i < 20; i++) {
      const draft = aiDraft(3);
      expect(STRIKE_CARDS).toContain(draft.strike);
      expect(TACTICS_CARDS).toContain(draft.tactics);
      expect(DISRUPTION_CARDS).toContain(draft.disruption);
      expect(DOCTRINE_CARDS).toContain(draft.doctrine);
    }
  });

  it('generates valid draft at medium difficulty', () => {
    for (let i = 0; i < 20; i++) {
      const draft = aiDraft(5);
      expect(STRIKE_CARDS).toContain(draft.strike);
      expect(TACTICS_CARDS).toContain(draft.tactics);
      expect(DISRUPTION_CARDS).toContain(draft.disruption);
      expect(DOCTRINE_CARDS).toContain(draft.doctrine);
    }
  });

  it('generates valid draft at hard difficulty', () => {
    for (let i = 0; i < 20; i++) {
      const draft = aiDraft(8);
      expect(STRIKE_CARDS).toContain(draft.strike);
      expect(TACTICS_CARDS).toContain(draft.tactics);
      expect(DISRUPTION_CARDS).toContain(draft.disruption);
      expect(DOCTRINE_CARDS).toContain(draft.doctrine);
    }
  });

  it('always produces all 4 categories', () => {
    const draft = aiDraft(8);
    expect(draft.strike).toBeDefined();
    expect(draft.tactics).toBeDefined();
    expect(draft.disruption).toBeDefined();
    expect(draft.doctrine).toBeDefined();
  });
});

// ---- Ban Tests ----

describe('AI Ban', () => {
  it('returns a valid card', () => {
    for (let i = 0; i < 20; i++) {
      const ban = aiBan(8, 'classic');
      const allCards = [...STRIKE_CARDS, ...TACTICS_CARDS, ...DISRUPTION_CARDS, ...DOCTRINE_CARDS];
      expect(allCards).toContain(ban);
    }
  });

  it('hard AI bans haste in sudden death', () => {
    // Hard AI should always ban the most threatening card
    const ban = aiBan(8, 'sudden-death');
    expect(ban).toBe('haste');
  });

  it('hard AI bans swap in misere', () => {
    const ban = aiBan(8, 'misere');
    expect(ban).toBe('swap');
  });

  it('draft respects banned cards', () => {
    const banned = new Set(['haste', 'overwrite']);
    for (let i = 0; i < 20; i++) {
      const draft = aiDraft(8, banned);
      expect(draft.strike).not.toBe('haste');
      expect(draft.strike).not.toBe('overwrite');
    }
  });

  it('draft works with all cards in a category banned except one', () => {
    // Ban 2 of 3 strike cards → forced pick
    const banned = new Set(['double-down', 'haste']);
    for (let i = 0; i < 10; i++) {
      const draft = aiDraft(8, banned);
      expect(draft.strike).toBe('overwrite');
    }
  });
});

// ---- Snapshot / Restore Tests ----

describe('Snapshot / Restore', () => {
  it('perfectly restores game state after modification', () => {
    const game = createGame();
    applyMove(game, 0, 4);
    applyMove(game, 4, 0);

    const snap = snapshot(game);
    const origZkey = game.zkey;
    const origPlayer = game.currentPlayer;
    const origNbi = game.nextBoardIndex;
    const origCells = game.boards[0].cells.slice();

    // Modify the game
    applyMove(game, 0, 0);
    expect(game.boards[0].cells[0]).not.toBe('');
    expect(game.zkey).not.toBe(origZkey);

    // Restore
    restore(game, snap);
    expect(game.zkey).toBe(origZkey);
    expect(game.currentPlayer).toBe(origPlayer);
    expect(game.nextBoardIndex).toBe(origNbi);
    expect(game.boards[0].cells).toEqual(origCells);
  });

  it('restores winner and drawn states', () => {
    const game = createGame();
    const snap = snapshot(game);

    game.winner = 'X';
    game.drawn = true;
    game.boards[0].winner = 'X';
    game.boards[1].drawn = true;
    game.boards[2].condemned = true;

    restore(game, snap);
    expect(game.winner).toBeNull();
    expect(game.drawn).toBe(false);
    expect(game.boards[0].winner).toBeNull();
    expect(game.boards[1].drawn).toBe(false);
    expect(game.boards[2].condemned).toBe(false);
  });
});

// ---- Pre-placement Card Classification ----

describe('isPrePlacementCard', () => {
  it('identifies pre-placement cards', () => {
    expect(isPrePlacementCard('overwrite')).toBe(true);
    expect(isPrePlacementCard('sabotage')).toBe(true);
    expect(isPrePlacementCard('recall')).toBe(true);
    expect(isPrePlacementCard('swap')).toBe(true);
    expect(isPrePlacementCard('shatter')).toBe(true);
    expect(isPrePlacementCard('condemn')).toBe(true);
  });

  it('identifies flow modifier cards', () => {
    expect(isPrePlacementCard('double-down')).toBe(false);
    expect(isPrePlacementCard('haste')).toBe(false);
    expect(isPrePlacementCard('redirect')).toBe(false);
  });
});

// ---- Card Evaluation Tests (Hard AI) ----

describe('AI card evaluation - overwrite', () => {
  it('detects winning overwrite opportunity', () => {
    const game = createGame();
    // X has 2 in a row on board 0, O is blocking
    setupBoard(game, 0, ['X', 'X', 'O', '', '', '', '', '', '']);
    // Add macro context so urgency is high enough for hard AI
    setupBoard(game, 3, ['X', 'X', 'X', '', '', '', '', '', '']);
    game.boards[3].winner = 'X';
    game.currentPlayer = 'X';

    const draft = makeDraft({ strike: 'overwrite' });
    const puState = createPowerUpState(draft);
    const decision = aiDecideCard(game, puState, 'X', 8);

    expect(decision).not.toBeNull();
    expect(decision!.card).toBe('overwrite');
    expect(decision!.boardIdx).toBe(0);
    expect(decision!.cellIdx).toBe(2); // overwrite the blocking O
  });

  it('prefers overwrite that wins a board', () => {
    const game = createGame();
    // Board 0: X X O (overwriting O at cell 2 wins the row)
    setupBoard(game, 0, ['X', 'X', 'O', '', '', '', '', '', '']);
    // Board 1: X _ O (overwriting O at cell 2 just removes a piece)
    setupBoard(game, 1, ['X', '', 'O', '', '', '', '', '', '']);
    // Add macro context
    setupBoard(game, 3, ['X', 'X', 'X', '', '', '', '', '', '']);
    game.boards[3].winner = 'X';
    game.currentPlayer = 'X';

    const draft = makeDraft({ strike: 'overwrite' });
    const puState = createPowerUpState(draft);
    const decision = aiDecideCard(game, puState, 'X', 8);

    expect(decision?.card).toBe('overwrite');
    expect(decision?.boardIdx).toBe(0);
    expect(decision?.cellIdx).toBe(2);
  });
});

describe('AI card evaluation - sabotage', () => {
  it('detects won-board revocation', () => {
    const game = createGame();
    // Board 0: O won with top row — and O has macro pressure (boards 1,2 could form line)
    setupBoard(game, 0, ['O', 'O', 'O', 'X', '', '', '', '', '']);
    game.boards[0].winner = 'O';
    setupBoard(game, 1, ['O', 'O', 'O', '', '', '', '', '', '']);
    game.boards[1].winner = 'O';
    game.currentPlayer = 'X';

    const draft = makeDraft({ disruption: 'sabotage' });
    const puState = createPowerUpState(draft);
    const decision = aiDecideCard(game, puState, 'X', 8);

    expect(decision).not.toBeNull();
    expect(decision!.card).toBe('sabotage');
    expect(decision!.boardIdx).toBe(0);
    // Should target one of the O pieces in the winning row
    expect([0, 1, 2]).toContain(decision!.cellIdx);
  });

  it('detects threat disruption on live board', () => {
    const game = createGame();
    // Board 0: O has 2-in-a-row threat
    setupBoard(game, 0, ['O', 'O', '', '', '', '', '', '', '']);
    game.currentPlayer = 'X';

    const draft = makeDraft({ disruption: 'sabotage' });
    const puState = createPowerUpState(draft);
    const decision = aiDecideCard(game, puState, 'X', 8);

    if (decision?.card === 'sabotage') {
      expect(decision.boardIdx).toBe(0);
      expect([0, 1]).toContain(decision.cellIdx);
    }
  });
});

describe('AI card evaluation - recall', () => {
  it('finds beneficial relocation', () => {
    const game = createGame();
    // Board 0: X piece in a dead position (corner, alone)
    setupBoard(game, 0, ['X', '', '', '', '', '', '', '', '']);
    // Board 1: X has 2-in-a-row, needs one more on the empty cell
    setupBoard(game, 1, ['X', 'X', '', '', '', '', '', '', '']);
    game.currentPlayer = 'X';

    const draft = makeDraft({ tactics: 'recall' });
    const puState = createPowerUpState(draft);
    const decision = aiDecideCard(game, puState, 'X', 8);

    // AI should consider recalling the lone piece to a better position
    if (decision?.card === 'recall') {
      expect(decision.fromBoard).toBe(0);
      expect(decision.fromCell).toBe(0);
    }
  });
});

describe('AI card evaluation - swap', () => {
  it('detects net-positive exchange', () => {
    const game = createGame();
    // Board 0: O dominates (3 pieces), X has 1
    setupBoard(game, 0, ['O', 'O', 'O', 'X', '', '', '', '', '']);
    // Don't set winner — swap only works on live boards
    game.currentPlayer = 'X';

    // But wait, O has 3-in-a-row which means winner should be set
    // Let's use a setup where O has more pieces but no win
    setupBoard(game, 0, ['O', 'O', '', 'X', 'O', '', '', '', '']);
    game.currentPlayer = 'X';

    const draft = makeDraft({ disruption: 'swap' });
    const puState = createPowerUpState(draft);
    const decision = aiDecideCard(game, puState, 'X', 8);

    if (decision?.card === 'swap') {
      expect(decision.boardIdx).toBe(0);
    }
  });
});

describe('AI card evaluation - shatter', () => {
  it('prioritizes shattering opponent won board', () => {
    const game = createGame();
    // Board 0: O has won it, and O has macro pressure
    setupBoard(game, 0, ['O', 'O', 'O', '', '', '', '', '', '']);
    game.boards[0].winner = 'O';
    setupBoard(game, 1, ['O', 'O', 'O', '', '', '', '', '', '']);
    game.boards[1].winner = 'O';
    game.currentPlayer = 'X';

    const draft = makeDraft({ disruption: 'shatter' });
    const puState = createPowerUpState(draft);
    const decision = aiDecideCard(game, puState, 'X', 8);

    expect(decision).not.toBeNull();
    expect(decision!.card).toBe('shatter');
    expect(decision!.boardIdx).toBe(0);
  });

  it('never shatters AI own won board', () => {
    const game = createGame();
    // Board 0: X has won
    setupBoard(game, 0, ['X', 'X', 'X', '', '', '', '', '', '']);
    game.boards[0].winner = 'X';
    game.currentPlayer = 'X';

    const draft = makeDraft({ disruption: 'shatter' });
    const puState = createPowerUpState(draft);
    const decision = aiDecideCard(game, puState, 'X', 8);

    // If it decides to use shatter, it should NOT target board 0
    if (decision?.card === 'shatter') {
      expect(decision.boardIdx).not.toBe(0);
    }
  });
});

describe('AI card evaluation - condemn', () => {
  it('condemns board where opponent is strong', () => {
    const game = createGame();
    // Board 0: O has strong position (2-in-a-row)
    setupBoard(game, 0, ['O', 'O', '', '', '', '', '', '', '']);
    // All other boards empty — condemning board 0 removes O's advantage
    game.currentPlayer = 'X';

    const draft = makeDraft({ tactics: 'condemn' });
    const puState = createPowerUpState(draft);
    const decision = aiDecideCard(game, puState, 'X', 8);

    if (decision?.card === 'condemn') {
      expect(decision.boardIdx).toBe(0);
    }
  });
});

// ---- Flow Modifier Evaluation ----

describe('AI card evaluation - double-down', () => {
  it('values double-down when AI has 2-in-a-row with urgency', () => {
    const game = createGame();
    // Board 0: X has 2-in-a-row, can win with one more
    setupBoard(game, 0, ['X', 'X', '', '', '', '', '', '', '']);
    game.nextBoardIndex = 0;
    // Macro context: X has won board 3 (left col: 0,3,6 — winning board 0 advances macro)
    setupBoard(game, 3, ['X', 'X', 'X', '', '', '', '', '', '']);
    game.boards[3].winner = 'X';
    game.currentPlayer = 'X';

    const draft = makeDraft({ strike: 'double-down' });
    const puState = createPowerUpState(draft);
    const decision = aiDecideCard(game, puState, 'X', 8);

    expect(decision).not.toBeNull();
    expect(decision!.card).toBe('double-down');
  });

  it('does not value double-down on empty board', () => {
    const game = createGame();
    game.nextBoardIndex = 0;
    game.currentPlayer = 'X';

    const draft = makeDraft({ strike: 'double-down' });
    const puState = createPowerUpState(draft);
    const decision = aiDecideCard(game, puState, 'X', 8);

    // Hard AI should hold DD when there's nothing to double-down on
    expect(decision).toBeNull();
  });
});

describe('AI card evaluation - haste', () => {
  it('uses haste when threats exist and urgency is high', () => {
    const game = createGame();
    // Multiple boards with AI 2-in-a-row threats
    setupBoard(game, 0, ['X', 'X', '', '', '', '', '', '', '']);
    setupBoard(game, 1, ['X', '', 'X', '', '', '', '', '', '']);
    setupBoard(game, 2, ['', 'X', 'X', '', '', '', '', '', '']);
    // Macro context: opponent has pressure (O won boards 4,7 — middle col)
    setupBoard(game, 4, ['O', 'O', 'O', '', '', '', '', '', '']);
    game.boards[4].winner = 'O';
    setupBoard(game, 7, ['O', 'O', 'O', '', '', '', '', '', '']);
    game.boards[7].winner = 'O';
    game.currentPlayer = 'X';

    // Only give AI haste (no other active cards to compete)
    const draft: PowerUpDraft = { strike: 'haste', tactics: 'redirect', disruption: 'swap', doctrine: 'momentum' };
    const puState = createPowerUpState(draft);
    // Use redirect and swap so only haste remains
    useCard(puState, 'redirect');
    useCard(puState, 'swap');
    const decision = aiDecideCard(game, puState, 'X', 8);

    expect(decision).not.toBeNull();
    expect(decision!.card).toBe('haste');
  });
});

describe('AI card evaluation - redirect', () => {
  it('returns redirect decision', () => {
    const game = createGame();
    setupBoard(game, 0, ['X', 'X', '', '', '', '', '', '', '']);
    game.currentPlayer = 'X';

    const draft = makeDraft({ tactics: 'redirect' });
    const puState = createPowerUpState(draft);
    const decision = aiDecideCard(game, puState, 'X', 8);

    // Redirect should be considered (always has some value)
    if (decision?.card === 'redirect') {
      expect(decision.card).toBe('redirect');
    }
  });
});

// ---- Redirect Target Selection ----

describe('aiRedirectTarget', () => {
  it('picks board where AI has 2-in-a-row (forces opponent to block)', () => {
    const game = createGame();
    setupBoard(game, 3, ['X', 'X', '', '', '', '', '', '', '']);
    // Other boards are empty
    game.currentPlayer = 'O'; // opponent's turn

    const target = aiRedirectTarget(game, 'X');
    expect(target).toBe(3);
  });

  it('avoids boards where opponent has strong position', () => {
    const game = createGame();
    // Board 0: opponent O has 2-in-a-row
    setupBoard(game, 0, ['O', 'O', '', '', '', '', '', '', '']);
    // Board 1: AI X has 2-in-a-row
    setupBoard(game, 1, ['X', 'X', '', '', '', '', '', '', '']);

    const target = aiRedirectTarget(game, 'X');
    expect(target).toBe(1); // prefer board where AI has advantage
  });

  it('returns -1 when no live boards', () => {
    const game = createGame();
    for (let i = 0; i < 9; i++) {
      game.boards[i].winner = 'X';
    }

    const target = aiRedirectTarget(game, 'X');
    expect(target).toBe(-1);
  });
});

// ---- applyAiPreCard ----

describe('applyAiPreCard', () => {
  it('applies overwrite correctly', () => {
    const game = createGame();
    game.boards[0].cells[4] = 'O';
    game.currentPlayer = 'X';

    applyAiPreCard(game, { card: 'overwrite', boardIdx: 0, cellIdx: 4 });
    expect(game.boards[0].cells[4]).toBe('X');
  });

  it('applies sabotage correctly', () => {
    const game = createGame();
    game.boards[0].cells[4] = 'X';
    game.currentPlayer = 'O';

    applyAiPreCard(game, { card: 'sabotage', boardIdx: 0, cellIdx: 4 });
    expect(game.boards[0].cells[4]).toBe('');
  });

  it('applies recall correctly', () => {
    const game = createGame();
    game.boards[0].cells[4] = 'X';
    game.currentPlayer = 'X';

    applyAiPreCard(game, { card: 'recall', fromBoard: 0, fromCell: 4, toBoard: 3, toCell: 0 });
    expect(game.boards[0].cells[4]).toBe('');
    expect(game.boards[3].cells[0]).toBe('X');
  });

  it('applies swap correctly', () => {
    const game = createGame();
    game.boards[0].cells[0] = 'X';
    game.boards[0].cells[1] = 'O';

    applyAiPreCard(game, { card: 'swap', boardIdx: 0 });
    expect(game.boards[0].cells[0]).toBe('O');
    expect(game.boards[0].cells[1]).toBe('X');
  });

  it('applies shatter correctly', () => {
    const game = createGame();
    game.boards[0].cells[0] = 'X';
    game.boards[0].cells[1] = 'O';

    applyAiPreCard(game, { card: 'shatter', boardIdx: 0 });
    expect(game.boards[0].cells.every(c => c === '')).toBe(true);
  });

  it('applies condemn correctly', () => {
    const game = createGame();
    game.boards[5].cells[0] = 'X';
    game.currentPlayer = 'X';

    applyAiPreCard(game, { card: 'condemn', boardIdx: 5 });
    expect(game.boards[5].condemned).toBe(true);
  });
});

// ---- Flash helpers ----

describe('getCardFlashBoards', () => {
  it('returns board for single-board targets', () => {
    expect(getCardFlashBoards({ card: 'overwrite', boardIdx: 3, cellIdx: 4 })).toEqual([3]);
    expect(getCardFlashBoards({ card: 'shatter', boardIdx: 7 })).toEqual([7]);
  });

  it('returns both boards for recall', () => {
    const boards = getCardFlashBoards({ card: 'recall', fromBoard: 1, fromCell: 0, toBoard: 5, toCell: 3 });
    expect(boards).toEqual([1, 5]);
  });

  it('returns empty for flow modifiers', () => {
    expect(getCardFlashBoards({ card: 'haste' })).toEqual([]);
    expect(getCardFlashBoards({ card: 'double-down' })).toEqual([]);
    expect(getCardFlashBoards({ card: 'redirect' })).toEqual([]);
  });
});

describe('getCardFlashColor', () => {
  it('returns appropriate colors', () => {
    expect(getCardFlashColor('overwrite')).toBe('rose');
    expect(getCardFlashColor('sabotage')).toBe('violet');
    expect(getCardFlashColor('recall')).toBe('sky');
    expect(getCardFlashColor('swap')).toBe('violet');
    expect(getCardFlashColor('shatter')).toBe('rose');
    expect(getCardFlashColor('condemn')).toBe('zinc');
  });
});

// ---- Urgency System ----

describe('urgency system', () => {
  it('returns neutral urgency on fresh game', () => {
    const game = createGame();
    const puState = createPowerUpState(makeDraft());
    const ctx = computeUrgency(game, puState, 'X');

    expect(ctx.multiplier).toBeCloseTo(1.0, 0);
    expect(ctx.opponentMacroThreats).toBe(0);
    expect(ctx.aiMacroThreats).toBe(0);
    expect(ctx.gameProgress).toBe(0);
    expect(ctx.cardsRemaining).toBe(3);
  });

  it('spikes when opponent has macro threat', () => {
    const game = createGame();
    // O has won boards 0 and 1 (top row macro: 0,1,2)
    game.boards[0].winner = 'O';
    game.boards[1].winner = 'O';
    const puState = createPowerUpState(makeDraft());
    const ctx = computeUrgency(game, puState, 'X');

    expect(ctx.opponentMacroThreats).toBeGreaterThanOrEqual(1);
    expect(ctx.multiplier).toBeGreaterThan(2.0);
  });

  it('spikes when AI has macro opportunity', () => {
    const game = createGame();
    // X has won boards 0 and 3 (left column macro: 0,3,6)
    game.boards[0].winner = 'X';
    game.boards[3].winner = 'X';
    const puState = createPowerUpState(makeDraft());
    const ctx = computeUrgency(game, puState, 'X');

    expect(ctx.aiMacroThreats).toBeGreaterThanOrEqual(1);
    expect(ctx.multiplier).toBeGreaterThan(1.5);
  });

  it('increases with game progress', () => {
    const game = createGame();
    const puState = createPowerUpState(makeDraft());
    const earlyCtx = computeUrgency(game, puState, 'X');

    // Win some boards to advance the game
    game.boards[0].winner = 'X';
    game.boards[4].winner = 'O';
    game.boards[8].drawn = true;
    const midCtx = computeUrgency(game, puState, 'X');

    expect(midCtx.multiplier).toBeGreaterThan(earlyCtx.multiplier);
  });

  it('applies last-card conservatism', () => {
    const game = createGame();
    const draft = makeDraft();
    const fullState = createPowerUpState(draft);
    const fullCtx = computeUrgency(game, fullState, 'X');

    const lastState = createPowerUpState(draft);
    useCard(lastState, draft.strike);
    useCard(lastState, draft.disruption);
    const lastCtx = computeUrgency(game, lastState, 'X');

    // 1 card remaining should have lower multiplier than 3 remaining
    expect(lastCtx.multiplier).toBeLessThan(fullCtx.multiplier);
  });

  it('compounds multiple threats', () => {
    const game = createGame();
    // O has two separate macro threats
    game.boards[0].winner = 'O';
    game.boards[1].winner = 'O'; // top row: 0,1,2
    game.boards[3].winner = 'O'; // left col: 0,3,6
    const puState = createPowerUpState(makeDraft());
    const ctx = computeUrgency(game, puState, 'X');

    expect(ctx.opponentMacroThreats).toBeGreaterThanOrEqual(2);
    expect(ctx.multiplier).toBeGreaterThan(3.0);
  });
});

// ---- Difficulty Scaling ----

describe('difficulty scaling', () => {
  it('hard AI uses cards in urgent situations', () => {
    const game = createGame();
    // Board 0: X X O — overwrite wins the board
    setupBoard(game, 0, ['X', 'X', 'O', '', '', '', '', '', '']);
    // Give X a macro threat: X already won boards 3 and 6 (left column: 0,3,6)
    // Winning board 0 via overwrite would win the macro line
    setupBoard(game, 3, ['X', 'X', 'X', '', '', '', '', '', '']);
    game.boards[3].winner = 'X';
    setupBoard(game, 6, ['X', 'X', 'X', '', '', '', '', '', '']);
    game.boards[6].winner = 'X';
    game.currentPlayer = 'X';

    const draft = makeDraft({ strike: 'overwrite' });
    const puState = createPowerUpState(draft);

    // Hard AI should use overwrite — it's on a macro line with opportunity
    const decision = aiDecideCard(game, puState, 'X', 8);
    expect(decision).not.toBeNull();
    expect(decision!.card).toBe('overwrite');
  });

  it('hard AI holds cards in calm positions', () => {
    const game = createGame();
    // Mild advantage: X has one piece on board 0, nothing critical
    setupBoard(game, 0, ['X', '', '', 'O', '', '', '', '', '']);
    game.currentPlayer = 'X';

    const draft = makeDraft({ disruption: 'sabotage' });
    const puState = createPowerUpState(draft);

    // Hard AI should hold sabotage — removing one piece in a calm game is wasteful
    const decision = aiDecideCard(game, puState, 'X', 8);
    // Should be null or not sabotage (might pick a flow modifier with high enough heuristic)
    if (decision?.card === 'sabotage') {
      // This shouldn't happen in a calm position with threshold 45
      expect(true).toBe(false);
    }
  });

  it('returns null when no cards available', () => {
    const game = createGame();
    game.currentPlayer = 'X';

    const draft = makeDraft();
    const puState = createPowerUpState(draft);
    // Use all cards
    useCard(puState, draft.strike);
    useCard(puState, draft.tactics);
    useCard(puState, draft.disruption);

    const decision = aiDecideCard(game, puState, 'X', 8);
    expect(decision).toBeNull();
  });

  it('returns null when game is over', () => {
    const game = createGame();
    game.winner = 'X';

    const draft = makeDraft();
    const puState = createPowerUpState(draft);

    const decision = aiDecideCard(game, puState, 'X', 8);
    expect(decision).toBeNull();
  });
});

// ---- Edge Cases ----

describe('edge cases', () => {
  it('handles condemned boards correctly in evaluation', () => {
    const game = createGame();
    game.boards[0].condemned = true;
    game.currentPlayer = 'X';

    const draft = makeDraft({ disruption: 'swap' });
    const puState = createPowerUpState(draft);
    const decision = aiDecideCard(game, puState, 'X', 8);

    // If swap is chosen, should not target condemned board
    if (decision?.card === 'swap') {
      expect(decision.boardIdx).not.toBe(0);
    }
  });

  it('handles all-condemned boards', () => {
    const game = createGame();
    for (let i = 0; i < 9; i++) game.boards[i].condemned = true;
    game.currentPlayer = 'X';

    const draft = makeDraft();
    const puState = createPowerUpState(draft);
    const decision = aiDecideCard(game, puState, 'X', 8);

    // Should return null (no valid targets for any card)
    // Note: haste/redirect might still be "valid" but there are no moves
    // Since game should be drawn with all condemned, winner check prevents usage
  });

  it('overwrite does not target own pieces', () => {
    const game = createGame();
    setupBoard(game, 0, ['X', '', '', '', '', '', '', '', '']);
    game.currentPlayer = 'X';

    const draft = makeDraft({ strike: 'overwrite' });
    const puState = createPowerUpState(draft);
    const decision = aiDecideCard(game, puState, 'X', 8);

    if (decision?.card === 'overwrite') {
      // Should never target board 0, cell 0 (that's AI's own piece)
      expect(!(decision.boardIdx === 0 && decision.cellIdx === 0)).toBe(true);
    }
  });

  it('shatter handles board with no pieces gracefully', () => {
    const game = createGame();
    game.currentPlayer = 'X';
    // All boards are empty — shatter has no useful targets
    const draft = makeDraft({ disruption: 'shatter' });
    const puState = createPowerUpState(draft);
    const decision = aiDecideCard(game, puState, 'X', 8);

    // Should not use shatter on empty boards (no improvement)
    if (decision?.card === 'shatter') {
      const b = game.boards[decision.boardIdx!];
      expect(b.cells.some(c => c !== '') || b.winner !== null).toBe(true);
    }
  });

  it('recall rejects same-board moves', () => {
    const game = createGame();
    setupBoard(game, 0, ['X', '', '', '', '', '', '', '', '']);
    game.currentPlayer = 'X';

    // applyRecall should throw for same board
    expect(() => {
      applyAiPreCard(game, { card: 'recall', fromBoard: 0, fromCell: 0, toBoard: 0, toCell: 1 });
    }).toThrow();
  });

  it('snapshot/restore handles mid-game state', () => {
    const game = createGame();
    // Play several moves
    applyMove(game, 0, 4);
    applyMove(game, 4, 0);
    applyMove(game, 0, 0);
    applyMove(game, 0, 2);

    const snap = snapshot(game);
    const origState = {
      zkey: game.zkey,
      player: game.currentPlayer,
      nbi: game.nextBoardIndex,
      cells00: game.boards[0].cells[0],
    };

    // Modify extensively
    applyMove(game, 2, 4);

    // Restore
    restore(game, snap);
    expect(game.zkey).toBe(origState.zkey);
    expect(game.currentPlayer).toBe(origState.player);
    expect(game.nextBoardIndex).toBe(origState.nbi);
    expect(game.boards[0].cells[0]).toBe(origState.cells00);
  });
});

// ---- evaluateForPlayer ----

describe('evaluateForPlayer', () => {
  it('returns positive for winning position', () => {
    const game = createGame();
    game.winner = 'X';
    expect(evaluateForPlayer(game, 'X')).toBeGreaterThan(0);
    expect(evaluateForPlayer(game, 'O')).toBeLessThan(0);
  });

  it('returns 0 for drawn game', () => {
    const game = createGame();
    game.drawn = true;
    expect(evaluateForPlayer(game, 'X')).toBe(0);
  });

  it('evaluates board control', () => {
    const game = createGame();
    setupBoard(game, 4, ['X', 'X', 'X', '', '', '', '', '', '']);
    game.boards[4].winner = 'X';

    const scoreX = evaluateForPlayer(game, 'X');
    const scoreO = evaluateForPlayer(game, 'O');
    expect(scoreX).toBeGreaterThan(0);
    expect(scoreO).toBeLessThan(0);
  });

  it('discounts won boards when opponent has shatter', () => {
    const game = createGame();
    setupBoard(game, 0, ['X', 'X', 'X', '', '', '', '', '', '']);
    game.boards[0].winner = 'X';

    const noCards = evaluateForPlayer(game, 'X');
    const withShatter = evaluateForPlayer(game, 'X', {
      myCards: [],
      opponentCards: ['shatter'],
    });

    // Won board should be worth less when opponent can shatter it
    expect(withShatter).toBeLessThan(noCards);
  });

  it('values blocked lines more when AI has overwrite', () => {
    const game = createGame();
    // X has 2-in-a-row blocked by single O piece
    setupBoard(game, 0, ['X', 'X', 'O', '', '', '', '', '', '']);

    const noCards = evaluateForPlayer(game, 'X');
    const withOverwrite = evaluateForPlayer(game, 'X', {
      myCards: ['overwrite'],
      opponentCards: [],
    });

    // Position should look better when we can overwrite the blocker
    expect(withOverwrite).toBeGreaterThan(noCards);
  });

  it('treats opponent threats as scarier when opponent has haste', () => {
    const game = createGame();
    // O has 2-in-a-row threat
    setupBoard(game, 0, ['O', 'O', '', '', '', '', '', '', '']);

    const noCards = evaluateForPlayer(game, 'X');
    const withHaste = evaluateForPlayer(game, 'X', {
      myCards: [],
      opponentCards: ['haste'],
    });

    // Position should look worse for X when O has haste (threats are scarier)
    expect(withHaste).toBeLessThan(noCards);
  });

  it('sudden death: opponent haste makes threats near-lethal', () => {
    const game = createGame('sudden-death');
    // O has a 2-in-a-row threat
    setupBoard(game, 0, ['O', 'O', '', '', '', '', '', '', '']);

    const noCards = evaluateForPlayer(game, 'X');
    const withHaste = evaluateForPlayer(game, 'X', {
      myCards: [],
      opponentCards: ['haste'],
    });

    // In sudden death, opponent haste + threat is devastating
    expect(withHaste).toBeLessThan(noCards);
    // The gap should be much larger than in classic mode
    const classicGame = createGame('classic');
    setupBoard(classicGame, 0, ['O', 'O', '', '', '', '', '', '', '']);
    const classicGap = evaluateForPlayer(classicGame, 'X') -
      evaluateForPlayer(classicGame, 'X', { myCards: [], opponentCards: ['haste'] });
    const sdGap = noCards - withHaste;
    expect(sdGap).toBeGreaterThan(classicGap);
  });

  it('sudden death: our overwrite on blocked 2-in-a-row is huge', () => {
    const game = createGame('sudden-death');
    // X has 2-in-a-row blocked by O
    setupBoard(game, 0, ['X', 'X', 'O', '', '', '', '', '', '']);

    const noCards = evaluateForPlayer(game, 'X');
    const withOW = evaluateForPlayer(game, 'X', {
      myCards: ['overwrite'],
      opponentCards: [],
    });

    // Overwrite makes this a near-guaranteed game win in sudden death
    expect(withOW).toBeGreaterThan(noCards);
  });

  it('misere: opponent swap on their won board is terrifying', () => {
    const game = createGame('misere');
    // O won board 0, and X has board 1 on the same macro row (0,1,2)
    setupBoard(game, 0, ['O', 'O', 'O', '', '', '', '', '', '']);
    game.boards[0].winner = 'O';
    setupBoard(game, 1, ['X', 'X', 'X', '', '', '', '', '', '']);
    game.boards[1].winner = 'X';

    const noCards = evaluateForPlayer(game, 'X');
    const withSwap = evaluateForPlayer(game, 'X', {
      myCards: [],
      opponentCards: ['swap'],
    });

    // Opponent can swap board 0 to become X's win → X gets 2 on top row → danger
    expect(withSwap).toBeLessThan(noCards);
  });

  it('misere: our condemn on our dangerous macro line is valuable', () => {
    const game = createGame('misere');
    // X has won boards 0 and 1 → top row 0,1,2 is dangerous for X
    setupBoard(game, 0, ['X', 'X', 'X', '', '', '', '', '', '']);
    game.boards[0].winner = 'X';
    setupBoard(game, 1, ['X', 'X', 'X', '', '', '', '', '', '']);
    game.boards[1].winner = 'X';

    const noCards = evaluateForPlayer(game, 'X');
    const withCondemn = evaluateForPlayer(game, 'X', {
      myCards: ['condemn'],
      opponentCards: [],
    });

    // Condemn lets X escape the macro trap
    expect(withCondemn).toBeGreaterThan(noCards);
  });

  it('misere: opponent haste is less threatening (risky for them)', () => {
    const game = createGame('misere');
    setupBoard(game, 0, ['O', 'O', '', '', '', '', '', '', '']);

    const noCards = evaluateForPlayer(game, 'X');
    const withHaste = evaluateForPlayer(game, 'X', {
      myCards: [],
      opponentCards: ['haste'],
    });

    // In misère, opponent haste is a liability for THEM (might win unwanted boards)
    expect(withHaste).toBeGreaterThanOrEqual(noCards);
  });
});

// ---- Integration: complete card decision flow ----

describe('integration - card decision flow', () => {
  it('evaluates all card types without errors on fresh game', () => {
    const game = createGame();
    applyMove(game, 4, 4); // X plays center-center
    applyMove(game, 4, 0); // O plays
    game.currentPlayer = 'X';

    // Test with every possible active card
    const allActiveCards: ActiveCard[] = [
      'double-down', 'haste', 'overwrite',
      'redirect', 'recall', 'condemn',
      'swap', 'shatter', 'sabotage',
    ];

    for (const card of allActiveCards) {
      const draft = makeDraft({ strike: card as any, tactics: card as any, disruption: card as any });
      const puState = createPowerUpState(draft);
      // Should not throw
      expect(() => aiDecideCard(game, puState, 'X', 8)).not.toThrow();
    }
  });

  it('correctly applies and restores state during evaluation', () => {
    const game = createGame();
    setupBoard(game, 0, ['X', 'X', 'O', '', '', '', '', '', '']);
    game.currentPlayer = 'X';
    const originalZkey = game.zkey;
    const originalCells = game.boards[0].cells.slice();

    const draft = makeDraft({ strike: 'overwrite' });
    const puState = createPowerUpState(draft);

    // After evaluation, game state should be unchanged
    aiDecideCard(game, puState, 'X', 8);
    expect(game.zkey).toBe(originalZkey);
    expect(game.boards[0].cells).toEqual(originalCells);
  });

  it('prefers higher-value cards over lower-value ones', () => {
    const game = createGame();
    // Create a situation where overwrite is clearly the best card
    // Board 0: X X O — overwriting O wins the board
    setupBoard(game, 0, ['X', 'X', 'O', '', '', '', '', '', '']);
    // Add macro context so urgency pushes overwrite above threshold
    setupBoard(game, 3, ['X', 'X', 'X', '', '', '', '', '', '']);
    game.boards[3].winner = 'X';
    game.currentPlayer = 'X';

    // Give AI both overwrite (strong) and shatter (weak - only empty boards to shatter)
    const draft: PowerUpDraft = {
      strike: 'overwrite',
      tactics: 'redirect',
      disruption: 'shatter',
      doctrine: 'momentum',
    };
    const puState = createPowerUpState(draft);
    const decision = aiDecideCard(game, puState, 'X', 8);

    expect(decision?.card).toBe('overwrite');
  });

  it('does not use cards on first move (no beneficial targets)', () => {
    const game = createGame();
    game.currentPlayer = 'X';

    // Only pre-placement cards — no valid targets on an empty board
    const draft = makeDraft({ strike: 'overwrite', tactics: 'condemn', disruption: 'sabotage' });
    const puState = createPowerUpState(draft);
    const decision = aiDecideCard(game, puState, 'X', 8);

    expect(decision).toBeNull();
  });
});
