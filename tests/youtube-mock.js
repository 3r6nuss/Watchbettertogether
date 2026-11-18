(() => {
  const states = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };
  class Player {
    constructor(element, config) {
      this.config = config;
      this.state = -1;
      this.position = 0;
      this.at = Date.now();
      this.allowed = false;
      this.volume = 75;
      this.rate = 1;
      this.listeners = {};
      this.frame = document.createElement("iframe");
      this.frame.title = "YouTube test player";
      this.frame.allowFullscreen = config.playerVars.fs === 1;
      element.replaceWith(this.frame);
      this.frame.style.background = "#121724";
      window.__player = this;
      this.timer = setInterval(() => {
        if (this.state === 1 && this.getCurrentTime() >= 120) {
          this.position = 120;
          this.change(0);
        }
      }, 50);
      setTimeout(() => {
        if (config.playerVars.controls === 1) {
          const doc = this.frame.contentDocument;
          const button = (text, action) => {
            const element = doc.createElement("button");
            element.textContent = text;
            element.onclick = action;
            doc.body.append(element);
          };
          button("YouTube Play/Pause", () => {
            this.allowed = true;
            if (this.state === 1) this.pauseVideo();
            else this.playVideo();
          });
          button("YouTube Vollbild", () => this.frame.requestFullscreen());
          button("YouTube 1,5×", () => this.setPlaybackRate(1.5));
          const seek = doc.createElement("input");
          seek.setAttribute("aria-label", "YouTube Position");
          seek.type = "range";
          seek.max = "120";
          seek.value = "0";
          seek.oninput = () => this.seekTo(Number(seek.value));
          doc.body.append(seek);
          const volume = doc.createElement("input");
          volume.setAttribute("aria-label", "YouTube Lautstaerke");
          volume.type = "range";
          volume.value = "75";
          volume.oninput = () => this.setVolume(Number(volume.value));
          doc.body.append(volume);
        }
        config.events.onReady({ target: this });
      }, 10);
    }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    change(state) {
      this.state = state;
      this.config.events.onStateChange({ data: state, target: this });
    }
    loadVideoById(video) { this.load(video); this.playVideo(); }
    cueVideoById(video) { this.load(video); this.change(5); }
    load(video) {
      if (this.state !== -1) this.change(-1);
      this.videoId = video.videoId;
      this.rate = 1;
      this.position = video.startSeconds;
      this.at = Date.now();
      this.bad = video.videoId === "yyyyyyyyyyy" || video.videoId === "xxxxxxxxxxx";
      if (this.bad) {
        const code = video.videoId === "xxxxxxxxxxx" ? 150 : 100;
        setTimeout(() => this.config.events.onError({ data: code, target: this }), 10);
      }
      if (video.videoId === "zzzzzzzzzzz" && !window.__transientFailed) {
        window.__transientFailed = true;
        setTimeout(() => this.config.events.onError({ data: 5, target: this }), 10);
      }
    }
    playVideo() {
      if (this.bad) return;
      if (!this.allowed && !window.__strictAutoplay && navigator.userActivation.isActive &&
          ["Wiedergabe in diesem Browser freigeben", "Ton einschalten"].includes(document.activeElement?.textContent)) this.allowed = true;
      if (!this.allowed && !this.muted) { this.listeners.onAutoplayBlocked?.(); return; }
      if (window.__slowLoad && !this.loaded) {
        // Simulate a slow network: the player stays unstarted until the video data arrives.
        this.pendingLoad ??= setTimeout(() => { this.loaded = true; this.position = this.getCurrentTime(); this.playVideo(); }, window.__slowLoad);
        return;
      }
      if (this.state !== 1) { this.at = Date.now(); this.change(1); }
    }
    mute() { this.muted = true; }
    unMute() {
      this.muted = false;
      if (!this.allowed && this.state === 1) setTimeout(() => this.pauseVideo(), 20);
    }
    isMuted() { return Boolean(this.muted); }
    pauseVideo() { this.position = this.getCurrentTime(); this.change(2); }
    stopVideo() { this.position = 0; this.change(-1); }
    seekTo(seconds) { this.position = seconds; this.at = Date.now(); }
    getCurrentTime() { return this.position + (this.state === 1 ? (Date.now() - this.at) / 1000 * this.rate : 0); }
    getPlaybackRate() { return this.rate; }
    getAvailablePlaybackRates() { return [0.5, 1, 1.5, 2]; }
    setPlaybackRate(rate) {
      if (rate === this.rate) return;
      this.position = this.getCurrentTime();
      this.at = Date.now();
      this.rate = rate;
      this.config.events.onPlaybackRateChange?.({ data: rate, target: this });
    }
    getPlayerState() { return this.state; }
    getVideoData() { return { video_id: this.videoId, title: this.videoId ? `Titel ${this.videoId}` : "" }; }
    getDuration() { return 120; }
    setVolume(volume) { this.volume = volume; }
    drift(seconds) {
      let steps = 0;
      this.driftTimer = setInterval(() => {
        this.position += seconds / 10;
        if (++steps === 10) clearInterval(this.driftTimer);
      }, 50);
    }
    destroy() { clearInterval(this.timer); clearInterval(this.driftTimer); this.frame.remove(); }
  }
  window.YT = { Player, PlayerState: states };
  window.onYouTubeIframeAPIReady();
})();
