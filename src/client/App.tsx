import { useEffect, useState, type FormEvent } from "react";
import { roomIdSchema, positionAt } from "../shared/protocol";
import { useRoom } from "./connection";
import { YouTubePlayer } from "./YouTubePlayer";

function formatTime(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}
function Room({ roomId, name, onLeave }: { roomId: string; name: string; onLeave: () => void }) {
  const room = useRoom(roomId, name);
  const [url, setUrl] = useState("");
  const [seek, setSeek] = useState("");
  const [position, setPosition] = useState(0);
  const [copied, setCopied] = useState(false);
  const [videoTitle, setVideoTitle] = useState<{ instance: string; title: string } | null>(null);
  const playback = room.snapshot?.playback ?? null;
  useEffect(() => {
    const update = () => setPosition(playback ? positionAt(playback, room.serverNow()) : 0);
    update();
    const timer = setInterval(update, 500);
    return () => clearInterval(timer);
  }, [playback, room.serverNow]);
  const sendPlayer = (type: "play" | "pause" | "next") => {
    if (playback) room.player({ type, instance: playback.instance });
  };
  const add = (event: FormEvent) => {
    event.preventDefault();
    if (url.trim()) { room.queue({ type: "add", url: url.trim() }); }
  };
  const seekTo = (event: FormEvent) => {
    event.preventDefault();
    const value = Number(seek);
    if (!playback || !seek.trim() || !Number.isFinite(value) || value < 0 || value > 86400) {
      room.setError("Bitte eine Position zwischen 0 und 86400 Sekunden eingeben.");
      return;
    }
    room.player({ type: "seek", instance: playback.instance, position: value });
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(location.href); setCopied(true); }
    catch { room.setError("Einladungslink konnte nicht kopiert werden. Bitte aus der Adresszeile kopieren."); }
  };
  return <main className="room-layout">
    <section className="player-panel">
      <header className="room-header">
        <div><h1>Watchbettertogether</h1><span className={room.connected ? "badge online" : "badge"}>{room.connected ? "Verbunden" : "Nicht verbunden"}</span></div>
        <button onClick={() => room.leave(onLeave)}>Raum verlassen</button>
      </header>
      {room.error && <div className="error" role="alert">{room.error} <button onClick={() => room.setError("")}>Schliessen</button></div>}
      {!room.connected && <button onClick={room.reconnect}>Erneut verbinden</button>}
      <YouTubePlayer playback={playback} connected={room.connected} serverNow={room.serverNow} ended={room.ended} command={room.player}
        onTitle={(instance, title) => setVideoTitle({ instance, title })} />
      {playback && <p className="current-video">Aktuell: <a href={`https://www.youtube.com/watch?v=${playback.entry.videoId}`} target="_blank" rel="noreferrer">
        {videoTitle?.instance === playback.instance ? videoTitle.title : playback.entry.videoId}
      </a></p>}
      <div className="controls">
        <button className="primary" disabled={!room.connected || !playback} onClick={() => sendPlayer(playback?.playing ? "pause" : "play")}>{playback?.playing ? "Pause" : "Abspielen"}</button>
        <button disabled={!room.connected || !playback} onClick={() => sendPlayer("next")}>Naechstes Video</button>
        <output aria-label="Raumposition">{formatTime(position)}</output>
        <form onSubmit={seekTo} className="seek-form">
          <input aria-label="Position in Sekunden" type="number" min="0" max="86400" step="0.1" value={seek} onChange={(event) => setSeek(event.target.value)} placeholder="Sekunden" />
          <button disabled={!room.connected || !playback}>Spulen</button>
        </form>
      </div>
      <p className="hint">YouTube-Controls: Play, Pause und Spulen gelten fuer alle. Vollbild und Lautstaerke entscheidest nur du. Bei gleichzeitigen Befehlen hat die fruehere Join-Position Vorrang. Werbung und Buffering koennen die Synchronitaet beeinflussen.</p>
    </section>
    <aside className="side-panel">
      <section>
        <h2>Gemeinsame Warteschlange</h2>
        <form onSubmit={add} className="add-form">
          <label htmlFor="youtube-link">YouTube-Link</label>
          <input id="youtube-link" type="url" required maxLength={2048} value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://www.youtube.com/watch?v=..." />
          <button className="primary" disabled={!room.connected}>Hinzufuegen</button>
        </form>
        <p className="hint">Das erste Video startet automatisch fuer alle. Weitere Links kommen ans Ende; am Videoende geht es automatisch weiter.</p>
        <ol className="queue">
          {room.snapshot?.queue.map((entry, index, entries) => <li key={entry.id}>
            <a href={`https://www.youtube.com/watch?v=${entry.videoId}`} target="_blank" rel="noreferrer">{entry.videoId}</a>
            <div className="queue-actions">
              <button disabled={!room.connected} onClick={() => room.player({ type: "load", entryId: entry.id, instance: playback?.instance ?? null })}>Jetzt spielen</button>
              <button aria-label={`Video ${index + 1} nach oben`} disabled={!room.connected || index === 0} onClick={() => room.queue({ type: "move", entryId: entry.id, beforeId: entries[index - 1].id })}>Hoch</button>
              <button aria-label={`Video ${index + 1} nach unten`} disabled={!room.connected || index === entries.length - 1} onClick={() => room.queue({ type: "move", entryId: entry.id, beforeId: entries[index + 2]?.id ?? null })}>Runter</button>
              <button disabled={!room.connected} onClick={() => room.queue({ type: "remove", entryId: entry.id })}>Entfernen</button>
            </div>
          </li>)}
        </ol>
        {!room.snapshot?.queue.length && <p className="muted">Noch keine weiteren Videos.</p>}
      </section>
      <section>
        <h2>Teilnehmer ({room.snapshot?.participants.length ?? 0}/5)</h2>
        <ol className="participants">
          {room.snapshot?.participants.map((member) => <li key={member.id}><span className="rank">#{member.rank}</span> {member.name}{member.id === room.participantId ? " (du)" : ""}</li>)}
        </ol>
        <button onClick={() => { void copy(); }}>{copied ? "Link kopiert" : "Einladungslink kopieren"}</button>
        <p className="hint">Nur an deine Gruppe weitergeben. Jeder mit dem Link kann beitreten und steuern.</p>
      </section>
    </aside>
  </main>;
}

export function App() {
  const pathMatch = /^\/room\/([^/]+)$/.exec(location.pathname);
  const parsedRoom = roomIdSchema.safeParse(pathMatch?.[1]);
  const [name, setName] = useState(sessionStorage.getItem("wbt:name") ?? "");
  const [joined, setJoined] = useState(false);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const create = async (event: FormEvent) => {
    event.preventDefault();
    setCreating(true);
    setError("");
    try {
      const response = await fetch("/api/rooms", { method: "POST" });
      const body: unknown = await response.json();
      if (!response.ok) {
        const message = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : "Raum konnte nicht erstellt werden.";
        throw new Error(message);
      }
      if (typeof body !== "object" || body === null || !("roomId" in body) || !roomIdSchema.safeParse(body.roomId).success) throw new Error("Ungueltige Serverantwort.");
      sessionStorage.setItem("wbt:name", name.trim());
      location.assign(`/room/${String(body.roomId)}`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Raumerstellung fehlgeschlagen.");
      setCreating(false);
    }
  };
  if (joined && parsedRoom.success) return <Room roomId={parsedRoom.data} name={name.trim()} onLeave={() => location.assign("/")} />;
  return <main className="landing">
    <span className="eyebrow">Dein privater Filmabend</span>
    <h1>YouTube.<br />Zusammen schauen.</h1>
    <p>Ein Link, ein Raum, eine gemeinsame Warteschlange. Ohne Anmeldung.</p>
    {pathMatch && !parsedRoom.success && <p className="error" role="alert">Ungueltiger Einladungslink. Bitte einen neuen Link anfordern.</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <form onSubmit={parsedRoom.success ? (event) => { event.preventDefault(); sessionStorage.setItem("wbt:name", name.trim()); setJoined(true); } : (event) => { void create(event); }}>
      <label htmlFor="display-name">Dein Anzeigename</label>
      <input id="display-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={32} required pattern={".*\\S.*"} placeholder="Wie sollen dich die anderen nennen?" />
      <button className="primary" disabled={creating || !name.trim()}>{parsedRoom.success ? "Raum beitreten" : creating ? "Raum wird erstellt ..." : "Privaten Raum erstellen"}</button>
    </form>
    <p className="hint">Bis zu 5 Personen pro Raum. Nur einbettbare YouTube-Videos, keine Livestreams.</p>
  </main>;
}
