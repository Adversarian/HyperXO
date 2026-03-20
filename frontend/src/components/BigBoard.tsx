import type { GameState } from '../types';
import SmallBoard from './SmallBoard';

interface Props {
  game: GameState;
  onCellClick: (boardIndex: number, cellIndex: number) => void;
  disabled: boolean;
}

export default function BigBoard({ game, onCellClick, disabled }: Props) {
  const availableByBoard = new Map<number, Set<number>>();
  for (const m of game.availableMoves) {
    if (!availableByBoard.has(m.board)) {
      availableByBoard.set(m.board, new Set());
    }
    availableByBoard.get(m.board)!.add(m.cell);
  }

  const activeBoards = new Set(game.availableBoards);

  return (
    <div className="grid grid-cols-3 grid-rows-3 gap-1 sm:gap-3 p-1.5 sm:p-4 rounded-xl sm:rounded-2xl bg-zinc-900/80 border border-zinc-700/50 shadow-2xl">
      {game.boards.map((board) => (
        <SmallBoard
          key={board.index}
          board={board}
          bigIndex={board.index}
          isActive={activeBoards.has(board.index)}
          availableCells={availableByBoard.get(board.index) ?? new Set()}
          lastMove={game.lastMove}
          onCellClick={onCellClick}
          disabled={disabled}
        />
      ))}
    </div>
  );
}
