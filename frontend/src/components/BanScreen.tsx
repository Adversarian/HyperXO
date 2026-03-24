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
  playerLabel?: string;
}

const ACTIVE_CATS = CATEGORIES.filter(cat => cat.key !== 'doctrine');
const PASSIVE_CATS = CATEGORIES.filter(cat => cat.key === 'doctrine');

export default function BanScreen({ onBanReady, onBack, playerLabel }: Props) {
  const [ban, setBan] = useState<PowerUpCard | null>(null);

  const renderCard = (cardId: PowerUpCard) => {
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
  };

  return (
    <div className="flex flex-col items-center gap-6 px-4 max-w-4xl mx-auto">
      <div className="w-full flex items-center justify-between">
        <button onClick={onBack} className="text-zinc-500 hover:text-zinc-300 text-sm transition-colors">
          &larr; Back
        </button>
        <h2 className="text-zinc-200 text-lg font-semibold">{playerLabel ? `${playerLabel} — Ban` : 'Ban Phase'}</h2>
        <div className="w-12" />
      </div>
      <p className="text-zinc-500 text-sm">Ban one card to remove it from both players' draft pools, or skip.</p>

      {/* row-count: 1 divider + 1 header + 3 cards = 5 rows */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-2 w-full lg:grid-rows-[auto_auto_1fr_1fr_1fr]">
        {/* Active divider */}
        <div className="col-span-1 sm:col-span-2 lg:col-span-3 flex items-center gap-3">
          <div className="flex-1 h-px bg-zinc-700/60" />
          <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Active</span>
          <div className="flex-1 h-px bg-zinc-700/60" />
        </div>
        {/* Passive divider */}
        <div className="col-span-1 flex items-center gap-3">
          <div className="flex-1 h-px bg-zinc-700/60" />
          <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Passive</span>
          <div className="flex-1 h-px bg-zinc-700/60" />
        </div>

        {/* Active categories — each spans 4 subgrid rows (header + 3 cards) */}
        {ACTIVE_CATS.map(cat => {
          const colors = CATEGORY_COLORS[cat.key];
          return (
            <div key={cat.key} className="grid grid-rows-subgrid row-span-4 gap-2">
              <h3 className={`text-sm font-semibold text-center ${colors.text}`}>{cat.label}</h3>
              {cat.cards.map(renderCard)}
            </div>
          );
        })}

        {/* Passive category */}
        {PASSIVE_CATS.map(cat => {
          const colors = CATEGORY_COLORS[cat.key];
          return (
            <div key={cat.key} className="grid grid-rows-subgrid row-span-4 gap-2">
              <h3 className={`text-sm font-semibold text-center ${colors.text}`}>{cat.label}</h3>
              {cat.cards.map(renderCard)}
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
