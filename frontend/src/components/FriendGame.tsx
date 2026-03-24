import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { GameState, TurnPhase, MoveEntry } from '../types';
import type { PowerUpDraft, PowerUpState, ActiveCard, PowerUpCard, SiegeThreat } from '../engine/powerups';
import {
  createPowerUpState,
  useCard as markCardUsed,
  CARD_CATALOG,
  applyRecall,
  applySabotage,
  applyOverwrite,
  applySwap,
  applyShatter,
  applyCondemn,
  applyRedirect,
  applyGravity,
  computeGravity,
  refreshSiegeThreats,
  advanceSiegeThreats,
  applySiegeClaim,
  rechargeRandomCard,
} from '../engine/powerups';
import {
  createGame as createEngine,
  availableMoves,
  applyMove as engineApply,
  type HyperXOGame,
  type Player,
} from '../engine/game';
import { engineToGameState as _engineToGameState, isBoardLive, getNewlyWonBoards } from '../engine/utils';
import BigBoard from './BigBoard';
import GameStatus from './GameStatus';
import CardTray from './CardTray';
import BanScreen from './BanScreen';
import DraftScreen from './DraftScreen';

import type { GameMode } from '../types';

interface Props {
  ws: WebSocket;
  myName: string;
  opponentName: string;
  mySymbol: 'X' | 'O';
  gambits: boolean;
  gameMode?: GameMode;
  conquestBonusBoards?: number[];
  onBack: () => void;
}

type Phase = 'ban' | 'waiting-bans' | 'draft' | 'waiting-draft' | 'playing';

const toGameState = (engine: HyperXOGame, lastMove?: MoveEntry) =>
  _engineToGameState(engine, 'p2p', lastMove);

