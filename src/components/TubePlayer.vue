<script>
let youtubeApi = null;

function loadYouTubeApi() {
  if (window.YT && window.YT.Player) return Promise.resolve();
  if (youtubeApi) return youtubeApi;
  youtubeApi = new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof previous === "function") previous();
      resolve();
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.onerror = () => reject(new Error("The YouTube IFrame API did not load."));
    document.head.appendChild(script);
  });
  return youtubeApi;
}

export default {
  name: "TubePlayer",
  props: {
    videoId: { type: String, default: "" },
    token: { type: String, default: "" },
    playing: { type: Boolean, default: false },
    positionSeconds: { type: Number, default: 0 },
    anchorMs: { type: Number, default: 0 },
    listenOnly: { type: Boolean, default: false },
    frozen: { type: Boolean, default: false },
  },
  emits: ["transport", "ended", "player-error"],
  data() {
    return {
      elementId: `tube-${crypto.randomUUID()}`,
      player: null,
      ready: false,
      problem: "",
      appliedToken: "",
      timer: 0,
      ticks: 0,
      reportedId: "",
    };
  },
  mounted() {
    this.boot();
  },
  beforeUnmount() {
    if (this.timer) window.clearInterval(this.timer);
    if (this.player && this.player.destroy) this.player.destroy();
  },
  watch: {
    token() {
      this.apply();
    },
    videoId() {
      this.apply();
    },
    playing() {
      this.apply();
    },
    frozen() {
      this.apply();
    },
    anchorMs() {
      this.apply();
    },
  },
  methods: {
    async boot() {
      try {
        await loadYouTubeApi();
        const holder = document.getElementById(this.elementId);
        const frame = document.createElement("iframe");
        const origin = window.location.origin;
        const params = new URLSearchParams({
          enablejsapi: "1",
          origin,
          rel: "0",
          modestbranding: "1",
          playsinline: "1",
          autoplay: "0",
          controls: "1",
        });
        frame.referrerPolicy = "strict-origin-when-cross-origin";
        frame.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
        frame.setAttribute("allowfullscreen", "");
        frame.title = "YouTube video player";
        frame.src = this.videoId
          ? `https://www.youtube.com/embed/${this.videoId}?${params}`
          : `https://www.youtube.com/embed?${params}`;
        if (holder) holder.replaceChildren(frame);
        this.player = new window.YT.Player(frame, {
          host: "https://www.youtube.com",
          events: {
            onReady: (event) => {
              const iframe = event.target.getIframe ? event.target.getIframe() : frame;
              iframe.referrerPolicy = "strict-origin-when-cross-origin";
              this.ready = true;
              this.apply();
              this.timer = window.setInterval(() => this.follow(), 1000);
            },
            onStateChange: (event) => this.onStateChange(event),
            onError: (event) => {
              if (!this.videoId || this.reportedId === this.videoId) return;
              this.reportedId = this.videoId;
              this.$emit("player-error", event.data);
            },
          },
        });
      } catch (error) {
        this.problem = error instanceof Error ? error.message : "The YouTube player did not start.";
      }
    },
    desiredSeconds() {
      if (this.frozen) return 0;
      const running = this.playing && this.anchorMs > 0 ? Math.max(0, (Date.now() - this.anchorMs) / 1000) : 0;
      return Math.max(0, this.positionSeconds + running);
    },
    apply() {
      if (!this.player || !this.ready || !this.player.loadVideoById) return;
      const data = this.player.getVideoData ? this.player.getVideoData() : null;
      const currentId = data && data.video_id ? data.video_id : "";
      if (this.videoId && (currentId !== this.videoId || this.appliedToken !== this.token)) {
        const startSeconds = this.desiredSeconds();
        if (this.playing && !this.frozen) this.player.loadVideoById({ videoId: this.videoId, startSeconds });
        else this.player.cueVideoById({ videoId: this.videoId, startSeconds });
        this.appliedToken = this.token;
        return;
      }
      if (!this.videoId || !this.player.getPlayerState) return;
      const state = this.player.getPlayerState();
      if ((this.frozen || !this.playing) && state === window.YT.PlayerState.PLAYING) this.player.pauseVideo();
    },
    onStateChange(event) {
      if (this.listenOnly || this.frozen || !this.player || !this.player.getVideoData) return;
      const data = this.player.getVideoData();
      const videoId = data && data.video_id;
      if (!videoId || videoId !== this.videoId) return;
      if (event.data === window.YT.PlayerState.ENDED) this.$emit("ended", { videoId });
      if (event.data === window.YT.PlayerState.PLAYING || event.data === window.YT.PlayerState.PAUSED) {
        this.$emit("transport", {
          status: event.data === window.YT.PlayerState.PLAYING ? "playing" : "paused",
          positionSeconds: this.player.getCurrentTime(),
          videoId,
        });
      }
    },
    follow() {
      if (!this.player || !this.ready || !this.videoId || this.frozen) return;
      if (this.listenOnly) {
        const data = this.player.getVideoData ? this.player.getVideoData() : null;
        const currentId = data && data.video_id ? data.video_id : "";
        const desired = this.desiredSeconds();
        if (currentId !== this.videoId) {
          const startSeconds = desired;
          if (this.playing) this.player.loadVideoById({ videoId: this.videoId, startSeconds });
          else this.player.cueVideoById({ videoId: this.videoId, startSeconds });
          this.appliedToken = this.token;
          return;
        }
        const state = this.player.getPlayerState();
        const current = this.player.getCurrentTime();
        if (this.playing && state !== window.YT.PlayerState.PLAYING && state !== window.YT.PlayerState.BUFFERING) {
          this.player.playVideo();
        }
        if (!this.playing && state === window.YT.PlayerState.PLAYING) this.player.pauseVideo();
        if (Number.isFinite(current) && Math.abs(current - desired) > 2.5) this.player.seekTo(desired, true);
        return;
      }
      this.ticks += 1;
      if (this.ticks % 2 !== 0 || !this.player.getVideoData) return;
      const data = this.player.getVideoData();
      const videoId = data && data.video_id;
      if (!videoId || videoId !== this.videoId) return;
      const state = this.player.getPlayerState();
      if (state === window.YT.PlayerState.ENDED) this.$emit("ended", { videoId });
      if (state === window.YT.PlayerState.PLAYING || state === window.YT.PlayerState.PAUSED) {
        this.$emit("transport", {
          status: state === window.YT.PlayerState.PLAYING ? "playing" : "paused",
          positionSeconds: this.player.getCurrentTime(),
          videoId,
        });
      }
    },
  },
};
</script>

<template>
  <div class="bezel">
    <div class="tube-frame">
      <div :id="elementId"></div>
    </div>
    <p v-if="problem" class="problem">{{ problem }}</p>
    <p v-else-if="!videoId" class="empty-player">The player appears when the station has a song.</p>
  </div>
</template>
