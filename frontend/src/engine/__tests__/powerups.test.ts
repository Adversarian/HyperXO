import { describe, it, expect } from 'vitest';
import {
  CARD_CATALOG,
  STRIKE_CARDS,
  TACTICS_CARDS,
  DISRUPTION_CARDS,
  DOCTRINE_CARDS,
  CATEGORIES,
  createDefaultDraft,
  isDraftComplete,
  createPowerUpState,
  isCardUsed,
  useCard,
  getActiveCards,
  getAvailableCards,
  applyRecall,
  applySabotage,
  applyOverwrite,
  applySwap,
  applyShatter,
  applyCondemn,
  applyRedirect,
  scanSiegeThreats,
  refreshSiegeThreats,
  advanceSiegeThreats,
  applySiegeClaim,
  type PowerUpCard,
  type SiegeThreat,
} from '../powerups';
import { createGame, applyMove, availableMoves } from '../game';

describe('power-up card catalog', () => {
  it('contains exactly 12 cards', () => {
    expect(Object.keys(CARD_CATALOG)).toHaveLength(12);
  });

  it('has 3 cards per category', () => {
    expect(STRIKE_CARDS).toHaveLength(3);
    expect(TACTICS_CARDS).toHaveLength(3);
    expect(DISRUPTION_CARDS).toHaveLength(3);
    expect(DOCTRINE_CARDS).toHaveLength(3);
  });

  it('all catalog entries have required fields', () => {
    for (const [id, card] of Object.entries(CARD_CATALOG)) {
      expect(card.id).toBe(id);
      expect(card.name).toBeTruthy();
      expect(card.category).toBeTruthy();
      expect(card.description).toBeTruthy();
      expect(card.flavor).toBeTruthy();
      expect(typeof card.passive).toBe('boolean');
      expect(['none', 'board', 'opponent-cell']).toContain(card.targetType);
    }
  });

  it('doctrine cards are passive, others are active', () => {
    for (const id of DOCTRINE_CARDS) {
      expect(CARD_CATALOG[id].passive).toBe(true);
    }
    for (const id of [...STRIKE_CARDS, ...TACTICS_CARDS, ...DISRUPTION_CARDS]) {
      expect(CARD_CATALOG[id].passive).toBe(false);
    }
  });

  it('all card arrays reference valid catalog entries', () => {
    const allCards: PowerUpCard[] = [
      ...STRIKE_CARDS, ...TACTICS_CARDS,
      ...DISRUPTION_CARDS, ...DOCTRINE_CARDS,
    ];
    for (const id of allCards) {
      expect(CARD_CATALOG[id]).toBeDefined();
    }
  });

  it('CATEGORIES covers all 4 groups', () => {
    expect(CATEGORIES).toHaveLength(4);
    const keys = CATEGORIES.map(c => c.key);
    expect(keys).toContain('strike');
    expect(keys).toContain('tactics');
    expect(keys).toContain('disruption');
    expect(keys).toContain('doctrine');
  });
});

describe('power-up draft', () => {
  it('creates a valid default draft', () => {
    const draft = createDefaultDraft();
    expect(STRIKE_CARDS).toContain(draft.strike);
    expect(TACTICS_CARDS).toContain(draft.tactics);
    expect(DISRUPTION_CARDS).toContain(draft.disruption);
    expect(DOCTRINE_CARDS).toContain(draft.doctrine);
  });

  it('isDraftComplete returns true for full draft', () => {
    const draft = createDefaultDraft();
    expect(isDraftComplete(draft)).toBe(true);
  });

  it('isDraftComplete returns false for partial draft', () => {
    expect(isDraftComplete({})).toBe(false);
    expect(isDraftComplete({ strike: 'haste' })).toBe(false);
    expect(isDraftComplete({ strike: 'haste', tactics: 'recall' })).toBe(false);
    expect(isDraftComplete({ strike: 'haste', tactics: 'recall', disruption: 'shatter' })).toBe(false);
  });
});

