import { useState } from "react";
import { playbackRates, playbackRateSchema, type Playback, type PlayerCommand } from "../shared/protocol";

type IconName = "play" | "pause" | "next" | "link" | "youtube";
export function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, string> = {
    play: "M8 5v14l11-7z",
    pause: "M7 5h4v14H7zM14 5h4v14h-4z",
    next: "M5 5v14l10-7zM17 5h2v14h-2z",
    link: "M10 15l4-6m-6 4-2 2a3 3 0 0 0 4 4l3-3m3-5 2-2a3 3 0 0 0-4-4l-3 3",
    youtube: "M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm6 3.5v7l6-3.5z",
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill={name === "link" ? "none" : "currentColor"} fillRule="evenodd">
    <path d={paths[name]} stroke={name === "link" ? "currentColor" : undefined} strokeWidth="2" strokeLinecap="round" />
  </svg>;
}

function formatTime(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

export function RoomControls({ playback, connected, hasNext, position, duration, command }: {
  playback: Playback | null;
  connected: boolean;
  hasNext: boolean;
  position: number;
  duration: number;
  command: (command: PlayerCommand) => void;
}) {
  const [preview, setPreview] = useState<number | null>(null);
  const disabled = !connected || !playback;
  const time = Math.min(preview ?? position, duration || position);
  const seek = () => {
    if (!disabled && playback && duration > 0 && preview !== null) {
      command({ type: "seek", instance: playback.instance, position: preview });
    }
    setPreview(null);
  };
  const playLabel = playback?.playing ? "Pause" : "Abspielen";
  return <div className="controls" aria-label="Gemeinsame Wiedergabesteuerung" role="group">
    <button className="primary icon-button play-button" aria-label={playLabel} title={playLabel} disabled={disabled}
      onClick={() => playback && command({ type: playback.playing ? "pause" : "play", instance: playback.instance })}>
      <Icon name={playback?.playing ? "pause" : "play"} />
    </button>
    <button className="icon-button" aria-label="Nächstes Video" title="Nächstes Video" disabled={disabled || !hasNext}
      onClick={() => playback && command({ type: "next", instance: playback.instance })}><Icon name="next" /></button>
    <div className="timeline">
      <input type="range" min={0} max={duration || 1} step={0.1} value={duration ? time : 0} disabled={disabled || !duration}
        aria-label="Videoposition" aria-valuetext={formatTime(time)} onChange={(event) => setPreview(event.currentTarget.valueAsNumber)}
        onPointerUp={seek} onPointerCancel={() => setPreview(null)} onBlur={seek}
        onKeyUp={(event) => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) seek(); }} />
      <output aria-label="Raumposition">{formatTime(time)} / {duration ? formatTime(duration) : "–:––"}</output>
    </div>
    <select className="rate-control" title="Tempo für alle" aria-label="Wiedergabegeschwindigkeit für alle" disabled={disabled}
      value={playback?.rate ?? 1} onChange={(event) => {
        const rate = playbackRateSchema.parse(Number(event.currentTarget.value));
        if (playback) command({ type: "rate", instance: playback.instance, rate });
      }}>
      {playbackRates.map((rate) => <option key={rate} value={rate}>{rate.toLocaleString("de-DE")}×</option>)}
    </select>
  </div>;
}
