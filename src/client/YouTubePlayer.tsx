import { useEffect, useRef, useState } from "react";
import { positionAt, type Playback, type PlayerCommand } from "../shared/protocol";

declare global {
  interface Window { onYouTubeIframeAPIReady: () => void }
}

let apiPromise: Promise<void> | undefined;
function loadApi(): Promise<void> {
  if (typeof YT !== "undefined" && YT.Player) return Promise.resolve();
  if (!apiPromise) {
    apiPromise = new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      const timeout = window.setTimeout(() => { apiPromise = undefined; reject(new Error("YouTube ist nicht erreichbar. Bitte neu laden.")); }, 15_000);
      window.onYouTubeIframeAPIReady = () => { clearTimeout(timeout); resolve(); };
      script.src = "https://www.youtube.com/iframe_api";
      script.onerror = () => { clearTimeout(timeout); apiPromise = undefined; reject(new Error("YouTube konnte nicht geladen werden. Bitte neu laden.")); };
      document.head.append(script);
    });
  }
  return apiPromise;
}
// Start loading while the join screen is shown so the player is ready right after joining.
if (typeof window !== "undefined") loadApi().catch(() => {});

interface Props {
  playback: Playback | null;
  connected: boolean;
  serverNow: () => number;
  ended: (instance: string, duration: number) => void;
  command: (command: PlayerCommand) => void;
  onTitle: (instance: string, title: string) => void;
}

