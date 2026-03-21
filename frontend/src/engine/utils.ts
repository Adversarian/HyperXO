import { availableMoves, type HyperXOGame, type Player } from './game';
import type { GameState, MoveEntry } from '../types';

/** Convert engine state to the UI-facing GameState. */
export function engineToGameState(
  engine: HyperXOGame,
  id: string,
  lastMove?: MoveEntry,
): GameState {
  const moves = availableMoves(engine);
  return {
    id,
    currentPlayer: engine.currentPlayer,
    nextBoardIndex: engine.nextBoardIndex,
    winner: engine.winner,
    drawn: engine.drawn,
    boards: engine.boards.map((b, i) => ({
      index: i,
      cells: b.cells.map(c => c === '' ? '' : c),
      winner: b.winner,
      drawn: b.drawn,
      condemned: b.condemned,
    })),
    availableMoves: moves.map(([board, cell]) => ({ board, cell })),
    availableBoards: [...new Set(moves.map(([b]) => b))].sort((a, b) => a - b),
    moveLog: [],
    lastMove,
    aiPending: false,
  };
}

/** Check if a board is live (not won, drawn, condemned, and has empty cells). */
export function isBoardLive(engine: HyperXOGame, idx: number): boolean {
  const b = engine.boards[idx];
  return !b.winner && !b.drawn && !b.condemned && b.cells.some(c => c === '');
}

/** Detect boards that were won since a previous snapshot of winners. */
export function getNewlyWonBoards(
  engine: HyperXOGame,
  prevWinners: (Player | null)[],
): { winner: Player; i: number }[] {
  return engine.boards
    .map((b, i) => ({ winner: b.winner, i }))
    .filter((x): x is { winner: Player; i: number } => x.winner !== null && x.winner !== prevWinners[x.i]);
}