export default function FriendGame({ ws, myName, opponentName, mySymbol, gambits, gameMode = 'classic', conquestBonusBoards, onBack }: Props) {
  // ===== Core state =====
  const [game, setGame] = useState<GameState | null>(null);
  const [peerLeft, setPeerLeft] = useState(false);
  const [phase, setPhase] = useState<Phase>(gambits ? 'ban' : 'playing');
  const engineRef = useRef<HyperXOGame | null>(null);

  // ===== Gambit state =====
  const [myPU, setMyPU] = useState<PowerUpState | null>(null);
  const [activatingCard, setActivatingCard] = useState<ActiveCard | null>(null);
  const [cardUsedThisTurn, setCardUsedThisTurn] = useState<ActiveCard | null>(null);
  const [turnPhase, setTurnPhase] = useState<TurnPhase>('normal');
  const [flashBoards, setFlashBoards] = useState<Map<number, string>>(new Map());
  const [opponentCardNotice, setOpponentCardNotice] = useState<string | null>(null);
  const [siegeThreats, setSiegeThreats] = useState<SiegeThreat[]>([]);
  const [opponentSiegeDisplay, setOpponentSiegeDisplay] = useState<SiegeThreat[]>([]);
  const [recallSource, setRecallSource] = useState<{ boardIdx: number; cellIdx: number } | null>(null);
  const [gravityAnimation, setGravityAnimation] = useState<{ boardIdx: number; moves: Map<number, number> } | null>(null);

  // ===== Refs (for WS handler closure stability) =====
  const myBanRef = useRef<PowerUpCard | null>(null);
  const myBanSubmitted = useRef(false);
  const opponentBanRef = useRef<PowerUpCard | null | 'pending'>('pending');
  const [allBans, setAllBans] = useState<Set<string>>(new Set());
  const myDraftRef = useRef<PowerUpDraft | null>(null);
  const opponentDraftRef = useRef<PowerUpDraft | null>(null);
  const myPURef = useRef<PowerUpState | null>(null);
  const opponentPURef = useRef<PowerUpState | null>(null);
  const mySiegeRef = useRef<SiegeThreat[]>([]);
  const opponentSiegeRef = useRef<SiegeThreat[]>([]);
  const turnPhaseRef = useRef<TurnPhase>('normal');
  const pendingRef = useRef({
    opponentCard: null as ActiveCard | null,
    hasteStage: 0,
  });
  const redirectPendingRef = useRef<{
    prevWinners: (Player | null)[];
    lastMove: { player: string; boardIndex: number; cellIndex: number };
  } | null>(null);
  const deferredHasteRef = useRef<Player | null>(null);
  const cardUsedThisTurnRef = useRef<ActiveCard | null>(null);
  const opponentCardThisTurnRef = useRef<ActiveCard | null>(null);
  const preCardWinnersRef = useRef<(Player | null)[] | null>(null);
  const flashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noticeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const opponentSymbol: Player = mySymbol === 'X' ? 'O' : 'X';

  // Keep refs in sync
  turnPhaseRef.current = turnPhase;

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
      if (noticeTimeoutRef.current) clearTimeout(noticeTimeoutRef.current);
    };
  }, []);

  // Clear gravity animation after it plays
  useEffect(() => {
    if (!gravityAnimation) return;
    const t = setTimeout(() => setGravityAnimation(null), 500);
    return () => clearTimeout(t);
  }, [gravityAnimation]);

  // ===== Helpers =====

  const triggerFlash = useCallback((boards: number[], color: string) => {
    if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
    setFlashBoards(new Map(boards.map(b => [b, color])));
    flashTimeoutRef.current = setTimeout(() => {
      setFlashBoards(new Map());
      flashTimeoutRef.current = null;
    }, 600);
  }, []);

  const updateMySiege = useCallback((threats: SiegeThreat[]) => {
    mySiegeRef.current = threats;
    setSiegeThreats(threats);
  }, []);

  const refreshGameView = useCallback(
    (lastMove?: { player: string; boardIndex: number; cellIndex: number }) => {
      if (engineRef.current) setGame(toGameState(engineRef.current, lastMove));
    },
    [],
  );

  const getDoctrineOf = useCallback(
    (player: Player) => {
      return player === mySymbol
        ? myDraftRef.current?.doctrine ?? null
        : opponentDraftRef.current?.doctrine ?? null;
    },
    [mySymbol],
  );

  // ===== Init game =====

  const initGame = useCallback(() => {
    const engine = createEngine(gameMode, gameMode === 'conquest' ? conquestBonusBoards : undefined);
    engineRef.current = engine;
    if (gambits && myDraftRef.current) {
      const pu = createPowerUpState(myDraftRef.current);
      setMyPU(pu);
      myPURef.current = pu;
    } else {
      setMyPU(null);
      myPURef.current = null;
    }
    if (gambits && opponentDraftRef.current) {
      opponentPURef.current = createPowerUpState(opponentDraftRef.current);
    } else {
      opponentPURef.current = null;
    }
    setActivatingCard(null);
    setCardUsedThisTurn(null);
    cardUsedThisTurnRef.current = null;
    opponentCardThisTurnRef.current = null;
    setRecallSource(null);
    setGravityAnimation(null);
    setTurnPhase('normal');
    turnPhaseRef.current = 'normal';
    updateMySiege([]);
    opponentSiegeRef.current = [];
    pendingRef.current = { opponentCard: null, hasteStage: 0 };
    redirectPendingRef.current = null;
    deferredHasteRef.current = null;
    preCardWinnersRef.current = null;
    setOpponentCardNotice(null);
    setOpponentSiegeDisplay([]);
    setGame(toGameState(engine));
    setPhase('playing');
  }, [gambits, gameMode, conquestBonusBoards, updateMySiege]);

  useEffect(() => {
    if (!gambits) initGame();
  }, [gambits, initGame]);

  // ===== Ban + Draft =====

  const proceedToDraft = useCallback(() => {
    const bans = new Set<string>();
    if (myBanRef.current) bans.add(myBanRef.current);
    if (opponentBanRef.current) bans.add(opponentBanRef.current);
    setAllBans(bans);
    setPhase('draft');
  }, []);

  const handleBanReady = useCallback(
    (ban: PowerUpCard | null) => {
      myBanRef.current = ban;
      myBanSubmitted.current = true;
      ws.send(JSON.stringify({ type: 'ban-ready', ban }));
      // Check if opponent already sent their ban
      if (opponentBanRef.current !== 'pending') {
        proceedToDraft();
      } else {
        setPhase('waiting-bans');
      }
    },
    [ws, proceedToDraft],
  );

  const handleDraftReady = useCallback(
    (draft: PowerUpDraft, _ban: PowerUpCard | null) => {
      myDraftRef.current = draft;
      ws.send(JSON.stringify({ type: 'draft-ready', draft }));
      if (opponentDraftRef.current) {
        initGame();
      } else {
        setPhase('waiting-draft');
      }
    },
    [ws, initGame],
  );

  // ===== Passive checking =====

  const checkPassives = useCallback(
    (
      engine: HyperXOGame,
      mover: Player,
      prevWinners: (Player | null)[],
      lastMove: { player: string; boardIndex: number; cellIndex: number },
    ) => {
      if (engine.winner || engine.drawn) {
        setGame(toGameState(engine, lastMove));
        return;
      }

      const other: Player = mover === 'X' ? 'O' : 'X';
      const newlyWon = getNewlyWonBoards(engine, prevWinners);
      const moverWonBoard = newlyWon.some(w => w.winner === mover);

      const moverDoc = getDoctrineOf(mover);
      const otherDoc = getDoctrineOf(other);

      // Siege: advance non-mover's threats
      if (otherDoc === 'siege') {
        const threats = other === mySymbol ? mySiegeRef.current : opponentSiegeRef.current;
        const result = advanceSiegeThreats(threats, engine, other);
        for (const claim of result.claimed) {
          applySiegeClaim(engine, claim.boardIdx, claim.cellIdx, other);
        }
        if (other === mySymbol) {
          updateMySiege(result.updated);
          if (result.claimed.length > 0) triggerFlash(result.claimed.map(c => c.boardIdx), 'amber');
        } else {
          opponentSiegeRef.current = result.updated;
          setOpponentSiegeDisplay(result.updated);
        }
      }

      // Siege: refresh mover's threats
      if (moverDoc === 'siege') {
        const threats = mover === mySymbol ? mySiegeRef.current : opponentSiegeRef.current;
        const refreshed = refreshSiegeThreats(threats, engine, mover);
        if (mover === mySymbol) {
          updateMySiege(refreshed);
        } else {
          opponentSiegeRef.current = refreshed;
          setOpponentSiegeDisplay(refreshed);
        }
      }

      if (engine.winner || engine.drawn) {
        setGame(toGameState(engine, lastMove));
        return;
      }

      // Recompute newly won boards after siege (siege claims can win boards)
      const allNewlyWon = getNewlyWonBoards(engine, prevWinners);
      const moverWonAfterSiege = allNewlyWon.some(w => w.winner === mover);

      // Arsenal: recharge a random used card when you win a board on your turn
      if (moverDoc === 'arsenal' && moverWonAfterSiege && !engine.winner && !engine.drawn) {
        const moverPU = mover === mySymbol ? myPURef.current : opponentPURef.current;
        const moverExclude = mover === mySymbol ? cardUsedThisTurnRef.current : opponentCardThisTurnRef.current;
        if (moverPU) {
          const recharged = rechargeRandomCard(moverPU, moverExclude ?? undefined);
          if (recharged) {
            if (mover === mySymbol) setMyPU({ ...moverPU });
            else { setOpponentCardNotice(`Arsenal — ${CARD_CATALOG[recharged].name} recharged`); setTimeout(() => setOpponentCardNotice(null), 2500); }
          }
        }
      }
      // Momentum: mover gets bonus turn
      if (moverDoc === 'momentum' && moverWonBoard) {
        engine.currentPlayer = mover;
        engine.zkey ^= engine.zobrist.stmKey();
        if (mover === mySymbol) {
          setTurnPhase('momentum-bonus');
          turnPhaseRef.current = 'momentum-bonus';
          triggerFlash(
            newlyWon.filter(w => w.winner === mover).map(w => w.i),
            mover === 'X' ? 'cyan' : 'rose',
          );
        }
        setGame(toGameState(engine, lastMove));
        return;
      }

      // Deferred haste: resume haste second turn after passives resolved
      const hastePlayer = deferredHasteRef.current;
      if (hastePlayer) {
        deferredHasteRef.current = null;
        // Grant the haste player their second turn
        if (engine.currentPlayer !== hastePlayer) {
          engine.currentPlayer = hastePlayer;
          engine.zkey ^= engine.zobrist.stmKey();
        }
        if (hastePlayer === mySymbol) {
          setTurnPhase('haste-second');
          turnPhaseRef.current = 'haste-second';
        }
        setGame(toGameState(engine, lastMove));
        return;
      }

      setGame(toGameState(engine, lastMove));
      // Reset card usage for whoever's turn it now is
      if (engine.currentPlayer === mySymbol) {
        setCardUsedThisTurn(null);
        cardUsedThisTurnRef.current = null;
      }
      if (engine.currentPlayer !== mySymbol) {
        opponentCardThisTurnRef.current = null;
      }
    },
    [mySymbol, getDoctrineOf, triggerFlash, updateMySiege],
  );

  // ===== Card activation (my turn) =====

  const commitMyCard = useCallback(
    (card: ActiveCard) => {
      if (!myPURef.current) return;
      markCardUsed(myPURef.current, card);
      setMyPU({ ...myPURef.current });
      setActivatingCard(null);
      setCardUsedThisTurn(card);
      cardUsedThisTurnRef.current = card;
    },
    [],
  );

  const handleActivateCard = useCallback(
    (card: ActiveCard) => {
      const engine = engineRef.current;
      if (!engine || !myPURef.current || engine.currentPlayer !== mySymbol) return;

      // All cards need targeting or are flow modifiers
      setActivatingCard(card);
      setRecallSource(null);
    },
    [mySymbol],
  );

  const cancelActivation = useCallback(() => {
    setActivatingCard(null);
    setRecallSource(null);
  }, []);

  // ===== Cell click handler =====

  const handleCellClick = useCallback(
    (boardIndex: number, cellIndex: number) => {
      const engine = engineRef.current;
      if (!engine || engine.winner || engine.drawn) return;

      // --- Pre-placement card targeting ---
      if (activatingCard && turnPhaseRef.current === 'normal') {
        const card = activatingCard;

        // Board-target cards
        if (card === 'condemn' || card === 'swap' || card === 'shatter' || card === 'gravity') {
          try {
            // Save winners before card effect so passives detect changes after placement
            preCardWinnersRef.current = engine.boards.map(b => b.winner);
            if (card === 'condemn') applyCondemn(engine, boardIndex);
            else if (card === 'swap') applySwap(engine, boardIndex);
            else if (card === 'gravity') {
              const gravityMoves = applyGravity(engine, boardIndex);
              setGravityAnimation({ boardIdx: boardIndex, moves: gravityMoves });
            }
            else applyShatter(engine, boardIndex);
            commitMyCard(card);
            ws.send(JSON.stringify({ type: 'card-effect', card, boardIdx: boardIndex }));
            // If the card effect ended the game (e.g., swap completes macro line), show result
            if (engine.winner || engine.drawn) { preCardWinnersRef.current = null; }
            refreshGameView();
            triggerFlash([boardIndex], card === 'swap' ? 'violet' : card === 'shatter' ? 'rose' : card === 'gravity' ? 'amber' : 'zinc');
          } catch {
            /* invalid target */
          }
          return;
        }

        // Recall: two-step targeting (pick up own piece, then place on another board)
        if (card === 'recall') {
          if (!recallSource) {
            // Step 1: pick up own piece
            const b = engine.boards[boardIndex];
            if (b.condemned || b.winner || b.drawn) return;
            if (b.cells[cellIndex] !== mySymbol) return;
            setRecallSource({ boardIdx: boardIndex, cellIdx: cellIndex });
          } else {
            // Step 2: place on different live board
            try {
              preCardWinnersRef.current = engine.boards.map(b => b.winner);
              applyRecall(engine, recallSource.boardIdx, recallSource.cellIdx, boardIndex, cellIndex);
              commitMyCard('recall');
              ws.send(JSON.stringify({
                type: 'card-effect', card: 'recall',
                fromBoard: recallSource.boardIdx, fromCell: recallSource.cellIdx,
                toBoard: boardIndex, toCell: cellIndex,
              }));
              if (engine.winner || engine.drawn) preCardWinnersRef.current = null;
              setRecallSource(null);
              refreshGameView();
              triggerFlash([recallSource.boardIdx, boardIndex], 'sky');
            } catch {
              /* invalid target */
            }
          }
          return;
        }

        // Cell-target cards
        if (card === 'overwrite' || card === 'sabotage') {
          try {
            // Save winners before card effect so passives detect changes after placement
            preCardWinnersRef.current = engine.boards.map(b => b.winner);
            if (card === 'overwrite') applyOverwrite(engine, boardIndex, cellIndex);
            else applySabotage(engine, boardIndex, cellIndex);
            commitMyCard(card);
            ws.send(
              JSON.stringify({ type: 'card-effect', card, boardIdx: boardIndex, cellIdx: cellIndex }),
            );
            if (engine.winner || engine.drawn) { preCardWinnersRef.current = null; }
            refreshGameView();
            triggerFlash([boardIndex], card === 'overwrite' ? 'rose' : 'violet');
          } catch {
            /* invalid target */
          }
          return;
        }

        // Flow modifier cards (haste, redirect) — fall through to placement
      }

      // --- Redirect-pick phase ---
      if (turnPhaseRef.current === 'redirect-pick') {
        try {
          applyRedirect(engine, boardIndex);
        } catch {
          return;
        }
        ws.send(JSON.stringify({ type: 'redirect-target', boardIdx: boardIndex }));
        setTurnPhase('normal');
        turnPhaseRef.current = 'normal';
        // Now check passives with the saved state from when the move was made
        const rp = redirectPendingRef.current;
        redirectPendingRef.current = null;
        if (rp) {
          checkPassives(engine, mySymbol as Player, rp.prevWinners, rp.lastMove);
        } else {
          refreshGameView();
        }
        return;
      }

      // --- Momentum-bonus phase ---
      if (turnPhaseRef.current === 'momentum-bonus') {
        const legal = availableMoves(engine).some(([b, c]) => b === boardIndex && c === cellIndex);
        if (!legal) return;
        const prevWinners = engine.boards.map(b => b.winner);
        engineApply(engine, boardIndex, cellIndex);
        const lastMove = { player: mySymbol, boardIndex, cellIndex };
        ws.send(JSON.stringify({ type: 'move', boardIndex, cellIndex }));
        setTurnPhase('normal');
        turnPhaseRef.current = 'normal';
        checkPassives(engine, mySymbol as Player, prevWinners, lastMove);
        return;
      }

      // --- Normal / Haste-second placement ---
      if (engine.currentPlayer !== mySymbol) return;
      const legal = availableMoves(engine).some(([b, c]) => b === boardIndex && c === cellIndex);
      if (!legal) return;

      // Use pre-card-effect winners if a card was played this turn (so passives detect card-caused changes)
      const savedPreCardWinners = preCardWinnersRef.current;
      preCardWinnersRef.current = null;

      // Send flow card effect BEFORE the move so opponent can track it
      const pendingFlowCard =
        turnPhaseRef.current === 'normal' &&
        activatingCard &&
        ['haste', 'redirect'].includes(activatingCard)
          ? activatingCard
          : null;

      if (pendingFlowCard) {
        commitMyCard(pendingFlowCard);
        ws.send(JSON.stringify({ type: 'card-effect', card: pendingFlowCard }));
      }

      const prevWinners = savedPreCardWinners ?? engine.boards.map(b => b.winner);
      engineApply(engine, boardIndex, cellIndex);
      const lastMove = { player: mySymbol, boardIndex, cellIndex };
      ws.send(JSON.stringify({ type: 'move', boardIndex, cellIndex }));

      // Haste-second: done
      if (turnPhaseRef.current === 'haste-second') {
        setTurnPhase('normal');
        turnPhaseRef.current = 'normal';
        checkPassives(engine, mySymbol as Player, prevWinners, lastMove);
        return;
      }

      // --- Post-move flow card handling ---
      if (pendingFlowCard === 'haste' && !engine.winner && !engine.drawn) {
        // Defer haste second turn — run passives first (arsenal/siege may trigger)
        deferredHasteRef.current = mySymbol as Player;
        checkPassives(engine, mySymbol as Player, prevWinners, lastMove);
        return;
      }

      if (pendingFlowCard === 'redirect' && !engine.winner && !engine.drawn) {
        redirectPendingRef.current = { prevWinners, lastMove };
        setTurnPhase('redirect-pick');
        turnPhaseRef.current = 'redirect-pick';
        setGame(toGameState(engine, lastMove));
        return;
      }

      // --- Normal: check passives ---
      setActivatingCard(null);
      checkPassives(engine, mySymbol as Player, prevWinners, lastMove);
    },
    [activatingCard, mySymbol, commitMyCard, refreshGameView, ws, checkPassives, triggerFlash, recallSource],
  );

  // ===== WS message handler =====

  useEffect(() => {
    const handler = (ev: MessageEvent) => {
      const msg = JSON.parse(ev.data);
      const engine = engineRef.current;

      if (msg.type === 'ban-ready') {
        opponentBanRef.current = msg.ban ?? null;
        // If we already submitted our ban, proceed to draft
        if (myBanSubmitted.current) {
          proceedToDraft();
        }
        return;
      }

      if (msg.type === 'draft-ready') {
        opponentDraftRef.current = msg.draft;
        if (myDraftRef.current) initGame();
        return;
      }

      if (msg.type === 'peer-status') {
        if (msg.status === 'left') setPeerLeft(true);
        return;
      }

      if (msg.type === 'rematch-accept') {
        initGame();
        return;
      }

      if (msg.type === 'redraft') {
        myDraftRef.current = null;
        opponentDraftRef.current = null;
        myBanRef.current = null;
        opponentBanRef.current = 'pending';
        myBanSubmitted.current = false;
        setAllBans(new Set());
        setPhase('ban');
        return;
      }

      if (!engine) return;

      // --- Opponent card effect ---
      if (msg.type === 'card-effect') {
        const card = msg.card as ActiveCard;

        // Save winners before card effect so passives detect card-caused changes
        const stateChangingCards = ['recall', 'swap', 'shatter', 'condemn', 'overwrite', 'sabotage', 'gravity'];
        if (stateChangingCards.includes(card)) {
          preCardWinnersRef.current = engine.boards.map(b => b.winner);
        }

        // Apply the effect locally
        if (card === 'recall') applyRecall(engine, msg.fromBoard, msg.fromCell, msg.toBoard, msg.toCell);
        else if (card === 'sabotage') applySabotage(engine, msg.boardIdx, msg.cellIdx);
        else if (card === 'overwrite') applyOverwrite(engine, msg.boardIdx, msg.cellIdx);
        else if (card === 'swap') applySwap(engine, msg.boardIdx);
        else if (card === 'shatter') applyShatter(engine, msg.boardIdx);
        else if (card === 'condemn') applyCondemn(engine, msg.boardIdx);
        else if (card === 'gravity') {
          const gravityMoves = applyGravity(engine, msg.boardIdx);
          setGravityAnimation({ boardIdx: msg.boardIdx, moves: gravityMoves });
        }

        // If the card effect ended the game, clear saved winners
        if (engine.winner || engine.drawn) preCardWinnersRef.current = null;

        // Flash for board/cell-target cards
        if (card === 'recall') triggerFlash([msg.fromBoard, msg.toBoard], 'sky');
        else if (card === 'swap') triggerFlash([msg.boardIdx], 'violet');
        else if (card === 'shatter') triggerFlash([msg.boardIdx], 'rose');
        else if (card === 'condemn') triggerFlash([msg.boardIdx], 'zinc');
        else if (card === 'overwrite') triggerFlash([msg.boardIdx], 'rose');
        else if (card === 'sabotage') triggerFlash([msg.boardIdx], 'violet');
        else if (card === 'gravity') triggerFlash([msg.boardIdx], 'amber');

        // Set pending for flow cards
        if (card === 'haste') pendingRef.current.opponentCard = 'haste';
        else if (card === 'redirect') pendingRef.current.opponentCard = 'redirect';

        // Mark card as used in opponent's state
        if (opponentPURef.current) markCardUsed(opponentPURef.current, card);
        opponentCardThisTurnRef.current = card;

        // Show notice
        if (!['haste', 'redirect'].includes(card)) {
          if (noticeTimeoutRef.current) clearTimeout(noticeTimeoutRef.current);
          setOpponentCardNotice(CARD_CATALOG[card].name);
          noticeTimeoutRef.current = setTimeout(() => {
            setOpponentCardNotice(null);
            noticeTimeoutRef.current = null;
          }, 3500);
        }

        refreshGameView();
        return;
      }

      // --- Opponent redirect target ---
      if (msg.type === 'redirect-target') {
        applyRedirect(engine, msg.boardIdx);
        const rp = redirectPendingRef.current;
        redirectPendingRef.current = null;
        if (rp) {
          checkPassives(engine, opponentSymbol, rp.prevWinners, rp.lastMove);
        } else {
          refreshGameView();
        }
        return;
      }

      // --- Move (from opponent or bonus) ---
      if (msg.type === 'move') {
        const savedPre = preCardWinnersRef.current;
        preCardWinnersRef.current = null;
        const prevWinners = savedPre ?? engine.boards.map(b => b.winner);
        const player = engine.currentPlayer;
        engineApply(engine, msg.boardIndex, msg.cellIndex);
        const lastMove = { player, boardIndex: msg.boardIndex, cellIndex: msg.cellIndex };

        const pending = pendingRef.current;

        // Handle haste first move — run passives, defer second turn
        if (pending.opponentCard === 'haste' && pending.hasteStage === 0) {
          pending.opponentCard = null;
          pending.hasteStage = 0;
          if (!engine.winner && !engine.drawn) {
            deferredHasteRef.current = opponentSymbol;
          }
          checkPassives(engine, opponentSymbol, prevWinners, lastMove);
          return;
        }

        // Handle redirect (move placed, expect redirect-target next)
        if (pending.opponentCard === 'redirect') {
          pending.opponentCard = null;
          redirectPendingRef.current = { prevWinners, lastMove };
          setGame(toGameState(engine, lastMove));
          return;
        }

        // Normal move — check passives for whoever just moved
        checkPassives(engine, player as Player, prevWinners, lastMove);
      }
    };

    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, [ws, mySymbol, opponentSymbol, initGame, proceedToDraft, refreshGameView, checkPassives, triggerFlash]);

  // ===== Targeting computation =====

  const targeting = (() => {
    const engine = engineRef.current;
    if (!engine) return null;

    if (turnPhaseRef.current === 'redirect-pick') {
      const validBoards = new Set<number>();
      for (let i = 0; i < 9; i++) {
        if (isBoardLive(engine, i)) validBoards.add(i);
      }
      return { mode: 'board' as const, validBoards };
    }

    if (!activatingCard || turnPhaseRef.current !== 'normal') return null;

    const def = CARD_CATALOG[activatingCard];

    // Recall: two-step targeting
    if (activatingCard === 'recall') {
      if (!recallSource) {
        // Step 1: highlight own pieces on live boards
        const validBoards = new Set<number>();
        for (let i = 0; i < 9; i++) {
          if (isBoardLive(engine, i) && engine.boards[i].cells.some(c => c === mySymbol))
            validBoards.add(i);
        }
        return { mode: 'opponent-cell' as const, validBoards, opponentSymbol: mySymbol };
      } else {
        // Step 2: highlight empty cells on other live boards
        const validBoards = new Set<number>();
        for (let i = 0; i < 9; i++) {
          if (i === recallSource.boardIdx) continue;
          if (isBoardLive(engine, i) && engine.boards[i].cells.some(c => c === ''))
            validBoards.add(i);
        }
        return { mode: 'opponent-cell' as const, validBoards, opponentSymbol: '' };
      }
    }

    if (def.targetType === 'board') {
      const validBoards = new Set<number>();
      for (let i = 0; i < 9; i++) {
        const b = engine.boards[i];
        if (b.condemned) continue;
        if (activatingCard === 'condemn' && (b.winner || b.drawn)) continue;
        // Swap/Gravity: live boards only. Shatter: any non-condemned with pieces.
        if (activatingCard === 'swap' && (b.winner || b.drawn)) continue;
        if (activatingCard === 'gravity' && (b.winner || b.drawn)) continue;
        if ((activatingCard === 'swap' || activatingCard === 'shatter') && !b.cells.some(c => c !== ''))
          continue;
        if (activatingCard === 'gravity' && computeGravity(b.cells as ('' | 'X' | 'O')[]).size === 0) continue;
        validBoards.add(i);
      }
      return { mode: 'board' as const, validBoards };
    }

    if (def.targetType === 'opponent-cell') {
      const validBoards = new Set<number>();
      for (let i = 0; i < 9; i++) {
        const b = engine.boards[i];
        if (b.condemned) continue;
        // Overwrite: live boards only. Sabotage: any non-condemned board.
        if (activatingCard === 'overwrite' && (b.winner || b.drawn)) continue;
        if (b.cells.some(c => c === opponentSymbol)) validBoards.add(i);
      }
      return { mode: 'opponent-cell' as const, validBoards, opponentSymbol };
    }

    return null;
  })();

  // ===== Siege cells for display =====

  const siegeCellsMap = useMemo(() => {
    const allThreats = [...siegeThreats, ...opponentSiegeDisplay];
    if (allThreats.length === 0) return undefined;
    const map = new Map<number, Set<number>>();
    for (const t of allThreats) {
      if (!map.has(t.boardIdx)) map.set(t.boardIdx, new Set());
      map.get(t.boardIdx)!.add(t.blockingCell);
    }
    return map;
  }, [siegeThreats, opponentSiegeDisplay]);

  // ==================== Render ====================

  if (phase === 'ban') {
    return (
      <BanScreen
        onBanReady={handleBanReady}
        onBack={onBack}
      />
    );
  }

  if (phase === 'waiting-bans') {
    return (
      <div className="flex flex-col items-center gap-6 px-4">
        <h2 className="text-zinc-200 text-lg font-semibold">
          Waiting for {opponentName} to ban...
        </h2>
        {myBanRef.current && (
          <div className="text-xs text-red-400/70 border border-red-500/20 rounded-lg px-3 py-1.5">
            You banned: <span className="font-semibold text-red-400">{CARD_CATALOG[myBanRef.current].name}</span>
          </div>
        )}
        <div className="text-zinc-500 animate-pulse text-sm">Both players must submit bans before drafting...</div>
      </div>
    );
  }

  if (phase === 'draft') {
    return <DraftScreen onReady={handleDraftReady} onBack={onBack} banned={allBans.size > 0 ? allBans : undefined} />;
  }

  if (phase === 'waiting-draft') {
    const myDraft = myDraftRef.current;
    return (
      <div className="flex flex-col items-center gap-6 px-4">
        <h2 className="text-zinc-200 text-lg font-semibold">
          Waiting for {opponentName} to draft...
        </h2>
        {myDraft && (
          <div className="flex flex-col items-center gap-2">
            <p className="text-zinc-500 text-xs">Your picks</p>
            <div className="flex gap-2 flex-wrap justify-center">
              {(['strike', 'tactics', 'disruption', 'doctrine'] as const).map(cat => {
                const cardId = myDraft[cat];
                const card = CARD_CATALOG[cardId];
                return (
                  <div key={cat} className="rounded-lg bg-zinc-800/50 border border-zinc-700/50 px-3 py-1.5 text-center">
                    <div className="text-xs text-zinc-300 font-medium">{card.name}</div>
                    <div className="text-[10px] text-zinc-500">{cat}</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        <div className="text-zinc-500 animate-pulse text-sm">Waiting...</div>
        <button
          onClick={onBack}
          className="text-zinc-500 hover:text-zinc-300 text-sm transition-colors"
        >
          &larr; Back
        </button>
      </div>
    );
  }

  if (!game) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-zinc-500 animate-pulse">Starting game...</div>
      </div>
    );
  }

  const isGameOver = !!game.winner || game.drawn;
  const isMyTurn = game.currentPlayer === mySymbol && !isGameOver;

  const xName = mySymbol === 'X' ? myName : opponentName;
  const oName = mySymbol === 'O' ? myName : opponentName;

  // Phase hint with descriptive text
  const phaseHint =
    turnPhase === 'haste-second'
      ? { label: 'Haste', desc: 'Take your second consecutive turn' }
        : turnPhase === 'redirect-pick'
          ? { label: 'Redirect', desc: 'Click a board to send your opponent there' }
          : turnPhase === 'momentum-bonus'
            ? { label: 'Momentum', desc: 'You won a board — take a bonus turn!' }
            : activatingCard === 'recall' && !recallSource
                ? { label: 'Recall', desc: 'Click one of your pieces to pick it up' }
                : activatingCard === 'recall' && recallSource
                  ? { label: 'Recall', desc: 'Click an empty cell on another board to place it' }
                  : activatingCard && CARD_CATALOG[activatingCard].targetType === 'board'
                    ? { label: CARD_CATALOG[activatingCard].name, desc: 'Click a board to target' }
                    : activatingCard && CARD_CATALOG[activatingCard].targetType === 'opponent-cell'
                      ? { label: CARD_CATALOG[activatingCard].name, desc: 'Click an opponent piece to target' }
                      : null;

  // Opponent waiting explanation (when it's not my turn and opponent is in a special phase)
  const opponentPhaseHint = !isMyTurn && !isGameOver && !phaseHint
    ? (game.currentPlayer === opponentSymbol ? null : `${opponentName} is taking a bonus action...`)
    : null;

  const oppDoctrine = opponentDraftRef.current?.doctrine;
  const oppDoctrineLabel = oppDoctrine ? CARD_CATALOG[oppDoctrine].name : null;

  return (
    <div className="flex flex-col items-center gap-4 sm:gap-6 px-2">
      <div className="w-full flex items-center justify-between max-w-lg">
        <button
          onClick={onBack}
          className="text-zinc-500 hover:text-zinc-300 text-sm transition-colors"
        >
          &larr; Menu
        </button>
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-cyan-400">{xName} (X)</span>
          <span className="text-zinc-600 text-xs">vs</span>
          <span className="text-sm font-medium text-rose-400">{oName} (O)</span>
          {gameMode !== 'classic' && (
            <span className="text-xs text-zinc-500 border border-zinc-700 rounded px-1.5 py-0.5">
              {gameMode === 'sudden-death' ? 'Sudden Death' : gameMode === 'misere' ? 'Misère' : 'Conquest'}
            </span>
          )}
          {gambits && (
            <span className="text-xs text-zinc-500 border border-zinc-700 rounded px-1.5 py-0.5">Gambits</span>
          )}
        </div>
      </div>

      {peerLeft && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/30 px-4 py-2 text-red-400 text-sm">
          Opponent disconnected
        </div>
      )}

      {opponentCardNotice && (
        <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 px-4 py-2.5 text-amber-400 text-sm font-medium">
          {opponentName} used <span className="font-bold">{opponentCardNotice}</span>
        </div>
      )}

      {oppDoctrineLabel && (
        <div className="text-xs text-zinc-500">
          {opponentName}&apos;s doctrine: <span className="text-amber-400 font-medium">{oppDoctrineLabel}</span>
        </div>
      )}

      <GameStatus
        game={game}
        labelX={{ turn: `${xName}'s turn`, win: `${xName} wins` }}
        labelO={{ turn: `${oName}'s turn`, win: `${oName} wins` }}
      />

      {gameMode === 'conquest' && game.conquestScores && (
        <div className="flex items-center gap-3 px-4 py-1.5 rounded-full bg-zinc-800/80 border border-zinc-700/50">
          <span className="text-cyan-400 font-bold text-sm">{game.conquestScores.X}</span>
          <span className="text-zinc-600 text-xs">pts</span>
          <div className="w-px h-4 bg-zinc-700" />
          <span className="text-rose-400 font-bold text-sm">{game.conquestScores.O}</span>
          <span className="text-zinc-600 text-xs">pts</span>
        </div>
      )}

      {phaseHint && (
        <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 px-4 py-2 text-center">
          <span className="text-amber-400 text-sm font-semibold">{phaseHint.label}</span>
          <span className="text-amber-400/70 text-xs block">{phaseHint.desc}</span>
        </div>
      )}

      {opponentPhaseHint && (
        <p className="text-zinc-500 text-xs animate-pulse">{opponentPhaseHint}</p>
      )}

      <BigBoard
        game={game}
        onCellClick={handleCellClick}
        disabled={targeting ? false : !isMyTurn || peerLeft}
        targeting={targeting}
        flashBoards={flashBoards.size > 0 ? flashBoards : undefined}
        siegeCells={siegeCellsMap}
        conquestBonusBoards={game.conquestBonusBoards ? new Set(game.conquestBonusBoards) : undefined}
        gravityMoves={gravityAnimation?.moves}
        gravityBoardIdx={gravityAnimation?.boardIdx}
      />

      {myPU && (
        <div className="flex flex-col items-center gap-1">
          <CardTray
            state={myPU}
            onActivate={handleActivateCard}
            activatingCard={activatingCard}
            disabled={!isMyTurn || turnPhase !== 'normal' || !!cardUsedThisTurn}
          />
          {activatingCard && (
            <button
              onClick={cancelActivation}
              className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              Cancel
            </button>
          )}
        </div>
      )}

      {isGameOver && (
        <div className="flex gap-3">
          <button
            onClick={() => {
              ws.send(JSON.stringify({ type: 'rematch-accept' }));
              initGame();
            }}
            className="rounded-xl bg-indigo-500 px-6 py-3 text-white font-semibold hover:bg-indigo-400 transition-colors shadow-lg shadow-indigo-500/25 active:scale-[0.98]"
          >
            Rematch
          </button>
          {gambits && (
            <button
              onClick={() => {
                myDraftRef.current = null;
                opponentDraftRef.current = null;
                myBanRef.current = null;
                opponentBanRef.current = 'pending';
                myBanSubmitted.current = false;
                setAllBans(new Set());
                setPhase('ban');
                ws.send(JSON.stringify({ type: 'redraft' }));
              }}
              className="rounded-xl border border-zinc-700 bg-zinc-800/50 px-6 py-3 text-zinc-300 font-semibold hover:bg-zinc-700/50 hover:border-zinc-600 transition-all active:scale-[0.98]"
            >
              Re-draft
            </button>
          )}
        </div>
      )}
    </div>
  );
}
