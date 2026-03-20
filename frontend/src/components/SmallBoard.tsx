import type { BoardState } from '../types';

interface Props {
  board: BoardState;
  bigIndex: number;
  isActive: boolean;
  availableCells: Set<number>;
  lastMove?: { boardIndex: number; cellIndex: number };
  onCellClick: (boardIndex: number, cellIndex: number) => void;
  disabled: boolean;
}

export default function SmallBoard({
  board,
  bigIndex,
  isActive,
  availableCells,
  lastMove,
  onCellClick,
  disabled,
}: Props) {
  const resolved = board.winner || board.drawn;

  // Strong color fill for won boards
  const bgColor = resolved
    ? board.winner === 'X'
      ? 'bg-cyan-500/20 ring-2 ring-cyan-400/50'
      : board.winner === 'O'
        ? 'bg-rose-500/20 ring-2 ring-rose-400/50'
        : 'bg-zinc-700/30'
    : isActive && !disabled
      ? 'bg-indigo-500/10 ring-2 ring-indigo-400 shadow-lg shadow-indigo-500/20'
      : 'bg-zinc-600/40';

  return (
    <div className={`relative grid grid-cols-3 grid-rows-3 gap-px sm:gap-0.5 rounded-lg sm:rounded-xl p-1 sm:p-1.5 transition-all duration-200 ${bgColor}`}>
      {/* Won/drawn overlay */}
      {resolved && (
        <div className={`absolute inset-0 z-10 flex items-center justify-center rounded-xl ${
          board.winner === 'X'
            ? 'bg-cyan-950'
            : board.winner === 'O'
              ? 'bg-rose-950'
              : 'bg-zinc-900'
        }`}>
          <span className={`text-3xl sm:text-6xl font-black drop-shadow-lg ${
            board.winner === 'X'
              ? 'text-cyan-400'
              : board.winner === 'O'
                ? 'text-rose-400'
                : 'text-zinc-600 !text-xl sm:!text-4xl'
          }`}>
            {board.winner ?? 'Draw'}
          </span>
        </div>
      )}

      {board.cells.map((cell, cellIdx) => {
        const playable = isActive && availableCells.has(cellIdx) && !disabled;
        const isLastMove =
          lastMove?.boardIndex === bigIndex && lastMove?.cellIndex === cellIdx;

        return (
          <button
            key={cellIdx}
            disabled={!playable}
            onClick={() => playable && onCellClick(bigIndex, cellIdx)}
            className={`
              flex h-8 w-8 items-center justify-center rounded text-sm font-bold transition-all duration-150
              sm:h-14 sm:w-14 sm:text-xl sm:rounded-md
              ${cell === 'X' ? 'text-cyan-400' : cell === 'O' ? 'text-rose-400' : ''}
              ${isLastMove ? 'ring-2 ring-yellow-400/70 bg-yellow-400/10' : ''}
              ${
                playable
                  ? 'cursor-pointer bg-zinc-700/40 hover:bg-indigo-500/30 hover:scale-105 active:scale-95'
                  : cell
                    ? 'bg-zinc-800/30'
                    : 'bg-zinc-800/20'
              }
            `}
          >
            {cell || null}
          </button>
        );
      })}
    </div>
  );
}
