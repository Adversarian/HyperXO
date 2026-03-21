import { useState } from 'react';
import {
  CARD_CATALOG,
  getAvailableCards,
  isCardUsed,
  type PowerUpState,
  type ActiveCard,
  type PowerUpCategory,
} from '../engine/powerups';

interface Props {
  state: PowerUpState;
  onActivate: (card: ActiveCard) => void;
  activatingCard: ActiveCard | null;
  disabled: boolean;
}

const CATEGORY_COLORS: Record<PowerUpCategory, { bg: string; ring: string; text: string; used: string }> = {
  strike: { bg: 'bg-rose-500/15', ring: 'ring-rose-500/60', text: 'text-rose-400', used: 'text-rose-800' },
  tactics: { bg: 'bg-sky-500/15', ring: 'ring-sky-500/60', text: 'text-sky-400', used: 'text-sky-800' },
  disruption: { bg: 'bg-violet-500/15', ring: 'ring-violet-500/60', text: 'text-violet-400', used: 'text-violet-800' },
  doctrine: { bg: 'bg-amber-500/15', ring: 'ring-amber-500/60', text: 'text-amber-400', used: 'text-amber-800' },
};

export default function CardTray({ state, onActivate, activatingCard, disabled }: Props) {
  const [expandedCard, setExpandedCard] = useState<string | null>(null);
  const actives = getAvailableCards(state);
  const allActives: ActiveCard[] = [state.draft.strike, state.draft.tactics, state.draft.disruption];
  const doctrine = CARD_CATALOG[state.draft.doctrine];
  const doctrineColors = CATEGORY_COLORS.doctrine;

  return (
    <div className="flex flex-col items-center gap-1.5 w-full max-w-lg">
      <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap justify-center">
        {allActives.map(cardId => {
          const card = CARD_CATALOG[cardId];
          const colors = CATEGORY_COLORS[card.category];
          const used = isCardUsed(state, cardId);
          const isActivating = activatingCard === cardId;
          const canUse = !used && !disabled && actives.includes(cardId);
          const isExpanded = expandedCard === cardId;

          return (
            <button
              key={cardId}
              onClick={() => {
                if (isExpanded && canUse) {
                  setExpandedCard(null);
                  onActivate(cardId);
                } else if (!used) {
                  setExpandedCard(isExpanded ? null : cardId);
                }
              }}
              disabled={used}
              className={`
                flex flex-col items-center rounded-lg px-3 py-2 sm:px-4 sm:py-2.5 ring-1 transition-all text-xs sm:text-sm min-w-[4.5rem] sm:min-w-[5.5rem]
                ${used
                  ? `bg-zinc-900 ring-zinc-800 ${colors.used} line-through opacity-40`
                  : isActivating
                    ? `${colors.bg} ring-2 ${colors.ring} ${colors.text} animate-pulse`
                    : canUse
                      ? `${colors.bg} ${colors.ring} ${colors.text} hover:ring-2 cursor-pointer`
                      : `${colors.bg} ring-zinc-700 ${colors.text} opacity-50`
                }
              `}
            >
              <span className="font-semibold leading-tight">{card.name}</span>
              {isExpanded && !used ? (
                <span className={`text-[10px] sm:text-xs mt-0.5 opacity-80 max-w-[8rem] text-center leading-snug`}>
                  {card.description}
                </span>
              ) : (
                <span className={`text-[10px] sm:text-xs ${used ? 'opacity-40' : 'opacity-50'}`}>{card.flavor}</span>
              )}
              {isExpanded && canUse && (
                <span className="text-[9px] sm:text-[10px] mt-0.5 opacity-60">tap again to use</span>
              )}
            </button>
          );
        })}

        <div className="w-px h-8 bg-zinc-700 mx-0.5" />

        <button
          onClick={() => setExpandedCard(expandedCard === 'doctrine' ? null : 'doctrine')}
          className={`flex flex-col items-center rounded-lg px-3 py-2 sm:px-4 sm:py-2.5 ring-1 ${doctrineColors.bg} ${doctrineColors.ring} ${doctrineColors.text} text-xs sm:text-sm min-w-[4.5rem] sm:min-w-[5.5rem]`}
        >
          <span className="font-semibold leading-tight">{doctrine.name}</span>
          {expandedCard === 'doctrine' ? (
            <span className="text-[10px] sm:text-xs mt-0.5 opacity-80 max-w-[8rem] text-center leading-snug">
              {doctrine.description}
            </span>
          ) : (
            <span className="text-[10px] sm:text-xs opacity-50">Passive</span>
          )}
        </button>
      </div>
    </div>
  );
}
