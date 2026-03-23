import { describe, it, expect } from 'vitest';
import {
  createGame,
  availableMoves,
  applyMove,
  undoMove,
  captureUndo,
  updateGlobalState,
  computeConquestScores,
  type HyperXOGame,
  type Player,
} from '../game';
import { createAI, choose, evaluateForPlayer } from '../ai';

// ---- Helpers ----

function winBoard(game: HyperXOGame, boardIdx: number, player: Player) {
  const b = game.boards[boardIdx];
  b.cells[0] = player;
  b.cells[1] = player;
  b.cells[2] = player;
  b.winner = player;
}

function drawBoard(game: HyperXOGame, boardIdx: number) {
  // X O X / O X O / O X O — no winner
  const pattern: ('X' | 'O')[] = ['X','O','X','O','X','O','O','X','O'];
  const b = game.boards[boardIdx];
  for (let i = 0; i < 9; i++) b.cells[i] = pattern[i];
  b.drawn = true;
}

function rebuildHash(game: HyperXOGame) {
  game.zkey = 0;
  game.zkey ^= game.zobrist.nbiKey(game.nextBoardIndex);
  if (game.currentPlayer === 'O') game.zkey ^= game.zobrist.stmKey();
  for (let bi = 0; bi < 9; bi++) {
    for (let ci = 0; ci < 9; ci++) {
      const cell = game.boards[bi].cells[ci];
      if (cell === 'X' || cell === 'O') {
        game.zkey ^= game.zobrist.pieceKey(bi, ci, cell);
      }
    }
  }
}

// ---- Game creation ----

describe('conquest: game creation', () => {
  it('creates a game with exactly 3 bonus boards', () => {
    const game = createGame('conquest');
    expect(game.conquestBonusBoards).toHaveLength(3);
  });

  it('bonus boards are distinct indices 0-8', () => {
    for (let i = 0; i < 20; i++) {
      const game = createGame('conquest');
      const set = new Set(game.conquestBonusBoards);
      expect(set.size).toBe(3);
      for (const idx of game.conquestBonusBoards) {
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThanOrEqual(8);
      }
    }
  });

  it('bonus boards are sorted', () => {
    for (let i = 0; i < 20; i++) {
      const game = createGame('conquest');
      const sorted = [...game.conquestBonusBoards].sort((a, b) => a - b);
      expect(game.conquestBonusBoards).toEqual(sorted);
    }
  });

  it('accepts explicit bonus boards', () => {
    const game = createGame('conquest', [1, 4, 7]);
    expect(game.conquestBonusBoards).toEqual([1, 4, 7]);
  });

  it('non-conquest modes have empty bonus boards', () => {
    expect(createGame('classic').conquestBonusBoards).toEqual([]);
    expect(createGame('sudden-death').conquestBonusBoards).toEqual([]);
    expect(createGame('misere').conquestBonusBoards).toEqual([]);
  });
});

// ---- Score calculation ----

describe('conquest: score calculation', () => {
  it('normal boards are worth 1 point', () => {
    const game = createGame('conquest', [0, 1, 2]); // boards 0,1,2 are bonus
    winBoard(game, 3, 'X'); // normal board
    const scores = computeConquestScores(game);
    expect(scores.X).toBe(1);
    expect(scores.O).toBe(0);
  });

  it('bonus boards are worth 2 points', () => {
    const game = createGame('conquest', [0, 1, 2]);
    winBoard(game, 0, 'X'); // bonus board
    const scores = computeConquestScores(game);
    expect(scores.X).toBe(2);
    expect(scores.O).toBe(0);
  });

  it('drawn boards are worth 0 points', () => {
    const game = createGame('conquest', [0, 1, 2]);
    drawBoard(game, 0); // bonus board drawn — no points
    drawBoard(game, 3); // normal board drawn — no points
    const scores = computeConquestScores(game);
    expect(scores.X).toBe(0);
    expect(scores.O).toBe(0);
  });

  it('condemned boards are worth 0 points', () => {
    const game = createGame('conquest', [0, 1, 2]);
    game.boards[0].condemned = true;
    const scores = computeConquestScores(game);
    expect(scores.X).toBe(0);
    expect(scores.O).toBe(0);
  });

  it('total possible is 12 (6 normal + 3 bonus)', () => {
    const game = createGame('conquest', [0, 1, 2]);
    // X wins all 3 bonus boards
    winBoard(game, 0, 'X');
    winBoard(game, 1, 'X');
    winBoard(game, 2, 'X');
    // O wins all 6 normal boards
    for (let i = 3; i < 9; i++) winBoard(game, i, 'O');
    const scores = computeConquestScores(game);
    expect(scores.X).toBe(6); // 3 * 2
    expect(scores.O).toBe(6); // 6 * 1
    expect(scores.X + scores.O).toBe(12);
  });

  it('mixed scoring works correctly', () => {
    const game = createGame('conquest', [1, 4, 7]);
    winBoard(game, 0, 'X'); // normal = 1
    winBoard(game, 1, 'X'); // bonus = 2
    winBoard(game, 4, 'O'); // bonus = 2
    winBoard(game, 5, 'O'); // normal = 1
    const scores = computeConquestScores(game);
    expect(scores.X).toBe(3); // 1 + 2
    expect(scores.O).toBe(3); // 2 + 1
  });
});

