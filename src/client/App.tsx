import { useEffect, useRef, useState, type FormEvent } from "react";
import { joinSchema, roomIdSchema, positionAt } from "../shared/protocol";
import { useRoom } from "./connection";
import { Icon, RoomControls } from "./RoomControls";
import { YouTubePlayer } from "./YouTubePlayer";

function Room({ roomId, name, onLeave }: { roomId: string; name: string; onLeave: () => void }) {
  const room = useRoom(roomId, name);
  const [url, setUrl] = useState("");
  const [position, setPosition] = useState(0);
  const [copied, setCopied] = useState(false);
  const [videoTitle, setVideoTitle] = useState<{ instance: string; title: string } | null>(null);
  const [videoDuration, setVideoDuration] = useState<{ instance: string; duration: number } | null>(null);
  const inviteDialog = useRef<HTMLDialogElement>(null);
  const [copyError, setCopyError] = useState("");
  const inviteUrl = `${location.origin}/room/${roomId}`;
  const playback = room.snapshot?.playback ?? null;
  const isFirst = room.snapshot?.participants.some(({ id, rank }) => id === room.participantId && rank === 1);
  useEffect(() => {
    const key = `wbt:invite:${roomId}`;
    if (room.connected && isFirst && inviteDialog.current && !sessionStorage.getItem(key)) {
      inviteDialog.current.showModal();
      sessionStorage.setItem(key, "shown");
    }
  }, [roomId, room.connected, isFirst]);
  useEffect(() => {
    const update = () => setPosition(playback ? positionAt(playback, room.serverNow()) : 0);
    update();
    if (!playback?.playing) return;
    const timer = setInterval(update, 250);
    return () => clearInterval(timer);
  }, [playback, room.serverNow]);
  const add = (event: FormEvent) => {
    event.preventDefault();
    if (url.trim()) room.queue({ type: "add", url: url.trim() });
  };
  const openInvite = () => {
    setCopied(false);
    setCopyError("");
    inviteDialog.current?.showModal();
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(inviteUrl); setCopied(true); setCopyError(""); }
    catch { setCopyError("Kopieren nicht möglich. Markiere den Link und kopiere ihn manuell."); }
  };
  return <main className="room-layout">
    <dialog className="invite-dialog" ref={inviteDialog} aria-labelledby="invite-title">
      <form method="dialog" className="dialog-close"><button aria-label="Einladung schließen">×</button></form>
      <span className="eyebrow">Deine Watchparty</span>
      <h2 id="invite-title">Freunde einladen</h2>
      <p className="hint">Teile diesen Link mit deiner Gruppe. Wer den Link hat, kann mitmachen.</p>
      <input aria-label="Einladungslink" readOnly value={inviteUrl} onFocus={(event) => event.currentTarget.select()} />
      {copyError && <p className="hint" role="status">{copyError}</p>}
      <button className="primary" onClick={() => { void copy(); }}>{copied ? "Link kopiert" : "Link kopieren"}</button>
    </dialog>
    <section className="player-panel">
      <header className="room-header">
        <div><h1>Watchbettertogether</h1><span className={room.connected ? "badge online" : "badge"}>{room.connected ? "Verbunden" : "Nicht verbunden"}</span></div>
        <div className="header-actions">
          <a className="icon-button" href="https://www.youtube.com/" target="_blank" rel="noreferrer" title="YouTube-Startseite öffnen" aria-label="YouTube-Startseite öffnen"><Icon name="youtube" /></a>
          <button className="icon-button" onClick={openInvite} title="Freunde einladen" aria-label="Freunde einladen"><Icon name="link" /></button>
          <button onClick={() => room.leave(onLeave)}>Raum verlassen</button>
        </div>
      </header>
      {room.error && <div className="error" role="alert">{room.error} <button onClick={() => room.setError("")}>Schliessen</button></div>}
      {!room.connected && <button onClick={room.reconnect}>Erneut verbinden</button>}
      <YouTubePlayer playback={playback} connected={room.connected} serverNow={room.serverNow} ended={room.ended} command={room.player}
        onTitle={(instance, title) => setVideoTitle({ instance, title })}
        onDuration={(instance, duration) => setVideoDuration((current) => current?.instance === instance && current.duration === duration ? current : { instance, duration })} />
      <RoomControls key={playback?.instance ?? "empty"} playback={playback} connected={room.connected}
        hasNext={Boolean(room.snapshot?.queue.length)} position={position} command={room.player}
        duration={videoDuration && videoDuration.instance === playback?.instance ? Math.min(videoDuration.duration, 86400) : 0} />
      {playback && <p className="current-video"><a href={`https://www.youtube.com/watch?v=${playback.entry.videoId}`} target="_blank" rel="noreferrer">
        {videoTitle?.instance === playback.instance ? videoTitle.title : playback.entry.videoId}
      </a><span>↗</span></p>}
    </section>
    <aside className="side-panel">
      <section>
        <h2>Gemeinsame Warteschlange</h2>
        <form onSubmit={add} className="add-form">
          <label htmlFor="youtube-link">YouTube-Link</label>
          <input id="youtube-link" type="url" required maxLength={2048} value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://www.youtube.com/watch?v=..." />
          <button className="primary" disabled={!room.connected}>Hinzufuegen</button>
        </form>
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
        <button onClick={openInvite}>Einladungslink anzeigen</button>
        <p className="hint">Nur an deine Gruppe weitergeben. Jeder mit dem Link kann beitreten und steuern.</p>
      </section>
    </aside>
  </main>;
}

export function App() {
  const pathMatch = /^\/room\/([^/]+)$/.exec(location.pathname);
  const parsedRoom = roomIdSchema.safeParse(pathMatch?.[1]);
  const [defaultName] = useState(() => {
    const saved = joinSchema.shape.name.safeParse(sessionStorage.getItem("wbt:name"));
    return saved.success ? saved.data : "Gast";
  });
  const [name, setName] = useState("");
  const displayName = name.trim() || defaultName;
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
      sessionStorage.setItem("wbt:name", displayName);
      location.assign(`/room/${String(body.roomId)}`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Raumerstellung fehlgeschlagen.");
      setCreating(false);
    }
  };
  if (joined && parsedRoom.success) return <Room roomId={parsedRoom.data} name={displayName} onLeave={() => location.assign("/")} />;
  return <main className="landing">
    <span className="eyebrow">Dein privater Filmabend</span>
    <h1>YouTube.<br />Zusammen schauen.</h1>
    <p>Ein Link, ein Raum, eine gemeinsame Warteschlange. Ohne Anmeldung.</p>
    {pathMatch && !parsedRoom.success && <p className="error" role="alert">Ungueltiger Einladungslink. Bitte einen neuen Link anfordern.</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <form onSubmit={parsedRoom.success ? (event) => { event.preventDefault(); sessionStorage.setItem("wbt:name", displayName); setJoined(true); } : (event) => { void create(event); }}>
      <label htmlFor="display-name">Dein Anzeigename</label>
      <input id="display-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={32} placeholder={defaultName} />
      <button className="primary" disabled={creating}>{parsedRoom.success ? "Raum beitreten" : creating ? "Raum wird erstellt ..." : "Privaten Raum erstellen"}</button>
    </form>
    <p className="hint">Bis zu 5 Personen pro Raum. Nur einbettbare YouTube-Videos, keine Livestreams.</p>
  </main>;
}