describe('power-up in-game state', () => {
  it('getActiveCards returns 3 cards from draft', () => {
    const draft = createDefaultDraft();
    const actives = getActiveCards(draft);
    expect(actives).toHaveLength(3);
    expect(actives).toContain(draft.strike);
    expect(actives).toContain(draft.tactics);
    expect(actives).toContain(draft.disruption);
  });

  it('creates state with no cards used', () => {
    const state = createPowerUpState(createDefaultDraft());
    const available = getAvailableCards(state);
    expect(available).toHaveLength(3);
  });

  it('marks a card as used', () => {
    const draft = createDefaultDraft();
    const state = createPowerUpState(draft);

    useCard(state, draft.strike);
    expect(isCardUsed(state, draft.strike)).toBe(true);
    expect(isCardUsed(state, draft.tactics)).toBe(false);
    expect(getAvailableCards(state)).toHaveLength(2);
  });

  it('using all cards leaves none available', () => {
    const draft = createDefaultDraft();
    const state = createPowerUpState(draft);

    useCard(state, draft.strike);
    useCard(state, draft.tactics);
    useCard(state, draft.disruption);
    expect(getAvailableCards(state)).toHaveLength(0);
  });
});

describe('power-up effects', () => {
  it('recall moves own piece to another board', () => {
    const game = createGame();
    game.boards[0].cells[4] = 'X';
    game.boards[3].cells[0] = ''; // ensure empty

    applyRecall(game, 0, 4, 3, 0);
    expect(game.boards[0].cells[4]).toBe('');
    expect(game.boards[3].cells[0]).toBe('X');
  });

  it('recall rejects moving to same board', () => {
    const game = createGame();
    game.boards[0].cells[4] = 'X';
    expect(() => applyRecall(game, 0, 4, 0, 0)).toThrow();
  });

  it('recall rejects moving opponent piece', () => {
    const game = createGame();
    game.boards[0].cells[4] = 'O';
    expect(() => applyRecall(game, 0, 4, 3, 0)).toThrow();
  });

  it('recall rejects destination on won board', () => {
    const game = createGame();
    game.boards[0].cells[4] = 'X';
    game.boards[3].winner = 'O';
    expect(() => applyRecall(game, 0, 4, 3, 0)).toThrow();
  });

  it('recall rejects occupied destination cell', () => {
    const game = createGame();
    game.boards[0].cells[4] = 'X';
    game.boards[3].cells[0] = 'O';
    expect(() => applyRecall(game, 0, 4, 3, 0)).toThrow();
  });

  it('sabotage removes opponent piece', () => {
    const game = createGame();
    applyMove(game, 0, 4); // X at (0,4)
    // O's turn, sabotage X's piece
    expect(game.boards[0].cells[4]).toBe('X');
    applySabotage(game, 0, 4);
    expect(game.boards[0].cells[4]).toBe('');
  });

  it('sabotage revokes board win', () => {
    const game = createGame();
    const b = game.boards[3];
    b.cells[0] = 'X'; b.cells[1] = 'X'; b.cells[2] = 'X';
    b.winner = 'X';
    game.currentPlayer = 'O';

    applySabotage(game, 3, 0);
    expect(b.winner).toBeNull();
    expect(b.cells[0]).toBe('');
  });

  it('sabotage rejects targeting own piece', () => {
    const game = createGame();
    game.boards[0].cells[0] = 'X';
    game.currentPlayer = 'X';
    expect(() => applySabotage(game, 0, 0)).toThrow();
  });

  it('overwrite replaces opponent piece', () => {
    const game = createGame();
    game.boards[0].cells[4] = 'O';
    game.currentPlayer = 'X';

    applyOverwrite(game, 0, 4);
    expect(game.boards[0].cells[4]).toBe('X');
  });

  it('overwrite can trigger board win', () => {
    const game = createGame();
    const b = game.boards[0];
    b.cells[0] = 'X'; b.cells[1] = 'X'; b.cells[2] = 'O';
    game.currentPlayer = 'X';

    applyOverwrite(game, 0, 2);
    expect(b.cells[2]).toBe('X');
    expect(b.winner).toBe('X');
  });

  it('overwrite rejects won board', () => {
    const game = createGame();
    const b = game.boards[0];
    b.cells[0] = 'O'; b.cells[1] = 'O'; b.cells[2] = 'O';
    b.winner = 'O';
    game.currentPlayer = 'X';
    expect(() => applyOverwrite(game, 0, 0)).toThrow();
  });

  it('swap rejects won board', () => {
    const game = createGame();
    game.boards[0].cells[0] = 'X'; game.boards[0].cells[1] = 'X'; game.boards[0].cells[2] = 'X';
    game.boards[0].winner = 'X';
    expect(() => applySwap(game, 0)).toThrow();
  });

  it('swap exchanges all pieces on a board', () => {
    const game = createGame();
    const b = game.boards[0];
    b.cells[0] = 'X'; b.cells[1] = 'O'; b.cells[4] = 'X';

    applySwap(game, 0);
    expect(b.cells[0]).toBe('O');
    expect(b.cells[1]).toBe('X');
    expect(b.cells[4]).toBe('O');
    expect(b.cells[2]).toBe(''); // empty stays empty
  });

  it('swap can trigger board win', () => {
    const game = createGame();
    const b = game.boards[0];
    b.cells[0] = 'O'; b.cells[1] = 'O'; b.cells[2] = 'O';
    b.cells[3] = 'X'; b.cells[4] = 'X';

    applySwap(game, 0);
    expect(b.cells[0]).toBe('X');
    expect(b.cells[3]).toBe('O');
    expect(b.winner).toBe('X');
  });

  it('shatter clears all pieces and revokes win', () => {
    const game = createGame();
    const b = game.boards[0];
    b.cells[0] = 'X'; b.cells[1] = 'X'; b.cells[2] = 'X';
    b.winner = 'X';

    applyShatter(game, 0);
    expect(b.cells.every(c => c === '')).toBe(true);
    expect(b.winner).toBeNull();
    expect(b.drawn).toBe(false);
  });

  it('shatter rejects condemned board', () => {
    const game = createGame();
    game.boards[0].condemned = true;
    expect(() => applyShatter(game, 0)).toThrow();
  });

  it('condemn permanently removes board', () => {
    const game = createGame();
    game.boards[5].cells[0] = 'X';
    game.boards[5].cells[1] = 'O';
    game.currentPlayer = 'X';

    applyCondemn(game, 5);
    expect(game.boards[5].condemned).toBe(true);
    expect(game.boards[5].cells.every(c => c === '')).toBe(true);
    // Board 5 should not appear in available moves
    const moves = availableMoves(game);
    expect(moves.every(([b]) => b !== 5)).toBe(true);
  });

  it('condemn frees directed move if targeting forced board', () => {
    const game = createGame();
    applyMove(game, 0, 5); // X plays, O forced to board 5
    expect(game.nextBoardIndex).toBe(5);

    applyCondemn(game, 5);
    expect(game.nextBoardIndex).toBeNull();
  });

  it('condemn rejects already-won board', () => {
    const game = createGame();
    game.boards[0].winner = 'X';
    expect(() => applyCondemn(game, 0)).toThrow();
  });

  it('redirect overrides next board', () => {
    const game = createGame();
    applyMove(game, 0, 4); // X plays (0,4), O forced to board 4
    // O wants to redirect X to board 7 after their move
    applyMove(game, 4, 0); // O plays (4,0), X would go to board 0
    expect(game.nextBoardIndex).toBe(0);

    applyRedirect(game, 7);
    expect(game.nextBoardIndex).toBe(7);
    // X is now forced to board 7
    const moves = availableMoves(game);
    expect(moves.every(([b]) => b === 7)).toBe(true);
  });

  it('redirect rejects dead board target', () => {
    const game = createGame();
    game.boards[3].condemned = true;
    expect(() => applyRedirect(game, 3)).toThrow();
  });
});

