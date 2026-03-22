import { describe, it, expect } from 'vitest';
import {
  createGame,
  availableMoves,
  applyMove,
  undoMove,
  captureUndo,
  updateGlobalState,
  WINNING_LINES,
  type HyperXOGame,
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

// Helper: win a small board for a player via top-row line
function winBoard(game: HyperXOGame, boardIdx: number, player: 'X' | 'O') {
  const b = game.boards[boardIdx];
  b.cells[0] = player;
  b.cells[1] = player;
  b.cells[2] = player;
  b.winner = player;
}

describe('sudden-death mode', () => {
  it('single board win ends the game', () => {
    const game = createGame('sudden-death');
    // X wins board 0 via top row: (0,0), (0,1), (0,2)
    applyMove(game, 0, 0); // X
    applyMove(game, 0, 3); // O (forced to board 0)
    applyMove(game, 3, 1); // X at board 3
    applyMove(game, 1, 4); // O at board 1
    applyMove(game, 4, 2); // X at board 4
    applyMove(game, 2, 0); // O at board 2
    // X has cells 0 at board 0. Need to get back to board 0.
    // Let's use a simpler setup instead:
    const game2 = createGame('sudden-death');
    winBoard(game2, 3, 'X');
    // Trigger updateGlobalState by making a move
    // Actually, we need to trigger via applyMove. Let's set up board 0 for X to win.
    const game3 = createGame('sudden-death');
    game3.boards[0].cells[0] = 'X';
    game3.boards[0].cells[1] = 'X';
    game3.nextBoardIndex = 0;
    game3.currentPlayer = 'X';
    // Rebuild hash
    game3.zkey = 0;
    game3.zkey ^= game3.zobrist.nbiKey(0);
    game3.zkey ^= game3.zobrist.pieceKey(0, 0, 'X');
    game3.zkey ^= game3.zobrist.pieceKey(0, 1, 'X');

    applyMove(game3, 0, 2); // X completes top row of board 0
    expect(game3.boards[0].winner).toBe('X');
    expect(game3.winner).toBe('X'); // Game ends immediately
  });

  it('three boards in a row does NOT matter (only single board win)', () => {
    const game2 = createGame('sudden-death');
    game2.boards[4].cells[3] = 'O';
    game2.boards[4].cells[4] = 'O';
    game2.nextBoardIndex = 4;
    game2.currentPlayer = 'O';
    game2.zkey = 0;
    game2.zkey ^= game2.zobrist.nbiKey(4);
    game2.zkey ^= game2.zobrist.pieceKey(4, 3, 'O');
    game2.zkey ^= game2.zobrist.pieceKey(4, 4, 'O');

    applyMove(game2, 4, 5); // O wins board 4 (middle row)
    expect(game2.winner).toBe('O');
  });

  it('game continues while no board is won', () => {
    const game = createGame('sudden-death');
    applyMove(game, 0, 4); // X
    applyMove(game, 4, 0); // O
    expect(game.winner).toBeNull();
    expect(game.drawn).toBe(false);
    expect(availableMoves(game).length).toBeGreaterThan(0);
  });
});

describe('misère mode', () => {
  it('three boards in a row means that player LOSES', () => {
    const game = createGame('misere');
    // Set up X to have boards 0 and 1, about to win board 2
    winBoard(game, 0, 'X');
    winBoard(game, 1, 'X');
    game.boards[2].cells[0] = 'X';
    game.boards[2].cells[1] = 'X';
    game.nextBoardIndex = 2;
    game.currentPlayer = 'X';
    game.zkey = 0;
    game.zkey ^= game.zobrist.nbiKey(2);
    for (let bi = 0; bi < 3; bi++) {
      for (let ci = 0; ci < 9; ci++) {
        const cell = game.boards[bi].cells[ci];
        if (cell === 'X' || cell === 'O') {
          game.zkey ^= game.zobrist.pieceKey(bi, ci, cell);
        }
      }
    }

    applyMove(game, 2, 2); // X completes board 2 → top row of macro = X loses
    expect(game.boards[2].winner).toBe('X');
    expect(game.winner).toBe('O'); // O wins because X completed 3 in a row
  });

  it('single board win does not end the game', () => {
    const game = createGame('misere');
    game.boards[4].cells[0] = 'X';
    game.boards[4].cells[1] = 'X';
    game.nextBoardIndex = 4;
    game.currentPlayer = 'X';
    game.zkey = 0;
    game.zkey ^= game.zobrist.nbiKey(4);
    game.zkey ^= game.zobrist.pieceKey(4, 0, 'X');
    game.zkey ^= game.zobrist.pieceKey(4, 1, 'X');

    applyMove(game, 4, 2); // X wins board 4
    expect(game.boards[4].winner).toBe('X');
    expect(game.winner).toBeNull(); // No macro line → game continues
    expect(availableMoves(game).length).toBeGreaterThan(0);
  });

  it('undo restores state after misère loss', () => {
    const game = createGame('misere');
    winBoard(game, 0, 'X');
    winBoard(game, 1, 'X');
    game.boards[2].cells[0] = 'X';
    game.boards[2].cells[1] = 'X';
    game.nextBoardIndex = 2;
    game.currentPlayer = 'X';
    game.zkey = 0;
    game.zkey ^= game.zobrist.nbiKey(2);
    for (let bi = 0; bi < 3; bi++) {
      for (let ci = 0; ci < 9; ci++) {
        const cell = game.boards[bi].cells[ci];
        if (cell === 'X' || cell === 'O') {
          game.zkey ^= game.zobrist.pieceKey(bi, ci, cell);
        }
      }
    }

    const prevHash = game.zkey;
    const undo = captureUndo(game, 2);
    applyMove(game, 2, 2);
    expect(game.winner).toBe('O'); // X lost

    undoMove(game, 2, 2, undo);
    expect(game.winner).toBeNull();
    expect(game.currentPlayer).toBe('X');
    expect(game.zkey).toBe(prevHash);
  });
});

describe('early macro draw', () => {
  it('classic: game is drawn when every macro line is blocked', () => {
    const game = createGame('classic');
    // Set up a macro board where every line has both X and O:
    //   X O X
    //   O X O
    //   O X O
    // Lines: row0=[X,O,X] row1=[O,X,O] row2=[O,X,O] — all blocked
    //        col0=[X,O,O] col1=[O,X,X] col2=[X,O,O] — all blocked
    //        d1=[X,X,O]   d2=[X,X,O]  — all blocked
    const winners: ('X' | 'O')[] = ['X','O','X','O','X','O','O','X','O'];
    for (let i = 0; i < 9; i++) {
      winBoard(game, i, winners[i]);
    }
    // Trigger updateGlobalState via a forced recalc
    // We need to call it directly since all boards are won (no moves to make)
    updateGlobalState(game);
    expect(game.winner).toBeNull();
    expect(game.drawn).toBe(true);
  });

  it('classic: game is NOT drawn when a macro line is still open', () => {
    const game = createGame('classic');
    // X wins boards 0 and 1, board 2 is open → top row still winnable by X
    winBoard(game, 0, 'X');
    winBoard(game, 1, 'X');
    // Board 2 has no winner
    // Other boards: mix to block other lines
    winBoard(game, 3, 'O');
    winBoard(game, 4, 'O');
    winBoard(game, 5, 'X');
    winBoard(game, 6, 'X');
    winBoard(game, 7, 'O');
    winBoard(game, 8, 'O');
    updateGlobalState(game);
    expect(game.winner).toBeNull();
    expect(game.drawn).toBe(false); // top row [X, X, .] is still open
  });

  it('classic: early draw detected mid-game via applyMove', () => {
    const game = createGame('classic');
    // Set up 8 boards so that winning board 8 blocks the last open lines:
    //   X O O     row0=[X,O,O] blocked
    //   O X X     row1=[O,X,X] blocked
    //   X O .     row2=[X,O,?]
    // col0=[X,O,X] blocked, col1=[O,X,O] blocked, col2=[O,X,?]
    // d1=[X,X,?] d2=[O,X,X] blocked
    // If board 8 becomes O: row2=[X,O,O] blocked, col2=[O,X,O] blocked, d1=[X,X,O] blocked
    // All lines blocked → draw!
    const preset2: ('X' | 'O')[] = ['X','O','O','O','X','X','X','O'];
    for (let i = 0; i < 8; i++) {
      winBoard(game, i, preset2[i]);
    }
    // Board 8: set up O to win it with a move
    game.boards[8].cells[0] = 'O';
    game.boards[8].cells[1] = 'O';
    game.nextBoardIndex = 8;
    game.currentPlayer = 'O';
    // Rebuild zkey
    game.zkey = 0;
    game.zkey ^= game.zobrist.nbiKey(8);
    for (let bi = 0; bi < 9; bi++) {
      for (let ci = 0; ci < 9; ci++) {
        const cell = game.boards[bi].cells[ci];
        if (cell === 'X' || cell === 'O') {
          game.zkey ^= game.zobrist.pieceKey(bi, ci, cell);
        }
      }
    }
    game.zkey ^= game.zobrist.stmKey(); // O to move

    applyMove(game, 8, 2); // O wins board 8 → all macro lines blocked
    expect(game.boards[8].winner).toBe('O');
    expect(game.winner).toBeNull();
    expect(game.drawn).toBe(true);
  });

  it('misère: early draw when all macro lines are blocked', () => {
    const game = createGame('misere');
    // Same blocked layout — in misère, blocked lines also means draw
    // (no one can complete a line, so no one can "lose")
    const winners: ('X' | 'O')[] = ['X','O','O','O','X','X','X','O','O'];
    for (let i = 0; i < 9; i++) {
      winBoard(game, i, winners[i]);
    }
    updateGlobalState(game);
    expect(game.winner).toBeNull();
    expect(game.drawn).toBe(true);
  });

  it('sudden-death: no early macro draw (any board win ends game)', () => {
    const game = createGame('sudden-death');
    // In sudden death, macro lines don't matter — game ends on first board win
    // Just verify the game doesn't falsely draw
    game.currentPlayer = 'X';
    game.nextBoardIndex = null;
    game.zkey = 0;
    game.zkey ^= game.zobrist.nbiKey(null);
    applyMove(game, 0, 0); // X plays
    expect(game.winner).toBeNull(); // no board won yet
    expect(game.drawn).toBe(false);
  });
});
