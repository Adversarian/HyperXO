import { describe, it, expect } from 'vitest';
import {
  createGame,
  applyMove,
  availableMoves,
  type HyperXOGame,
} from '../game';
import { createAI, choose } from '../ai';

function rebuildHash(game: HyperXOGame) {
  game.zkey = 0;
  game.zkey ^= game.zobrist.nbiKey(game.nextBoardIndex);
  for (let bi = 0; bi < 9; bi++) {
    for (let ci = 0; ci < 9; ci++) {
      const cell = game.boards[bi].cells[ci];
      if (cell === 'X' || cell === 'O') {
        game.zkey ^= game.zobrist.pieceKey(bi, ci, cell);
      }
    }
  }
}

describe('AI', () => {
  it('takes the only winning move', () => {
    const game = createGame();
    const b = game.boards[0];
    b.cells[0] = 'X';
    b.cells[1] = 'X';
    for (let i = 3; i < 9; i++) b.cells[i] = 'O';
    game.nextBoardIndex = 0;
    game.currentPlayer = 'X';
    rebuildHash(game);

    const ai = createAI('X', 3);
    const move = choose(ai, game);
    expect(move).toEqual([0, 2]);
  });

  it('takes obvious board win built via legal moves', () => {
    const game = createGame();
    applyMove(game, 0, 4); // X at (0,4)
    applyMove(game, 4, 0); // O at (4,0)
    applyMove(game, 0, 8); // X at (0,8)
    applyMove(game, 8, 0); // O at (8,0)
    // Board 0: X at 4,8. Cell 0 completes diagonal.
    expect(game.currentPlayer).toBe('X');
    expect(game.nextBoardIndex).toBe(0);

    const ai = createAI('X', 3);
    const move = choose(ai, game);
    expect(move).toEqual([0, 0]);
  });

  it('respects forced board', () => {
    const game = createGame();
    applyMove(game, 0, 4); // X sends O to board 4

    const ai = createAI('O', 3);
    const move = choose(ai, game);
    const legal = availableMoves(game);
    expect(legal.some(m => m[0] === move[0] && m[1] === move[1])).toBe(true);
    expect(move[0]).toBe(4);
  });

  it('prefers faster win', () => {
    const game = createGame();
    // Give X boards 0 and 1
    for (const idx of [0, 1]) {
      for (const c of [0, 1, 2]) game.boards[idx].cells[c] = 'X';
      game.boards[idx].winner = 'X';
    }
    // Board 2: X at 0,1 — cell 2 wins it and the game
    game.boards[2].cells[0] = 'X';
    game.boards[2].cells[1] = 'X';
    game.boards[2].cells[3] = 'O';
    game.boards[2].cells[4] = 'O';

    game.nextBoardIndex = 2;
    game.currentPlayer = 'X';
    rebuildHash(game);

    const ai = createAI('X', 5);
    const move = choose(ai, game);
    expect(move).toEqual([2, 2]);
  });

  it('blunder rate produces random moves sometimes', () => {
    const game = createGame();
    const ai = createAI('X', 3, 1.0); // 100% blunder
    const moves = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const m = choose(ai, game);
      moves.add(`${m[0]},${m[1]}`);
    }
    // With 100% blunder rate over 20 tries on 81 available moves,
    // we should get more than 1 unique move
    expect(moves.size).toBeGreaterThan(1);
  });
});

describe('AI sudden-death mode', () => {
  it('takes immediate board win (game-winning move)', () => {
    const game = createGame('sudden-death');
    game.boards[0].cells[0] = 'X';
    game.boards[0].cells[1] = 'X';
    game.nextBoardIndex = 0;
    game.currentPlayer = 'X';
    rebuildHash(game);

    const ai = createAI('X', 5);
    const move = choose(ai, game);
    expect(move).toEqual([0, 2]); // Complete top row → win game
  });

  it('blocks opponent board win', () => {
    const game = createGame('sudden-death');
    // O has 2 in a row on board 3, X is forced to board 3
    game.boards[3].cells[0] = 'O';
    game.boards[3].cells[1] = 'O';
    game.nextBoardIndex = 3;
    game.currentPlayer = 'X';
    rebuildHash(game);

    const ai = createAI('X', 5);
    const move = choose(ai, game);
    // X must block at (3, 2) to prevent O from winning the game
    expect(move).toEqual([3, 2]);
  });
});

describe('AI misère mode', () => {
  it('avoids completing 3 boards in a row', () => {
    const game = createGame('misere');
    // X has boards 0 and 1. Board 2 has X at 0,1 — cell 2 would win board 2
    // and complete top macro row, which means X LOSES.
    for (const idx of [0, 1]) {
      for (const c of [0, 1, 2]) game.boards[idx].cells[c] = 'X';
      game.boards[idx].winner = 'X';
    }
    game.boards[2].cells[0] = 'X';
    game.boards[2].cells[1] = 'X';
    game.boards[2].cells[3] = 'O';
    game.boards[2].cells[4] = 'O';
    game.nextBoardIndex = 2;
    game.currentPlayer = 'X';
    rebuildHash(game);

    const ai = createAI('X', 5);
    const move = choose(ai, game);
    // AI should NOT play (2, 2) — that would complete the macro line and lose
    expect(move[0]).toBe(2); // forced to board 2
    expect(move[1]).not.toBe(2);
  });
});
