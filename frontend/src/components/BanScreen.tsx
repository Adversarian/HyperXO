import { useState } from 'react';
import {
  CATEGORIES,
  CARD_CATALOG,
  CATEGORY_COLORS,
  type PowerUpCard,
} from '../engine/powerups';

interface Props {
  onBanReady: (ban: PowerUpCard | null) => void;
  onBack: () => void;
}

export default function BanScreen({ onBanReady, onBack }: Props) {
  const [ban, setBan] = useState<PowerUpCard | null>(null);

  return (
    <div className="flex flex-col items-center gap-6 px-4 max-w-4xl mx-auto">
      <div className="w-full flex items-center justify-between">
        <button onClick={onBack} className="text-zinc-500 hover:text-zinc-300 text-sm transition-colors">
          &larr; Back
        </button>
        <h2 className="text-zinc-200 text-lg font-semibold">Ban Phase</h2>
        <div className="w-12" />
      </div>
      <p className="text-zinc-500 text-sm">Ban one card to remove it from both players' draft pools, or skip.</p>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 w-full">
        {CATEGORIES.map(cat => {
          const colors = CATEGORY_COLORS[cat.key];
          return (
            <div key={cat.key} className="flex flex-col gap-2">
              <h3 className={`text-sm font-semibold text-center ${colors.text}`}>{cat.label}</h3>
              {cat.cards.map(cardId => {
                const card = CARD_CATALOG[cardId];
                const isBanned = ban === cardId;
                return (
                  <button
                    key={cardId}
                    onClick={() => setBan(isBanned ? null : cardId)}
                    className={`
                      text-left rounded-xl p-3 ring-1 transition-all
                      ${isBanned
                        ? 'bg-red-500/20 ring-2 ring-red-500/60'
                        : 'bg-zinc-800/50 ring-zinc-700/50 hover:ring-zinc-600 hover:bg-zinc-800'
                      }
                    `}
                  >
                    <div className="flex items-center justify-between">
                      <span className={`text-sm font-medium ${isBanned ? 'text-red-400 line-through' : 'text-zinc-200'}`}>
                        {card.name}
                      </span>
                      <span className={`text-xs ${isBanned ? 'text-red-400' : 'text-zinc-600'}`}>
                        {isBanned ? 'Banned' : card.flavor}
                      </span>
                    </div>
                    <p className="text-xs text-zinc-400 mt-1">{card.description}</p>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>

      <button
        onClick={() => onBanReady(ban)}
        className="rounded-xl px-8 py-3 font-semibold transition-all bg-indigo-500 text-white hover:bg-indigo-400 shadow-lg shadow-indigo-500/25 active:scale-[0.98]"
      >
        {ban ? 'Confirm Ban' : 'Skip Ban'}
      </button>
    </div>
  );
}
