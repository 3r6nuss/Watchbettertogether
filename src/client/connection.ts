import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type { Ack, ClientEvents, PlayerCommand, QueueCommand, ServerEvents, Snapshot } from "../shared/protocol";

type PartySocket = Socket<ServerEvents, ClientEvents>;
export function useRoom(roomId: string, name: string) {
  const socketRef = useRef<PartySocket | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [participantId, setParticipantId] = useState("");
  const [error, setError] = useState("");
  const clock = useRef({ offset: 0, bestRtt: Infinity });
  const connectionRef = useRef(false);
  const instanceRef = useRef<string | null>(null);
  const serverNow = useCallback(() => Date.now() + clock.current.offset, []);

  useEffect(() => {
    const socket: PartySocket = io({ autoConnect: false, transports: ["websocket", "polling"], tryAllTransports: true });
    socketRef.current = socket;
    const tokenKey = `wbt:${roomId}:token`;
    let disposed = false;
    let joined = false;
    let revision = -1;
    const accept = (state: Snapshot) => {
      if (state.roomId !== roomId || state.revision < revision) return;
      revision = state.revision;
      instanceRef.current = state.playback?.instance ?? null;
      setSnapshot(state);
    };
    const syncClock = () => {
      const sent = Date.now();
      socket.timeout(5000).emit("clock", (failure: Error | null, result?: Parameters<Ack<number>>[0]) => {
        if (disposed || !joined) return;
        if (failure || !result?.ok) {
          setError(result && !result.ok ? result.error : "Zeitabgleich fehlgeschlagen.");
          return;
        }
        const received = Date.now();
        const rtt = received - sent;
        if (rtt <= clock.current.bestRtt) {
          clock.current = { bestRtt: rtt, offset: result.data - (sent + received) / 2 };
        }
      });
    };
    socket.on("snapshot", (state) => { if (joined) accept(state); });
    socket.on("connect", () => {
      clock.current = { offset: 0, bestRtt: Infinity };
      const token = sessionStorage.getItem(tokenKey) ?? undefined;
      socket.timeout(5000).emit("join", { roomId, name, token }, (failure: Error | null, result?: Parameters<Ack<{ token: string; participantId: string; snapshot: Snapshot }>>[0]) => {
        if (disposed) return;
        if (failure || !result?.ok) {
          setError(result && !result.ok ? result.error : "Beitritt fehlgeschlagen. Bitte erneut verbinden.");
          return;
        }
        joined = true;
        revision = -1;
        sessionStorage.setItem(tokenKey, result.data.token);
        setParticipantId(result.data.participantId);
        clock.current.offset = result.data.snapshot.serverTime - Date.now();
        accept(result.data.snapshot);
        connectionRef.current = true;
        setConnected(true);
        setError("");
        syncClock();
      });
    });
    socket.on("disconnect", () => {
      joined = false;
      connectionRef.current = false;
      setConnected(false);
    });
    socket.on("connect_error", () => setError("Verbindung fehlgeschlagen. Automatischer Wiederverbindungsversuch ..."));
    socket.connect();
    const timer = setInterval(() => { if (joined) syncClock(); }, 10_000);
    return () => {
      disposed = true;
      clearInterval(timer);
      socket.disconnect();
      socketRef.current = null;
      connectionRef.current = false;
    };
  }, [roomId, name]);

  const resultAck = (failure: Error | null, result?: Parameters<Ack>[0]) => {
    if (failure || !result?.ok) setError(result && !result.ok ? result.error : "Keine Bestaetigung erhalten. Raumzustand pruefen und ggf. erneut versuchen.");
  };
  const player = (command: PlayerCommand) => {
    if (!connectionRef.current) { setError("Keine Verbindung zum Raum."); return; }
    socketRef.current!.timeout(5000).emit("player", command, resultAck);
  };
  const queue = (command: QueueCommand) => {
    if (!connectionRef.current) { setError("Keine Verbindung zum Raum."); return; }
    socketRef.current!.timeout(5000).emit("queue", command, resultAck);
  };
  const ended = (instance: string, duration: number) => {
    if (connectionRef.current && instanceRef.current === instance) {
      socketRef.current!.timeout(5000).emit("ended", { instance, duration }, resultAck);
    }
  };
  const leave = (done: () => void) => {
    if (!connectionRef.current) { setError("Zum ausdruecklichen Verlassen bitte erst erneut verbinden."); return; }
    socketRef.current!.timeout(5000).emit("leave", (failure: Error | null, result?: Parameters<Ack>[0]) => {
      if (failure || !result?.ok) { resultAck(failure, result); return; }
      sessionStorage.removeItem(`wbt:${roomId}:token`);
      done();
    });
  };
  const reconnect = () => {
    socketRef.current?.disconnect();
    socketRef.current?.connect();
  };
  return { snapshot, connected, participantId, error, setError, player, queue, ended, leave, reconnect,
    serverNow };
}
