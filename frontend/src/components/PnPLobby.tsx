import { useState } from 'react';
import Mark from './Mark';

interface Props {
  onStart: (nameX: string, nameO: string) => void;
  onBack: () => void;
}

export default function PnPLobby({ onStart, onBack }: Props) {
  const [nameX, setNameX] = useState('');
  const [nameO, setNameO] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onStart(nameX.trim() || 'Player X', nameO.trim() || 'Player O');
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col items-center gap-6 px-4 w-full max-w-sm">
      <div className="w-full flex items-center justify-between">
        <button type="button" onClick={onBack} className="text-zinc-500 hover:text-zinc-300 text-sm transition-colors">
          &larr; Menu
        </button>
        <h2 className="text-zinc-200 text-lg font-semibold">Pass &amp; Play</h2>
        <div className="w-12" />
      </div>

      <p className="text-zinc-500 text-sm text-center">Enter player names</p>

      <div className="w-full flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-cyan-400 flex items-center gap-1.5">
            <Mark mark="X" /> Player 1
          </label>
          <input
            type="text"
            value={nameX}
            onChange={(e) => setNameX(e.target.value)}
            placeholder="Player X"
            maxLength={16}
            autoFocus
            className="w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2 text-zinc-200 text-sm placeholder:text-zinc-600 focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/30 transition-colors"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-rose-400 flex items-center gap-1.5">
            <Mark mark="O" /> Player 2
          </label>
          <input
            type="text"
            value={nameO}
            onChange={(e) => setNameO(e.target.value)}
            placeholder="Player O"
            maxLength={16}
            className="w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2 text-zinc-200 text-sm placeholder:text-zinc-600 focus:outline-none focus:border-rose-500/50 focus:ring-1 focus:ring-rose-500/30 transition-colors"
          />
        </div>
      </div>

      <button
        type="submit"
        className="w-full rounded-xl bg-indigo-500 px-6 py-2.5 text-white font-semibold hover:bg-indigo-400 transition-colors shadow-lg shadow-indigo-500/25 active:scale-[0.98]"
      >
        Continue
      </button>
    </form>
  );
}