export function YouTubePlayer(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const player = useRef<YT.Player | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const loadedInstance = useRef<string | null>(null);
  const ready = useRef(false);
  const failedInstance = useRef<string | null>(null);
  const reportedEnd = useRef<string | null>(null);
  const resetSyncRef = useRef<() => void>(() => {});
  const unlockRef = useRef<() => void>(() => {});
  const [error, setError] = useState("");
  const [blocked, setBlocked] = useState<false | "muted" | "paused">(false);
  const [hint, setHint] = useState("");
  const [status, setStatus] = useState("YouTube wird geladen ...");

  useEffect(() => {
    let disposed = false;
    let autoplayTimer: ReturnType<typeof setTimeout> | undefined;
    let controlTimer: ReturnType<typeof setTimeout> | undefined;
    let sample: { position: number; at: number; state: number } | null = null;
    let expectedState: { state: number; until: number } | null = null;
    let expectedSeek: { position: number; playing: boolean; at: number; until: number } | null = null;
    let localUntil = 0;
    let autoMuted = false;
    let unmuteGuardUntil = 0;
    let retry: { instance: string | null; count: number } = { instance: null, count: 0 };
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const apply = (state: number, action: () => void, position?: number) => {
      const at = performance.now();
      expectedState = { state, until: at + 5000 };
      if (position !== undefined) expectedSeek = { position, playing: state === YT.PlayerState.PLAYING, at, until: at + 5000 };
      sample = null;
      action();
    };
    const observe = () => {
      const yt = player.current;
      const { playback, connected } = latest.current;
      if (!yt || !ready.current) return;
      const current = { position: yt.getCurrentTime(), at: performance.now(), state: yt.getPlayerState() };
      const previous = sample;
      sample = current;
      if (!connected || !playback || loadedInstance.current !== playback.instance ||
          failedInstance.current === playback.instance) return;
      // Browsers may pause a video that is unmuted without a gesture inside the iframe; never share that pause.
      // A real pause through YouTube's controls moves focus into the player iframe.
      const userInPlayer = document.activeElement instanceof HTMLIFrameElement &&
        host.current?.contains(document.activeElement);
      if (current.at < unmuteGuardUntil && !userInPlayer && playback.playing && current.state === YT.PlayerState.PAUSED) {
        unmuteGuardUntil = 0;
        clearTimeout(controlTimer);
        autoMuted = true;
        yt.mute();
        setBlocked("muted");
        setHint("Dein Browser erlaubt hier keinen Ton. Nutze das Lautsprecher-Symbol im YouTube-Player.");
        const target = positionAt(playback, latest.current.serverNow());
        apply(YT.PlayerState.PLAYING, () => { yt.seekTo(target, true); yt.playVideo(); }, target);
        return;
      }
      const suppressState = expectedState !== null;
      const suppressSeek = expectedSeek !== null;
      if (expectedState && (current.state === expectedState.state || current.at >= expectedState.until)) {
        expectedState = null;
      }
      if (expectedSeek) {
        const target = expectedSeek.position + (expectedSeek.playing ? (current.at - expectedSeek.at) / 1000 : 0);
        if (Math.abs(current.position - target) < 0.75 || current.at >= expectedSeek.until) expectedSeek = null;
      }
      if (!previous) return;
      const elapsed = previous.state === YT.PlayerState.PLAYING ? (current.at - previous.at) / 1000 : 0;
      // The IFrame API has no seek event, so detect discontinuities in sampled playback time.
      const sought = !suppressSeek && Math.abs(current.position - previous.position - elapsed) > 0.75;
      const stable = current.state === YT.PlayerState.PLAYING || current.state === YT.PlayerState.PAUSED;
      const toggled = !suppressState && stable && current.state !== previous.state &&
        (current.state === YT.PlayerState.PLAYING) !== playback.playing;
      if (current.state === YT.PlayerState.BUFFERING) localUntil = current.at + 1500;
      if ((!sought && !toggled) || current.state === YT.PlayerState.ENDED) return;
      const instance = playback.instance;
      const playing = stable ? current.state === YT.PlayerState.PLAYING : playback.playing;
      localUntil = current.at + 1500;
      clearTimeout(controlTimer);
      controlTimer = setTimeout(() => {
        const latestPlayback = latest.current.playback;
        if (!latest.current.connected || latestPlayback?.instance !== instance) return;
        const position = yt.getCurrentTime();
        if (!Number.isFinite(position) || position < 0 || position > 86400) {
          setError("YouTube meldet eine ungueltige Wiedergabeposition. Bitte das Video neu laden.");
          return;
        }
        const state = yt.getPlayerState();
        const finalPlaying = state === YT.PlayerState.PLAYING ? true : state === YT.PlayerState.PAUSED ? false : playing;
        latest.current.command({ type: finalPlaying ? "play" : "pause", instance, position });
      }, 100);
    };
    // Browsers usually allow muted autoplay, so keep the room in sync and let the user enable sound.
    const handleBlocked = (reported = false) => {
      const yt = player.current;
      const { playback, connected, serverNow } = latest.current;
      if (disposed || !yt || !ready.current || !connected || !playback?.playing) return;
      const state = yt.getPlayerState();
      if (state === YT.PlayerState.PLAYING) return;
      if (!autoMuted && !yt.isMuted()) {
        autoMuted = true;
        yt.mute();
        setBlocked("muted");
        const target = positionAt(playback, serverNow());
        apply(YT.PlayerState.PLAYING, () => { yt.seekTo(target, true); yt.playVideo(); }, target);
        checkAutoplay();
      } else if (reported || state === YT.PlayerState.PAUSED || state === YT.PlayerState.CUED) {
        setBlocked("paused");
      } else {
        // Muted playback is allowed, so an unstarted player is still loading (slow network): keep waiting.
        checkAutoplay();
      }
    };
    const checkAutoplay = () => {
      clearTimeout(autoplayTimer);
      autoplayTimer = setTimeout(() => {
        if (!disposed && latest.current.connected && latest.current.playback?.playing && ready.current) {
          const state = player.current?.getPlayerState();
          if (state === YT.PlayerState.BUFFERING) checkAutoplay();
          else if (state !== YT.PlayerState.PLAYING) handleBlocked();
        }
      }, 1500);
    };
    const sync = () => {
      const yt = player.current;
      const { playback, connected, serverNow } = latest.current;
      if (!yt || !ready.current) return;
      if (!connected) {
        clearTimeout(controlTimer);
        apply(YT.PlayerState.PAUSED, () => yt.pauseVideo());
        setStatus("Verbindung unterbrochen - lokal pausiert");
        return;
      }
      if (!playback) {
        if (loadedInstance.current !== null) apply(YT.PlayerState.UNSTARTED, () => yt.stopVideo());
        loadedInstance.current = null;
        setBlocked(false);
        setStatus("Fuege einen YouTube-Link hinzu.");
        return;
      }
      const target = positionAt(playback, serverNow());
      if (loadedInstance.current !== playback.instance) {
        loadedInstance.current = playback.instance;
        failedInstance.current = null;
        reportedEnd.current = null;
        setError("");
        setBlocked(false);
        const video = { videoId: playback.entry.videoId, startSeconds: target };
        clearTimeout(controlTimer);
        if (playback.playing) {
          apply(YT.PlayerState.PLAYING, () => yt.loadVideoById(video), target);
          checkAutoplay();
        } else apply(YT.PlayerState.CUED, () => yt.cueVideoById(video), target);
        setStatus(playback.playing ? "Wiedergabe wird synchronisiert ..." : "Pausiert");
        return;
      }
      if (failedInstance.current === playback.instance) return;
      if (performance.now() < localUntil) return;
      const state = yt.getPlayerState();
      const duration = yt.getDuration();
      if (state === YT.PlayerState.ENDED && playback.playing && reportedEnd.current !== playback.instance &&
          duration > 0 && target >= duration - 1.5) {
        reportedEnd.current = playback.instance;
        latest.current.ended(playback.instance, duration);
      }
      if (state !== YT.PlayerState.BUFFERING && Math.abs(yt.getCurrentTime() - target) > 0.75) {
        apply(playback.playing ? YT.PlayerState.PLAYING : YT.PlayerState.PAUSED, () => {
          yt.seekTo(target, true);
          if (!playback.playing) yt.pauseVideo();
        }, target);
      }
      if (playback.playing && state !== YT.PlayerState.PLAYING && state !== YT.PlayerState.BUFFERING && state !== YT.PlayerState.ENDED) {
        apply(YT.PlayerState.PLAYING, () => yt.playVideo());
        checkAutoplay();
      } else if (!playback.playing && state !== YT.PlayerState.PAUSED && state !== YT.PlayerState.CUED) {
        apply(YT.PlayerState.PAUSED, () => yt.pauseVideo());
        setBlocked(false);
      }
      setStatus(state === YT.PlayerState.BUFFERING ? "YouTube puffert ..." :
        !playback.playing ? "Pausiert" :
        state === YT.PlayerState.PLAYING ? "Gemeinsame Wiedergabe" : "Wiedergabe wird synchronisiert ...");
    };
    resetSyncRef.current = () => {
      localUntil = 0;
      expectedState = null;
      expectedSeek = null;
      clearTimeout(controlTimer);
      sync();
    };
    unlockRef.current = () => {
      const yt = player.current;
      const { playback, connected, serverNow } = latest.current;
      if (!yt || !ready.current || !playback || !connected) return;
      const target = positionAt(playback, serverNow());
      if (autoMuted) unmuteGuardUntil = performance.now() + 3000;
      setHint("");
      apply(YT.PlayerState.PLAYING, () => {
        yt.seekTo(target, true);
        yt.playVideo();
        if (autoMuted) yt.unMute();
      }, target);
      autoMuted = false;
      setBlocked(false);
      checkAutoplay();
    };
    void loadApi().then(() => {
      if (disposed || !host.current) return;
      const element = document.createElement("div");
      host.current.append(element);
      player.current = new YT.Player(element, {
        width: "100%", height: "100%",
        playerVars: { controls: 1, fs: 1, playsinline: 1, rel: 0, origin: location.origin },
        events: {
          onReady: () => {
            if (disposed) return;
            ready.current = true;
            player.current?.setVolume(75);
            sync();
          },
          onStateChange: (event) => {
            if (disposed) return;
            if (event.data === YT.PlayerState.PLAYING) {
              if (retry.instance === loadedInstance.current) retry.count = 0;
              if (autoMuted && !event.target.isMuted()) autoMuted = false;
              setBlocked(autoMuted ? "muted" : false);
            }
            observe();
            if (event.data !== YT.PlayerState.ENDED) return;
            const playback = latest.current.playback;
            const duration = event.target.getDuration();
            if (playback && loadedInstance.current === playback.instance && playback.playing &&
                reportedEnd.current !== playback.instance && duration > 0 &&
                positionAt(playback, latest.current.serverNow()) >= duration - 1.5) {
              reportedEnd.current = playback.instance;
              latest.current.ended(playback.instance, duration);
            }
          },
          onError: (event) => {
            if (disposed) return;
            const instance = loadedInstance.current;
            // Error 5 is a transient HTML5 playback error; reload at the room position instead of giving up.
            if (event.data === 5 && instance) {
              if (retry.instance !== instance) retry = { instance, count: 0 };
              if (retry.count < 3) {
                retry.count++;
                setStatus("YouTube-Wiedergabefehler - Video wird neu geladen ...");
                loadedInstance.current = null;
                clearTimeout(retryTimer);
                retryTimer = setTimeout(sync, 1000 * retry.count);
                return;
              }
            }
            failedInstance.current = instance;
            setError(event.data === 5
              ? "YouTube-Fehler 5: Das Video konnte in diesem Browser nicht abgespielt werden. Bitte die Seite neu laden."
              : `YouTube-Fehler ${event.data}: Video nicht verfuegbar oder nicht einbettbar. Bitte ein anderes Video waehlen.`);
          },
        },
      });
      player.current.addEventListener("onAutoplayBlocked", () => handleBlocked(true));
    }).catch((failure: unknown) => {
      if (!disposed) setError(failure instanceof Error ? failure.message : "YouTube konnte nicht geladen werden.");
    });
    const interval = setInterval(sync, 2000);
    const observationInterval = setInterval(observe, 100);
    return () => {
      disposed = true;
      clearInterval(interval);
      clearInterval(observationInterval);
      clearTimeout(autoplayTimer);
      clearTimeout(controlTimer);
      clearTimeout(retryTimer);
      ready.current = false;
      loadedInstance.current = null;
      player.current?.destroy();
      player.current = null;
      resetSyncRef.current = () => {};
      unlockRef.current = () => {};
    };
  }, []);

  useEffect(() => { resetSyncRef.current(); }, [
    props.playback?.instance, props.playback?.playing, props.playback?.position,
    props.playback?.updatedAt, props.connected,
  ]);

  useEffect(() => {
    const instance = props.playback?.instance;
    if (!instance) return;
    const timer = setInterval(() => {
      const current = latest.current.playback;
      const data = player.current?.getVideoData();
      if (current?.instance !== instance || current.entry.videoId !== data?.video_id || !data.title.trim()) return;
      latest.current.onTitle(instance, data.title);
      clearInterval(timer);
    }, 500);
    return () => clearInterval(timer);
  }, [props.playback?.instance]);

  const unlock = () => {
    unlockRef.current();
  };
  return <>
    <div className="video-frame" ref={host} />
    <p className="player-status" aria-live="polite">{status}</p>
    {blocked && props.connected && props.playback?.playing && <button className="primary" onClick={unlock}>
      {blocked === "muted" ? "Ton einschalten" : "Wiedergabe in diesem Browser freigeben"}</button>}
    {hint && blocked === "muted" && <p className="player-hint">{hint}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <label className="volume">Deine Lautstaerke <input aria-label="Lautstaerke" type="range" min="0" max="100" defaultValue="75"
      onChange={(event) => { if (ready.current) player.current?.setVolume(Number(event.target.value)); }} /></label>
  </>;
}
