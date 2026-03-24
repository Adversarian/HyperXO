import { useState, useCallback, useRef } from 'react';
import type { Difficulty, Screen, GameMode } from './types';
import type { PowerUpDraft, PowerUpCard } from './engine/powerups';
import { DIFFICULTY_PRESETS } from './engine/ai';
import { aiBan as generateAiBan } from './engine/ai-gambits';
import Menu from './components/Menu';
import BanScreen from './components/BanScreen';
import DraftScreen from './components/DraftScreen';
import GameView from './components/GameView';
import Lobby from './components/Lobby';
import FriendGame from './components/FriendGame';
import PnPLobby from './components/PnPLobby';
import PassAndPlay from './components/PassAndPlay';

const FADE_MS = 120;

export default function App() {
  const [screen, setScreen] = useState<Screen>('menu');
  const [difficulty, setDifficulty] = useState<Difficulty>(3);
  const [playerSymbol, setPlayerSymbol] = useState<'X' | 'O'>('X');
  const [aiName, setAiName] = useState('Novax');
  const [gameMode, setGameMode] = useState<GameMode>('classic');
  const [playerDraft, setPlayerDraft] = useState<PowerUpDraft | null>(null);
  const [playerBan, setPlayerBan] = useState<PowerUpCard | null>(null);
  const [aiBanCard, setAiBanCard] = useState<PowerUpCard | null>(null);
  const [friendWs, setFriendWs] = useState<WebSocket | null>(null);
  const [myName, setMyName] = useState('');
  const [opponentName, setOpponentName] = useState('');
  const [friendSymbol, setFriendSymbol] = useState<'X' | 'O'>('X');
  const [friendGambits, setFriendGambits] = useState(false);
  const [friendMode, setFriendMode] = useState<GameMode>('classic');
  const [friendBonusBoards, setFriendBonusBoards] = useState<number[] | undefined>(undefined);
  // Pass & Play state
  const [pnpNameX, setPnpNameX] = useState('');
  const [pnpNameO, setPnpNameO] = useState('');
  const [pnpBanX, setPnpBanX] = useState<PowerUpCard | null>(null);
  const [pnpBanO, setPnpBanO] = useState<PowerUpCard | null>(null);
  const [pnpDraftX, setPnpDraftX] = useState<PowerUpDraft | null>(null);
  const [pnpDraftO, setPnpDraftO] = useState<PowerUpDraft | null>(null);
  const [pnpPowerUps, setPnpPowerUps] = useState(false);
  const [fade, setFade] = useState(true);
  const transitioning = useRef(false);

  const urlParams = new URLSearchParams(window.location.search);
  const roomFromUrl = urlParams.get('room');

  const transitionTo = useCallback(
    (next: () => void) => {
      if (transitioning.current) return;
      transitioning.current = true;
      setFade(false);
      setTimeout(() => {
        next();
        requestAnimationFrame(() => {
          setFade(true);
          transitioning.current = false;
        });
      }, FADE_MS);
    },
    []
  );

  // ---- AI game flow ----

  const handleStartAI = useCallback(
    (d: Difficulty, sym: 'X' | 'O', name: string, mode: GameMode, powerUps: boolean) => {
      transitionTo(() => {
        setDifficulty(d);
        setPlayerSymbol(sym);
        setAiName(name);
        setGameMode(mode);
        setPlayerDraft(null);
        setPlayerBan(null);
        if (powerUps) {
          setAiBanCard(generateAiBan(DIFFICULTY_PRESETS[d].depth, mode));
        } else {
          setAiBanCard(null);
        }
        setScreen(powerUps ? 'ban' : 'game');
      });
    },
    [transitionTo]
  );

  const handleBanReady = useCallback(
    (ban: PowerUpCard | null) => {
      transitionTo(() => {
        setPlayerBan(ban);
        setScreen('draft');
      });
    },
    [transitionTo],
  );

  const handleDraftReady = useCallback(
    (draft: PowerUpDraft, _ban: PowerUpCard | null) => {
      transitionTo(() => {
        setPlayerDraft(draft);
        setScreen('game');
      });
    },
    [transitionTo]
  );

  // ---- Friend (LAN) game flow ----

  const handleHostGame = useCallback((mode: GameMode) => {
    transitionTo(() => {
      setGameMode(mode);
      setScreen('lobby-create');
    });
  }, [transitionTo]);

  const handleJoinGame = useCallback(() => {
    transitionTo(() => setScreen('lobby-join'));
  }, [transitionTo]);

  const handleGameStart = useCallback(
    (ws: WebSocket, _role: 'host' | 'guest', playerName: string, peerName: string, mySymbol: 'X' | 'O', gambits: boolean, gm: GameMode = 'classic', bonusBoards?: number[]) => {
      transitionTo(() => {
        setFriendWs(ws);
        setMyName(playerName);
        setOpponentName(peerName);
        setFriendSymbol(mySymbol);
        setFriendGambits(gambits);
        setFriendMode(gm);
        setFriendBonusBoards(bonusBoards);
        setScreen('friend-game');
      });
    },
    [transitionTo]
  );

  // ---- Pass & Play flow ----

  const handleStartPnP = useCallback((mode: GameMode, powerUps: boolean) => {
    transitionTo(() => {
      setGameMode(mode);
      setPnpPowerUps(powerUps);
      setPnpBanX(null);
      setPnpBanO(null);
      setPnpDraftX(null);
      setPnpDraftO(null);
      setScreen('pnp-lobby');
    });
  }, [transitionTo]);

  const handlePnPNames = useCallback((nx: string, no: string) => {
    transitionTo(() => {
      setPnpNameX(nx);
      setPnpNameO(no);
      setScreen(pnpPowerUps ? 'pnp-ban-x' : 'pnp-game');
    });
  }, [transitionTo, pnpPowerUps]);

  const handlePnpBanX = useCallback((ban: PowerUpCard | null) => {
    transitionTo(() => {
      setPnpBanX(ban);
      setScreen('pnp-ban-o');
    });
  }, [transitionTo]);

  const handlePnpBanO = useCallback((ban: PowerUpCard | null) => {
    transitionTo(() => {
      setPnpBanO(ban);
      setScreen('pnp-draft-x');
    });
  }, [transitionTo]);

  const handlePnpDraftX = useCallback((draft: PowerUpDraft, _ban: PowerUpCard | null) => {
    transitionTo(() => {
      setPnpDraftX(draft);
      setScreen('pnp-draft-o');
    });
  }, [transitionTo]);

  const handlePnpDraftO = useCallback((draft: PowerUpDraft, _ban: PowerUpCard | null) => {
    transitionTo(() => {
      setPnpDraftO(draft);
      setScreen('pnp-game');
    });
  }, [transitionTo]);

  // ---- Navigation ----

  const goMenu = useCallback(() => {
    transitionTo(() => {
      friendWs?.close();
      setFriendWs(null);
      setMyName('');
      setOpponentName('');
      setPnpNameX('');
      setPnpNameO('');
      setPnpBanX(null);
      setPnpBanO(null);
      setPnpDraftX(null);
      setPnpDraftO(null);
      setScreen('menu');
      if (roomFromUrl) {
        window.history.replaceState({}, '', '/');
      }
    });
  }, [transitionTo, friendWs, roomFromUrl]);

  const pnpBans = (() => {
    const bans = new Set<string>();
    if (pnpBanX) bans.add(pnpBanX);
    if (pnpBanO) bans.add(pnpBanO);
    return bans.size > 0 ? bans : undefined;
  })();

  // Auto-join if room param in URL
  if (roomFromUrl && screen === 'menu') {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <Lobby
          mode="join"
          initialRoomId={roomFromUrl.toUpperCase()}
          onBack={goMenu}
          onGameStart={handleGameStart}
        />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 flex flex-col items-center justify-center py-6 sm:py-10">
      <div
        className={`transition-all ${fade ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-1'}`}
        style={{ transitionDuration: `${FADE_MS}ms` }}
      >
        {screen === 'menu' && (
          <Menu
            onStartAI={handleStartAI}
            onStartPnP={handleStartPnP}
            onHostGame={handleHostGame}
            onJoinGame={handleJoinGame}
          />
        )}

        {screen === 'ban' && (
          <BanScreen onBanReady={handleBanReady} onBack={goMenu} />
        )}

        {screen === 'draft' && (
          <DraftScreen
            onReady={handleDraftReady}
            onBack={goMenu}
            banned={(() => {
              const bans = new Set<string>();
              if (playerBan) bans.add(playerBan);
              if (aiBanCard) bans.add(aiBanCard);
              return bans.size > 0 ? bans : undefined;
            })()}
          />
        )}

        {screen === 'game' && (
          <GameView difficulty={difficulty} playerSymbol={playerSymbol} aiName={aiName} mode={gameMode} draft={playerDraft} playerBan={playerBan} aiBan={aiBanCard} onBack={goMenu} />
        )}

        {screen === 'lobby-create' && !friendWs && (
          <Lobby mode="create" gameMode={gameMode} onBack={goMenu} onGameStart={handleGameStart} />
        )}

        {screen === 'lobby-join' && !friendWs && (
          <Lobby mode="join" onBack={goMenu} onGameStart={handleGameStart} />
        )}

        {screen === 'friend-game' && friendWs && (
          <FriendGame
            ws={friendWs}
            myName={myName}
            opponentName={opponentName}
            mySymbol={friendSymbol}
            gambits={friendGambits}
            gameMode={friendMode}
            conquestBonusBoards={friendBonusBoards}
            onBack={goMenu}
          />
        )}

        {/* Pass & Play screens */}

        {screen === 'pnp-lobby' && (
          <PnPLobby onStart={handlePnPNames} onBack={goMenu} />
        )}

        {screen === 'pnp-ban-x' && (
          <BanScreen playerLabel={pnpNameX} onBanReady={handlePnpBanX} onBack={goMenu} />
        )}

        {screen === 'pnp-ban-o' && (
          <BanScreen playerLabel={pnpNameO} onBanReady={handlePnpBanO} onBack={goMenu} />
        )}

        {screen === 'pnp-draft-x' && (
          <DraftScreen playerLabel={pnpNameX} onReady={handlePnpDraftX} onBack={goMenu} banned={pnpBans} />
        )}

        {screen === 'pnp-draft-o' && (
          <DraftScreen playerLabel={pnpNameO} onReady={handlePnpDraftO} onBack={goMenu} banned={pnpBans} />
        )}

        {screen === 'pnp-game' && (
          <PassAndPlay
            mode={gameMode}
            nameX={pnpNameX}
            nameO={pnpNameO}
            draftX={pnpDraftX}
            draftO={pnpDraftO}
            onBack={goMenu}
          />
        )}
      </div>
    </div>
  );
}