// ---- Win conditions ----

describe('conquest: win conditions', () => {
  it('player with more points wins when all boards finished', () => {
    const game = createGame('conquest', [0, 1, 2]);
    // X wins 4 normal boards = 4 points
    winBoard(game, 3, 'X');
    winBoard(game, 4, 'X');
    winBoard(game, 5, 'X');
    winBoard(game, 6, 'X');
    // O wins 3 bonus boards = 6 points, and remaining 2 normal = 2 points
    winBoard(game, 0, 'O');
    winBoard(game, 1, 'O');
    winBoard(game, 2, 'O');
    winBoard(game, 7, 'O');
    winBoard(game, 8, 'O');
    updateGlobalState(game);
    expect(game.winner).toBe('O'); // 8 > 4
  });

  it('3-in-a-row on macro board does NOT win in conquest', () => {
    const game = createGame('conquest', [0, 1, 2]);
    // X has top row (0,1,2) — this is 3-in-a-row but doesn't matter
    winBoard(game, 0, 'X'); // bonus = 2
    winBoard(game, 1, 'X'); // bonus = 2
    winBoard(game, 2, 'X'); // bonus = 2
    // O has boards 3,4,5,6,7 (5 normal = 5 points)
    winBoard(game, 3, 'O');
    winBoard(game, 4, 'O');
    winBoard(game, 5, 'O');
    winBoard(game, 6, 'O');
    winBoard(game, 7, 'O');
    // Board 8 still open
    updateGlobalState(game);
    // X has 6 pts, O has 5 pts, 1 remaining — game should continue
    expect(game.winner).toBeNull();
    expect(game.drawn).toBe(false);
  });

  it('early termination when trailing player cannot catch up', () => {
    const game = createGame('conquest', [0, 1, 2]);
    // X: 2 bonus boards = 4 points
    winBoard(game, 0, 'X');
    winBoard(game, 1, 'X');
    // O: 1 normal board = 1 point
    winBoard(game, 3, 'O');
    // Remaining: board 2 (bonus=2), 4,5,6,7,8 (normal=5) = 7 remaining
    // O max = 1 + 7 = 8, X current = 4 → O can still catch up
    updateGlobalState(game);
    expect(game.winner).toBeNull();

    // Now win more for X so O can't catch up
    winBoard(game, 4, 'X');
    winBoard(game, 5, 'X');
    winBoard(game, 6, 'X');
    // X = 4 + 3 = 7, O = 1, remaining = board 2(2) + 7(1) + 8(1) = 4
    // O max = 1 + 4 = 5 < 7 → X wins by early termination
    updateGlobalState(game);
    expect(game.winner).toBe('X');
  });

  it('no early termination when scores are close', () => {
    const game = createGame('conquest', [0, 1, 2]);
    winBoard(game, 0, 'X'); // bonus = 2
    winBoard(game, 3, 'O'); // normal = 1
    // X: 2, O: 1, remaining: 1(b)+2(b)+4+5+6+7+8 = 2+1+1+1+1+1+1 = 8
    // O max = 1 + 8 = 9 > 2, X max = 2 + 8 = 10 > 1 → continues
    updateGlobalState(game);
    expect(game.winner).toBeNull();
    expect(game.drawn).toBe(false);
  });

  it('game continues when all boards done but via applyMove', () => {
    const game = createGame('conquest', [0, 1, 2]);
    // Set up 8 boards finished, board 8 about to be won by O
    winBoard(game, 0, 'X'); // bonus = 2
    winBoard(game, 1, 'O'); // bonus = 2
    winBoard(game, 2, 'X'); // bonus = 2
    winBoard(game, 3, 'O'); // 1
    winBoard(game, 4, 'X'); // 1
    winBoard(game, 5, 'O'); // 1
    winBoard(game, 6, 'X'); // 1
    winBoard(game, 7, 'O'); // 1
    // Board 8: O about to win (normal = 1)
    game.boards[8].cells[0] = 'O';
    game.boards[8].cells[1] = 'O';
    game.nextBoardIndex = 8;
    game.currentPlayer = 'O';
    rebuildHash(game);

    applyMove(game, 8, 2); // O wins board 8
    // X: 2+2+1+1 = 6, O: 2+1+1+1+1 = 6 → tied!
    expect(game.boards[8].winner).toBe('O');
    // Tiebreaker: X has bonus boards 0,2 (2), O has bonus board 1 (1) → X wins
    expect(game.winner).toBe('X');
  });
});

