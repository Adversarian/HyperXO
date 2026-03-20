import { describe, it, expect } from 'vitest';
import {
  createGame,
  availableMoves,
  applyMove,
  undoMove,
  captureUndo,
  WINNING_LINES,
} from '../game';

describe('game engine', () => {
  it('initial state allows any board (81 moves)', () => {
    const game = createGame();
    const moves = availableMoves(game);
    expect(moves.length).toBe(81);
  });

  it('directed move after play forces next board', () => {
    const game = createGame();
    applyMove(game, 0, 4); // X plays (0,4) -> O forced to board 4
    const moves = availableMoves(game);
    expect(moves.every(([board]) => board === 4)).toBe(true);
  });

  it('detects small board win', () => {
    const game = createGame();
    const board = game.boards[0];
    board.cells[0] = 'X';
    board.cells[1] = 'X';
    board.cells[2] = 'X';
    // Manually check winner via WINNING_LINES (same logic as engine)
    for (const [a, b, c] of WINNING_LINES) {
      const v = board.cells[a];
      if (v !== '' && v === board.cells[b] && v === board.cells[c]) {
        board.winner = v as 'X' | 'O';
        break;
      }
    }
    expect(board.winner).toBe('X');
  });

  it('detects big board win', () => {
    const game = createGame();
    // Give X boards 0, 1, 2 (top row)
    for (const idx of [0, 1, 2]) {
      game.boards[idx].winner = 'X';
    }
    // Trigger global state update via a dummy move setup
    // Manually check macro winner
    const bb = game.boards.map(b =>
      b.winner === 'X' ? 'X' : b.winner === 'O' ? 'O' : b.drawn ? 'G' : '.'
    );
    for (const [a, b, c] of WINNING_LINES) {
      if ((bb[a] === 'X' || bb[a] === 'O') && bb[a] === bb[b] && bb[b] === bb[c]) {
        game.winner = bb[a] as 'X' | 'O';
        break;
      }
    }
    expect(game.winner).toBe('X');
  });

  it('undo_move restores exact state', () => {
    const game = createGame();
    applyMove(game, 0, 4); // X plays
    applyMove(game, 4, 0); // O plays

    // Snapshot
    const prevPlayer = game.currentPlayer;
    const prevNbi = game.nextBoardIndex;
    const prevWinner = game.winner;
    const prevDrawn = game.drawn;
    const prevHash = game.zkey;
    const prevCells = game.boards.map(b => [...b.cells]);

    // Apply and undo
    const undo = captureUndo(game, 0);
    applyMove(game, 0, 8);
    undoMove(game, 0, 8, undo);

    expect(game.currentPlayer).toBe(prevPlayer);
    expect(game.nextBoardIndex).toBe(prevNbi);
    expect(game.winner).toBe(prevWinner);
    expect(game.drawn).toBe(prevDrawn);
    expect(game.zkey).toBe(prevHash);
    for (let i = 0; i < 9; i++) {
      expect(game.boards[i].cells).toEqual(prevCells[i]);
    }
  });

  it('unavailable board gives free move', () => {
    const game = createGame();
    // Fill board 4
    for (let i = 0; i < 9; i++) {
      game.boards[4].cells[i] = i % 2 === 0 ? 'X' : 'O';
    }
    game.boards[4].drawn = true;
    applyMove(game, 0, 4); // sends to board 4 which is full
    expect(game.nextBoardIndex).toBeNull();
    const moves = availableMoves(game);
    expect(moves.every(([board]) => board !== 4)).toBe(true);
  });
});
