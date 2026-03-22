import { useState } from 'react';
import {
  CARD_CATALOG,
  CATEGORY_COLORS,
  getAvailableCards,
  isCardUsed,
  type PowerUpState,
  type ActiveCard,
  type PowerUpCategory,
} from '../engine/powerups';

const ACTIVATE_HOVER: Record<PowerUpCategory, string> = {
  strike:     'hover:bg-rose-500/40',
  tactics:    'hover:bg-sky-500/40',
  disruption: 'hover:bg-violet-500/40',
  doctrine:   'hover:bg-amber-500/40',
};

interface Props {
  state: PowerUpState;
  onActivate: (card: ActiveCard) => void;
  activatingCard: ActiveCard | null;
  disabled: boolean;
  vertical?: boolean;
}

export default function CardTray({ state, onActivate, activatingCard, disabled, vertical }: Props) {
  const [flippedCards, setFlippedCards] = useState<Set<string>>(new Set());
  const actives = getAvailableCards(state);
  const allActives: ActiveCard[] = [state.draft.strike, state.draft.tactics, state.draft.disruption];
  const doctrine = CARD_CATALOG[state.draft.doctrine];
  const doctrineColors = CATEGORY_COLORS.doctrine;

  const toggleFlip = (id: string) => {
    setFlippedCards(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleActivate = (cardId: ActiveCard) => {
    setFlippedCards(prev => {
      const next = new Set(prev);
      next.delete(cardId);
      return next;
    });
    onActivate(cardId);
  };

  const wrapClass = vertical
    ? 'flex flex-col items-stretch gap-1.5 w-full'
    : 'flex items-center gap-1.5 sm:gap-2 flex-wrap justify-center';

  const faceBase = vertical
    ? 'flex flex-col items-center justify-center rounded-lg px-2 py-1.5 ring-1 text-xs w-full min-h-[5.5rem]'
    : 'flex flex-col items-center justify-center rounded-lg px-3 py-2 sm:px-4 sm:py-2.5 ring-1 text-xs sm:text-sm min-w-[4.5rem] sm:min-w-[5.5rem]';

  const dividerClass = vertical
    ? 'h-px w-full bg-zinc-700 my-0.5'
    : 'w-px h-8 bg-zinc-700 mx-0.5';

  return (
    <div className={vertical ? 'flex flex-col items-stretch gap-1.5 w-full' : 'flex flex-col items-center gap-1.5 w-full max-w-lg'}>
      <div className={wrapClass}>
        {allActives.map(cardId => {
          const card = CARD_CATALOG[cardId];
          const colors = CATEGORY_COLORS[card.category];
          const used = isCardUsed(state, cardId);
          const isActivating = activatingCard === cardId;
          const canUse = !used && !disabled && actives.includes(cardId);
          const isFlipped = flippedCards.has(cardId);

          const frontStyle = used
            ? `bg-zinc-900 ring-zinc-800 ${colors.used} opacity-40`
            : isActivating
              ? `${colors.bg} ring-2 ${colors.ring} ${colors.text} animate-pulse`
              : canUse
                ? `${colors.bg} ${colors.ring} ${colors.text} hover:ring-2`
                : `${colors.bg} ring-zinc-700 ${colors.text} opacity-50`;

          return (
            <div key={cardId} className={`[perspective:800px] ${vertical ? 'w-full' : ''}`}>
              <div className={`grid transition-transform duration-500 ease-out [transform-style:preserve-3d] ${isFlipped ? '[transform:rotateY(180deg)]' : ''}`}>
                {/* Front face */}
                <div
                  onClick={() => toggleFlip(cardId)}
                  className={`[grid-area:1/1] ${faceBase} ${frontStyle} [backface-visibility:hidden] cursor-pointer select-none`}
                >
                  <span className="font-semibold leading-tight">{card.name}</span>
                  <span className={`text-[10px] sm:text-xs ${used ? 'opacity-40' : 'opacity-50'}`}>{card.flavor}</span>
                </div>
                {/* Back face */}
                <div
                  onClick={() => toggleFlip(cardId)}
                  className={`[grid-area:1/1] ${faceBase} [backface-visibility:hidden] [transform:rotateY(180deg)] bg-zinc-950 ring-1 ${colors.ring} cursor-pointer select-none`}
                >
                  <span className="text-[10px] sm:text-xs text-zinc-300 max-w-[9rem] text-center leading-snug">
                    {card.description}
                  </span>
                  {canUse && (
                    <button
                      onClick={(e) => { e.stopPropagation(); handleActivate(cardId); }}
                      className={`mt-1.5 px-3 py-0.5 rounded-full text-[10px] sm:text-xs font-semibold ${colors.text} ring-1 ${colors.ring} hover:ring-2 ${ACTIVATE_HOVER[card.category]} transition-all`}
                    >
                      Activate
                    </button>
                  )}
                  {used && (
                    <span className="mt-1 text-[9px] sm:text-[10px] text-zinc-600 uppercase tracking-wider">Used</span>
                  )}
                </div>
              </div>
            </div>
          );
        })}

        <div className={dividerClass} />

        {/* Doctrine card */}
        <div className={`[perspective:800px] ${vertical ? 'w-full' : ''}`}>
          <div className={`grid transition-transform duration-500 ease-out [transform-style:preserve-3d] ${flippedCards.has('doctrine') ? '[transform:rotateY(180deg)]' : ''}`}>
            <div
              onClick={() => toggleFlip('doctrine')}
              className={`[grid-area:1/1] ${faceBase} ${doctrineColors.bg} ${doctrineColors.ring} ${doctrineColors.text} [backface-visibility:hidden] cursor-pointer select-none`}
            >
              <span className="font-semibold leading-tight">{doctrine.name}</span>
              <span className="text-[10px] sm:text-xs opacity-50">Passive</span>
            </div>
            <div
              onClick={() => toggleFlip('doctrine')}
              className={`[grid-area:1/1] ${faceBase} [backface-visibility:hidden] [transform:rotateY(180deg)] bg-zinc-950 ring-1 ${doctrineColors.ring} cursor-pointer select-none`}
            >
              <span className="text-[10px] sm:text-xs text-zinc-300 max-w-[9rem] text-center leading-snug">
                {doctrine.description}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