// ---- Tiebreaker ----

describe('conquest: tiebreaker', () => {
  it('equal points: player with more bonus boards wins', () => {
    const game = createGame('conquest', [0, 1, 2]);
    // X: bonus 0 (2) + bonus 1 (2) + normal boards 3,4 (2) = 6
    winBoard(game, 0, 'X');
    winBoard(game, 1, 'X');
    winBoard(game, 3, 'X');
    winBoard(game, 4, 'X');
    // O: bonus 2 (2) + normal boards 5,6,7,8 (4) = 6
    winBoard(game, 2, 'O');
    winBoard(game, 5, 'O');
    winBoard(game, 6, 'O');
    winBoard(game, 7, 'O');
    winBoard(game, 8, 'O');
    updateGlobalState(game);
    // Tied at 6-6. X has 2 bonus boards, O has 1 → X wins
    expect(game.winner).toBe('X');
  });

  it('equal points AND equal bonus boards → draw', () => {
    const game = createGame('conquest', [0, 4, 8]);
    // X: bonus 0 (2) + normal 1,2,3 (3) = 5
    winBoard(game, 0, 'X');
    winBoard(game, 1, 'X');
    winBoard(game, 2, 'X');
    winBoard(game, 3, 'X');
    // O: bonus 4 (2) + normal 5,6,7 (3) = 5
    winBoard(game, 4, 'O');
    winBoard(game, 5, 'O');
    winBoard(game, 6, 'O');
    winBoard(game, 7, 'O');
    // Board 8 (bonus) drawn — 0 points for both
    drawBoard(game, 8);
    updateGlobalState(game);
    // 5-5, each has 1 bonus board → draw
    expect(game.winner).toBeNull();
    expect(game.drawn).toBe(true);
  });

  it('equal points but one player has all 3 bonus boards → they win', () => {
    const game = createGame('conquest', [0, 1, 2]);
    // X: bonus 0,1,2 (6)
    winBoard(game, 0, 'X');
    winBoard(game, 1, 'X');
    winBoard(game, 2, 'X');
    // O: normal 3,4,5,6,7,8 (6)
    for (let i = 3; i < 9; i++) winBoard(game, i, 'O');
    updateGlobalState(game);
    // 6-6, X has 3 bonus, O has 0 → X wins
    expect(game.winner).toBe('X');
  });
});

// ---- Undo correctness ----

describe('conquest: undo/redo', () => {
  it('undo restores state correctly in conquest', () => {
    const game = createGame('conquest', [0, 4, 8]);
    applyMove(game, 0, 4); // X
    applyMove(game, 4, 0); // O

    const prevPlayer = game.currentPlayer;
    const prevNbi = game.nextBoardIndex;
    const prevWinner = game.winner;
    const prevDrawn = game.drawn;
    const prevHash = game.zkey;

    const undo = captureUndo(game, 0);
    applyMove(game, 0, 1); // X
    undoMove(game, 0, 1, undo);

    expect(game.currentPlayer).toBe(prevPlayer);
    expect(game.nextBoardIndex).toBe(prevNbi);
    expect(game.winner).toBe(prevWinner);
    expect(game.drawn).toBe(prevDrawn);
    expect(game.zkey).toBe(prevHash);
  });

  it('undo after game-ending move restores in-progress state', () => {
    const game = createGame('conquest', [0, 1, 2]);
    // Set up: 8 boards done, board 8 about to end the game
    for (let i = 0; i < 8; i++) winBoard(game, i, i < 5 ? 'X' : 'O');
    game.boards[8].cells[0] = 'X';
    game.boards[8].cells[1] = 'X';
    game.nextBoardIndex = 8;
    game.currentPlayer = 'X';
    rebuildHash(game);

    const prevHash = game.zkey;
    const undo = captureUndo(game, 8);
    applyMove(game, 8, 2); // X wins board 8 → game ends
    expect(game.winner).not.toBeNull();

    undoMove(game, 8, 2, undo);
    expect(game.winner).toBeNull();
    expect(game.drawn).toBe(false);
    expect(game.zkey).toBe(prevHash);
  });
});

