import { useEffect, useRef, useState } from "react";
import { playbackRateSchema, positionAt, type Playback, type PlayerCommand } from "../shared/protocol";

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
  onDuration: (instance: string, duration: number) => void;
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
  const [embedBlockedInstance, setEmbedBlockedInstance] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<false | "muted" | "paused">(false);
  const [hint, setHint] = useState("");
  const [status, setStatus] = useState("YouTube wird geladen ...");
  const [unavailableRate, setUnavailableRate] = useState(false);

  useEffect(() => {
    let disposed = false;
    let autoplayTimer: ReturnType<typeof setTimeout> | undefined;
    let controlTimer: ReturnType<typeof setTimeout> | undefined;
    let sample: { position: number; at: number; state: number; rate: number } | null = null;
    let expectedState: { state: number; until: number } | null = null;
    let expectedSeek: { position: number; speed: number; at: number; until: number } | null = null;
    let localUntil = 0;
    let autoMuted = false;
    let unmuteGuardUntil = 0;
    let loadingRate = false;
    let retry: { instance: string | null; count: number } = { instance: null, count: 0 };
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const apply = (state: number, action: () => void, position?: number) => {
      const at = performance.now();
      expectedState = { state, until: at + 5000 };
      if (position !== undefined) expectedSeek = { position, speed: state === YT.PlayerState.PLAYING ? latest.current.playback?.rate ?? 1 : 0, at, until: at + 5000 };
      sample = null;
      action();
    };
    const observe = () => {
      const yt = player.current;
      const { playback, connected } = latest.current;
      if (!yt || !ready.current) return;
      const current = { position: yt.getCurrentTime(), at: performance.now(), state: yt.getPlayerState(), rate: yt.getPlaybackRate() || 1 };
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
        const target = expectedSeek.position + expectedSeek.speed * (current.at - expectedSeek.at) / 1000;
        if (Math.abs(current.position - target) < 0.75 || current.at >= expectedSeek.until) expectedSeek = null;
      }
      if (!previous) return;
      const elapsed = previous.state === YT.PlayerState.PLAYING ? (current.at - previous.at) / 1000 * previous.rate : 0;
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
      if (disposed || !yt || !ready.current || !connected || !playback?.playing ||
          loadedInstance.current !== playback.instance || failedInstance.current === playback.instance) return;
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
    const syncRate = () => {
      const yt = player.current;
      const { playback, connected } = latest.current;
      if (!yt || !connected || !playback || loadedInstance.current !== playback.instance ||
          failedInstance.current === playback.instance || yt.getVideoData()?.video_id !== playback.entry.videoId) return;
      const rates = yt.getAvailablePlaybackRates();
      if (!rates?.length) return;
      const supported = rates.includes(playback.rate);
      setUnavailableRate(!supported);
      const target = supported ? playback.rate : 1;
      loadingRate = false;
      if (rates.includes(target) && yt.getPlaybackRate() !== target) yt.setPlaybackRate(target);
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
        if (failedInstance.current !== null) setError("");
        failedInstance.current = null;
        setEmbedBlockedInstance(null);
        setBlocked(false);
        setUnavailableRate(false);
        setStatus("Fuege einen YouTube-Link hinzu.");
        return;
      }
      const target = positionAt(playback, serverNow());
      if (loadedInstance.current !== playback.instance) {
        loadedInstance.current = playback.instance;
        failedInstance.current = null;
        setEmbedBlockedInstance(null);
        reportedEnd.current = null;
        setError("");
        setBlocked(false);
        setUnavailableRate(false);
        localUntil = 0;
        loadingRate = true;
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
      syncRate();
      const state = yt.getPlayerState();
      const duration = yt.getDuration();
      if (duration > 0 && yt.getVideoData()?.video_id === playback.entry.videoId) latest.current.onDuration(playback.instance, duration);
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
      if (!yt || !ready.current || !playback || !connected || failedInstance.current === playback.instance) return;
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
            if (event.data === YT.PlayerState.PLAYING || event.data === YT.PlayerState.CUED) syncRate();
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
          onPlaybackRateChange: (event) => {
            const { playback, connected } = latest.current;
            if (disposed || loadingRate || !ready.current || !connected || !playback || loadedInstance.current !== playback.instance ||
                failedInstance.current === playback.instance || event.target.getVideoData()?.video_id !== playback.entry.videoId) return;
            const rate = playbackRateSchema.safeParse(event.data);
            if (!rate.success || rate.data === playback.rate ||
                (rate.data === 1 && !event.target.getAvailablePlaybackRates()?.includes(playback.rate))) return;
            // Loading a video resets YouTube's rate; only share changes made in its focused player.
            if (!(document.activeElement instanceof HTMLIFrameElement) || !host.current?.contains(document.activeElement)) return;
            localUntil = performance.now() + 1500;
            latest.current.command({ type: "rate", instance: playback.instance, rate: rate.data });
          },
          onError: (event) => {
            if (disposed) return;
            const instance = loadedInstance.current;
            if (!instance || latest.current.playback?.instance !== instance) return;
            clearTimeout(autoplayTimer);
            clearTimeout(controlTimer);
            setBlocked(false);
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
            const embedBlocked = event.data === 101 || event.data === 150;
            setEmbedBlockedInstance(embedBlocked ? instance : null);
            setError(embedBlocked
              ? "Dieses Video darf nicht eingebettet werden. Auf YouTube kannst du es separat ansehen."
              : event.data === 5
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
    props.playback?.updatedAt, props.playback?.rate, props.connected,
  ]);

  useEffect(() => {
    const instance = props.playback?.instance;
    if (!instance) return;
    const timer = setInterval(() => {
      const current = latest.current.playback;
      const data = player.current?.getVideoData();
      if (current?.instance !== instance || current.entry.videoId !== data?.video_id || !data.title.trim()) return;
      latest.current.onTitle(instance, data.title);
      const duration = player.current?.getDuration();
      if (duration && duration > 0) latest.current.onDuration(instance, duration);
      clearInterval(timer);
    }, 500);
    return () => clearInterval(timer);
  }, [props.playback?.instance]);

  const unlock = () => {
    unlockRef.current();
  };
  const playback = props.playback;
  const embedBlocked = playback !== null && playback.instance === embedBlockedInstance;
  return <>
    <div className="video-frame" ref={host} />
    <p className={`player-status${props.playback ? " sr-only" : ""}`} aria-live="polite">{status}</p>
    {blocked && !error && props.connected && playback?.playing && <button className="primary" onClick={unlock}>
      {blocked === "muted" ? "Ton einschalten" : "Wiedergabe in diesem Browser freigeben"}</button>}
    {hint && !error && blocked === "muted" && <p className="player-hint">{hint}</p>}
    {unavailableRate && <p className="player-hint" role="status">YouTube bietet das gewählte Raumtempo auf diesem Gerät nicht an.</p>}
    {error && <div className="error">
      <span role="alert">{error}</span>{" "}
      {playback && failedInstance.current === playback.instance &&
        <a href={`https://www.youtube.com/watch?v=${playback.entry.videoId}`} target="_blank" rel="noreferrer">Auf YouTube ansehen</a>}
      {embedBlocked && <button disabled={!props.connected}
        onClick={() => props.command({ type: "next", instance: playback.instance })}>Für alle überspringen</button>}
    </div>}
  </>;
}
