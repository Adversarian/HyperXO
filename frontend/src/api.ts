const SIGNALING_PORT = 29170;

function isTauri(): boolean {
  return '__TAURI__' in window || '__TAURI_INTERNALS__' in window;
}

export async function createRoom(): Promise<{ roomId: string; joinUrl: string }> {
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<{ roomId: string; joinUrl: string }>('create_room_cmd');
    } catch (e) {
      throw new Error(`Failed to create room: ${e}`);
    }
  }
  const res = await fetch('/api/room', { method: 'POST' });
  if (!res.ok) throw new Error('Failed to create room');
  return res.json();
}

export function connectRoom(roomId: string): WebSocket {
  if (isTauri()) {
    return connectRoomTauri(roomId);
  }
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const host = window.location.host;
  return new WebSocket(`${proto}://${host}/ws/room/${roomId}`);
}

interface FakeEvent {
  data?: unknown;
  type: string;
}

type EventListener = (ev: FakeEvent) => void;

interface TauriFakeWs {
  url: string;
  readyState: number;
  send: (data: string) => void;
  close: () => void;
  addEventListener: (type: string, fn: EventListener) => void;
  removeEventListener: (type: string, fn: EventListener) => void;
  onmessage: EventListener | null;
  onerror: EventListener | null;
  onclose: EventListener | null;
  _onmessage?: EventListener | null;
  _onerror?: EventListener | null;
  _onclose?: EventListener | null;
}

interface TauriWsMessage {
  type?: string;
  data?: string;
}

// Uses the Tauri WebSocket plugin which routes through Rust,
// bypassing webview's mixed-content/CSP restrictions.
function connectRoomTauri(roomId: string): WebSocket {
  const url = `ws://127.0.0.1:${SIGNALING_PORT}/ws/room/${roomId}`;

  // Create a fake WebSocket-like object that the Lobby/FriendGame can use.
  // The real connection is established async via the Tauri plugin.
  const listeners: Record<string, EventListener[]> = {
    message: [],
    open: [],
    close: [],
    error: [],
  };

  const ws: TauriFakeWs = {
    url,
    readyState: WebSocket.CONNECTING,
    send: (_data: string) => {},
    close: () => {},
    addEventListener: (type: string, fn: EventListener) => {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push(fn);
    },
    removeEventListener: (type: string, fn: EventListener) => {
      if (listeners[type]) {
        listeners[type] = listeners[type].filter(f => f !== fn);
      }
    },
    set onmessage(fn: EventListener | null) {
      ws._onmessage = fn;
    },
    get onmessage() {
      return ws._onmessage ?? null;
    },
    set onerror(fn: EventListener | null) {
      ws._onerror = fn;
    },
    get onerror() {
      return ws._onerror ?? null;
    },
    set onclose(fn: EventListener | null) {
      ws._onclose = fn;
    },
    get onclose() {
      return ws._onclose ?? null;
    },
  };

  function emit(type: string, data?: unknown) {
    const ev: FakeEvent = { data, type };
    if (type === 'message' && ws._onmessage) ws._onmessage(ev);
    if (type === 'error' && ws._onerror) ws._onerror(ev);
    if (type === 'close' && ws._onclose) ws._onclose(ev);
    for (const fn of listeners[type] ?? []) fn(ev);
  }

  // Connect via Tauri plugin
  import('@tauri-apps/plugin-websocket').then(({ default: TauriWebSocket }) => {
    TauriWebSocket.connect(url).then((tauriWs: { send: (data: string) => void; disconnect: () => void; addListener: (fn: (msg: string | TauriWsMessage) => void) => void }) => {
      ws.readyState = WebSocket.OPEN;

      ws.send = (data: string) => {
        tauriWs.send(data);
      };

      ws.close = () => {
        tauriWs.disconnect();
        ws.readyState = WebSocket.CLOSED;
        emit('close');
      };

      tauriWs.addListener((msg: string | TauriWsMessage) => {
        if (typeof msg === 'string') {
          emit('message', msg);
        } else if (msg.type === 'Close') {
          ws.readyState = WebSocket.CLOSED;
          emit('close');
        } else if (msg.type === 'Text') {
          emit('message', msg.data);
        }
      });

      emit('open');
    }).catch((e: unknown) => {
      ws.readyState = WebSocket.CLOSED;
      emit('error', e);
    });
  });

  return ws as unknown as WebSocket;
}