// ---- AI behavior ----

describe('conquest: AI', () => {
  it('AI prefers bonus boards over normal boards', () => {
    const game = createGame('conquest', [4, 5, 6]);
    // Set up: X can win board 4 (bonus, worth 2) or board 0 (normal, worth 1)
    // Board 4: X has 2-in-a-row
    game.boards[4].cells[0] = 'X';
    game.boards[4].cells[1] = 'X';
    // Board 0: X has 2-in-a-row
    game.boards[0].cells[0] = 'X';
    game.boards[0].cells[1] = 'X';
    game.nextBoardIndex = null;
    game.currentPlayer = 'X';
    rebuildHash(game);

    const ai = createAI('X', 5, 0);
    const move = choose(ai, game);
    // AI should prefer board 4 (bonus) — the winning move is cell 2
    expect(move[0]).toBe(4);
    expect(move[1]).toBe(2);
  });

  it('evaluateForPlayer gives higher score for bonus board wins', () => {
    const game1 = createGame('conquest', [0, 1, 2]);
    winBoard(game1, 0, 'X'); // bonus win

    const game2 = createGame('conquest', [0, 1, 2]);
    winBoard(game2, 3, 'X'); // normal win

    const score1 = evaluateForPlayer(game1, 'X');
    const score2 = evaluateForPlayer(game2, 'X');
    expect(score1).toBeGreaterThan(score2);
  });

  it('AI plays a valid complete game in conquest mode', () => {
    const game = createGame('conquest');
    const aiX = createAI('X', 3, 0);
    const aiO = createAI('O', 3, 0);
    let turns = 0;

    while (!game.winner && !game.drawn && turns < 200) {
      const ai = game.currentPlayer === 'X' ? aiX : aiO;
      const move = choose(ai, game);
      const legal = availableMoves(game);
      expect(legal.some(([b, c]) => b === move[0] && c === move[1])).toBe(true);
      applyMove(game, move[0], move[1]);
      turns++;
    }

    expect(turns).toBeLessThan(200);
    // Game must end with a winner or draw
    expect(game.winner !== null || game.drawn).toBe(true);
  });
});

// ---- Edge cases ----

describe('conquest: edge cases', () => {
  it('all boards drawn → draw (0-0)', () => {
    const game = createGame('conquest', [0, 1, 2]);
    for (let i = 0; i < 9; i++) drawBoard(game, i);
    updateGlobalState(game);
    expect(game.winner).toBeNull();
    expect(game.drawn).toBe(true);
    const scores = computeConquestScores(game);
    expect(scores.X).toBe(0);
    expect(scores.O).toBe(0);
  });

  it('condemned boards count as 0 points and are finished', () => {
    const game = createGame('conquest', [0, 1, 2]);
    // All boards won or condemned
    winBoard(game, 0, 'X'); // bonus = 2
    winBoard(game, 1, 'O'); // bonus = 2
    for (let i = 2; i < 9; i++) {
      game.boards[i].condemned = true;
    }
    updateGlobalState(game);
    // X: 2, O: 2, both have 1 bonus → tiebreaker: equal bonus → draw
    expect(game.drawn).toBe(true);
  });

  it('early termination fires correctly with condemned boards', () => {
    const game = createGame('conquest', [0, 1, 2]);
    winBoard(game, 0, 'X'); // bonus = 2
    winBoard(game, 1, 'X'); // bonus = 2
    winBoard(game, 2, 'X'); // bonus = 2
    winBoard(game, 3, 'X'); // normal = 1
    // X: 7, O: 0
    // Condemn remaining boards
    for (let i = 4; i < 9; i++) game.boards[i].condemned = true;
    // Remaining = 0, O max = 0 < 7
    updateGlobalState(game);
    expect(game.winner).toBe('X');
  });

  it('conquestBonusBoards is stable through snapshot/restore', () => {
    const game = createGame('conquest', [2, 5, 8]);
    expect(game.conquestBonusBoards).toEqual([2, 5, 8]);
    applyMove(game, 0, 4);
    expect(game.conquestBonusBoards).toEqual([2, 5, 8]);
    const undo = captureUndo(game, 4);
    applyMove(game, 4, 0);
    undoMove(game, 4, 0, undo);
    expect(game.conquestBonusBoards).toEqual([2, 5, 8]);
  });
});