describe('siege passive', () => {
  it('detects 2-in-a-row threats', () => {
    const game = createGame();
    game.boards[0].cells[0] = 'X';
    game.boards[0].cells[1] = 'X';

    const threats = scanSiegeThreats(game, 'X');
    expect(threats.some(t => t.boardIdx === 0 && t.blockingCell === 2)).toBe(true);
  });

  it('ignores won boards', () => {
    const game = createGame();
    game.boards[0].cells[0] = 'X';
    game.boards[0].cells[1] = 'X';
    game.boards[0].winner = 'X';

    const threats = scanSiegeThreats(game, 'X');
    expect(threats.filter(t => t.boardIdx === 0)).toHaveLength(0);
  });

  it('ignores condemned boards', () => {
    const game = createGame();
    game.boards[0].cells[0] = 'X';
    game.boards[0].cells[1] = 'X';
    game.boards[0].condemned = true;

    const threats = scanSiegeThreats(game, 'X');
    expect(threats.filter(t => t.boardIdx === 0)).toHaveLength(0);
  });

  it('ignores lines blocked by opponent', () => {
    const game = createGame();
    game.boards[0].cells[0] = 'X';
    game.boards[0].cells[1] = 'X';
    game.boards[0].cells[2] = 'O';

    const threats = scanSiegeThreats(game, 'X');
    expect(threats.filter(t => t.boardIdx === 0 && t.blockingCell === 2)).toHaveLength(0);
  });

  it('deduplicates threats for the same blocking cell', () => {
    const game = createGame();
    // Two lines converge on cell 4: row [3,4,5] and col [1,4,7]
    game.boards[0].cells[3] = 'X';
    game.boards[0].cells[5] = 'X';
    game.boards[0].cells[1] = 'X';
    game.boards[0].cells[7] = 'X';

    const threats = scanSiegeThreats(game, 'X');
    const cell4Threats = threats.filter(t => t.boardIdx === 0 && t.blockingCell === 4);
    expect(cell4Threats).toHaveLength(1);
  });

  it('refreshSiegeThreats preserves existing counters', () => {
    const game = createGame();
    game.boards[0].cells[0] = 'X';
    game.boards[0].cells[1] = 'X';

    const existing: SiegeThreat[] = [
      { boardIdx: 0, blockingCell: 2, turnsUnblocked: 2 },
    ];

    const refreshed = refreshSiegeThreats(existing, game, 'X');
    const threat = refreshed.find(t => t.boardIdx === 0 && t.blockingCell === 2);
    expect(threat?.turnsUnblocked).toBe(2);
  });

  it('refreshSiegeThreats starts new threats at 0', () => {
    const game = createGame();
    game.boards[0].cells[0] = 'X';
    game.boards[0].cells[1] = 'X';

    const refreshed = refreshSiegeThreats([], game, 'X');
    const threat = refreshed.find(t => t.boardIdx === 0 && t.blockingCell === 2);
    expect(threat?.turnsUnblocked).toBe(0);
  });

  it('advanceSiegeThreats increments counters', () => {
    const game = createGame();
    game.boards[0].cells[0] = 'X';
    game.boards[0].cells[1] = 'X';

    const existing: SiegeThreat[] = [
      { boardIdx: 0, blockingCell: 2, turnsUnblocked: 1 },
    ];

    const { updated, claimed } = advanceSiegeThreats(existing, game, 'X');
    expect(claimed).toHaveLength(0);
    expect(updated.find(t => t.boardIdx === 0 && t.blockingCell === 2)?.turnsUnblocked).toBe(2);
  });

  it('advanceSiegeThreats claims at 3 unblocked turns', () => {
    const game = createGame();
    game.boards[0].cells[0] = 'X';
    game.boards[0].cells[1] = 'X';

    const existing: SiegeThreat[] = [
      { boardIdx: 0, blockingCell: 2, turnsUnblocked: 2 },
    ];

    const { updated, claimed } = advanceSiegeThreats(existing, game, 'X');
    expect(claimed).toEqual([{ boardIdx: 0, cellIdx: 2 }]);
    expect(updated.filter(t => t.boardIdx === 0 && t.blockingCell === 2)).toHaveLength(0);
  });

  it('advanceSiegeThreats drops blocked threats', () => {
    const game = createGame();
    game.boards[0].cells[0] = 'X';
    game.boards[0].cells[1] = 'X';
    game.boards[0].cells[2] = 'O'; // blocked

    const existing: SiegeThreat[] = [
      { boardIdx: 0, blockingCell: 2, turnsUnblocked: 2 },
    ];

    const { updated, claimed } = advanceSiegeThreats(existing, game, 'X');
    expect(claimed).toHaveLength(0);
    expect(updated.filter(t => t.boardIdx === 0 && t.blockingCell === 2)).toHaveLength(0);
  });

  it('applySiegeClaim places piece and triggers board win', () => {
    const game = createGame();
    game.boards[0].cells[0] = 'X';
    game.boards[0].cells[1] = 'X';

    applySiegeClaim(game, 0, 2, 'X');
    expect(game.boards[0].cells[2]).toBe('X');
    expect(game.boards[0].winner).toBe('X');
  });
});
