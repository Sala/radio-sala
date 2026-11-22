<script>
import { requestJson } from "../api.js";
import TubePlayer from "./TubePlayer.vue";

export default {
  name: "OnAir",
  components: { TubePlayer },
  props: {
    snapshotPath: { type: String, required: true },
    socketPath: { type: String, required: true },
    listenOnly: { type: Boolean, default: false },
  },
  data() {
    return {
      clock: null,
      problem: "",
      socket: null,
      timer: 0,
      retry: 0,
      gone: false,
      stopRetry: false,
      lastSongId: "",
      shownSeconds: 0,
      beat: 0,
      audioBlocked: false,
      refusedId: "",
    };
  },
  computed: {
    videoId() {
      if (!this.clock) return "";
      if (this.clock.item.kind === "song") return this.clock.item.videoId;
      if (this.clock.queue.length > 0) return this.clock.queue[0].videoId;
      return this.lastSongId;
    },
    token() {
      if (!this.clock) return "";
      const id = this.clock.item.kind === "song" ? this.clock.item.videoId : "break";
      return `${id}:${this.clock.anchorMs}`;
    },
    videoPlaying() {
      return Boolean(this.clock && this.clock.item.kind === "song" && this.clock.status === "playing");
    },
    frozen() {
      return Boolean(this.clock && this.clock.item.kind === "break");
    },
    headline() {
      if (!this.clock) return "";
      if (this.clock.item.kind === "break") return this.clock.djName;
      return this.clock.item.title;
    },
    subline() {
      if (!this.clock) return "";
      if (this.clock.item.kind === "break") return "DJ break";
      return this.clock.item.artist;
    },
    playedSongs() {
      if (!this.clock || !Array.isArray(this.clock.played)) return [];
      return this.clock.played;
    },
  },
  watch: {
    clock() {
      this.$nextTick(() => this.syncBreakAudio(false));
    },
  },
  mounted() {
    this.open();
    this.timer = window.setInterval(() => this.tick(), 1000);
  },
  beforeUnmount() {
    this.gone = true;
    if (this.timer) window.clearInterval(this.timer);
    if (this.retry) window.clearTimeout(this.retry);
    if (this.socket) this.socket.close();
  },
  methods: {
    async open() {
      const snapshot = await requestJson(this.snapshotPath);
      if (!snapshot.ok) {
        this.problem = snapshot.body && snapshot.body.error ? snapshot.body.error : "The station did not answer.";
        return;
      }
      this.takeClock(snapshot.body.clock);
      this.connect();
    },
    takeClock(clock) {
      if (!clock) return;
      if (clock.item && clock.item.kind === "song") this.lastSongId = clock.item.videoId;
      this.clock = clock;
      this.shownSeconds = this.extrapolated();
    },
    connect() {
      if (this.gone || this.stopRetry) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${window.location.host}${this.socketPath}`);
      this.socket = socket;
      socket.onmessage = (event) => {
        let body = null;
        try {
          body = JSON.parse(event.data);
        } catch {
          return;
        }
        if (body.type === "rejected") {
          this.problem = body.error || "This link is listen-only.";
          this.stopRetry = true;
          socket.close();
          return;
        }
        if (body.type === "state") this.takeClock(body.clock);
      };
      socket.onclose = () => {
        if (this.gone || this.stopRetry || this.socket !== socket) return;
        this.retry = window.setTimeout(() => this.connect(), 1500);
      };
    },
    extrapolated() {
      if (!this.clock) return 0;
      const running = this.clock.status === "playing"
        ? Math.max(0, (Date.now() - this.clock.anchorMs) / 1000)
        : 0;
      return Math.min(this.clock.item.durationSeconds, this.clock.positionSeconds + running);
    },
    send(payload) {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
      this.socket.send(JSON.stringify(payload));
    },
    onTransport(payload) {
      if (this.listenOnly || !this.clock || this.clock.item.kind !== "song") return;
      this.send({ type: "transport", ...payload });
    },
    onEnded(payload) {
      if (this.listenOnly || !this.clock || this.clock.item.kind !== "song") return;
      this.send({ type: "ended", videoId: payload.videoId });
    },
    skip() {
      if (this.listenOnly) return;
      this.send({ type: "skip" });
    },
    onPlayerError(code) {
      if (!this.clock || this.clock.item.kind !== "song") return;
      const videoId = this.clock.item.videoId;
      if (code !== 100 && code !== 101 && code !== 150) {
        this.problem = `YouTube could not play that video (error ${code}).`;
        return;
      }
      if (this.refusedId === videoId) return;
      this.refusedId = videoId;
      this.problem = "";
      this.send({ type: "reject", videoId });
    },
    toggleBreak() {
      if (!this.clock || this.clock.item.kind !== "break") return;
      const audio = this.$refs.breakAudio;
      const status = this.clock.status === "playing" ? "paused" : "playing";
      const positionSeconds = audio && Number.isFinite(audio.currentTime) ? audio.currentTime : this.extrapolated();
      if (audio && this.clock.item.audioPath) {
        if (status === "playing") audio.play().catch(() => { this.audioBlocked = true; });
        else audio.pause();
      }
      this.send({ type: "transport", status, positionSeconds });
    },
    syncBreakAudio(chase) {
      const audio = this.$refs.breakAudio;
      if (!audio || !this.clock) return;
      const item = this.clock.item;
      if (item.kind !== "break" || !item.audioPath) {
        audio.pause();
        return;
      }
      const nextSrc = new URL(item.audioPath, window.location.origin).toString();
      const srcChanged = audio.src !== nextSrc;
      if (srcChanged) {
        audio.src = nextSrc;
        audio.addEventListener("loadedmetadata", () => {
          if (this.clock && this.clock.item.kind === "break") audio.currentTime = this.extrapolated();
        }, { once: true });
      }
      const target = this.extrapolated();
      if (!srcChanged && audio.readyState >= 1 && Math.abs(audio.currentTime - target) > 2.5 && (chase || this.listenOnly)) {
        audio.currentTime = target;
      }
      if (this.clock.status === "playing") {
        const pending = audio.play();
        if (pending && pending.catch) pending.catch(() => { this.audioBlocked = true; });
      } else {
        audio.pause();
      }
    },
    tick() {
      if (!this.clock) return;
      this.shownSeconds = this.extrapolated();
      if (this.clock.item.kind !== "break" || this.listenOnly) {
        if (this.clock.item.kind === "break" && this.listenOnly) this.syncBreakAudio(true);
        return;
      }
      this.beat += 1;
      if (this.beat % 2 !== 0) return;
      const audio = this.$refs.breakAudio;
      if (!audio || !this.clock.item.audioPath || audio.readyState < 1) return;
      const audioPaused = audio.paused;
      const clockPaused = this.clock.status !== "playing";
      if (audioPaused !== clockPaused) return;
      this.send({ type: "transport", status: this.clock.status, positionSeconds: audio.currentTime });
    },
  },
};
</script>

<template>
  <section v-if="clock" class="stage">
    <div class="now">
      <p class="kicker">{{ clock.item.kind === "break" ? "DJ break" : "On air" }}</p>
      <h1>{{ headline }}</h1>
      <p class="by">{{ subline }}</p>
      <button v-if="!listenOnly" type="button" class="next" @click="skip">Next</button>
    </div>
    <TubePlayer
      v-if="clock.item.kind === 'song'"
      :key="clock.item.videoId"
      :video-id="videoId"
      :token="token"
      :playing="videoPlaying"
      :position-seconds="clock.positionSeconds"
      :anchor-ms="clock.anchorMs"
      :listen-only="listenOnly"
      :frozen="frozen"
      @transport="onTransport"
      @ended="onEnded"
      @player-error="onPlayerError"
    />
    <div v-else class="break-card">
      <p class="script">{{ clock.item.script }}</p>
      <p v-if="!clock.item.audioPath && clock.item.speechNote" class="dev-note">{{ clock.item.speechNote }}</p>
      <p v-if="audioBlocked && clock.item.audioPath" class="problem">The browser is holding the DJ clip. Press play on this page.</p>
    </div>
    <audio ref="breakAudio" preload="auto"></audio>
    <section class="played">
      <h2>Already played</h2>
      <ol v-if="playedSongs.length">
        <li v-for="(track, index) in playedSongs" :key="track.videoId + '-' + index">{{ track.artist }} — {{ track.title }}</li>
      </ol>
      <p v-else class="by">Songs show up here after they finish, oldest first.</p>
    </section>
    <p v-if="clock.error" class="problem">{{ clock.error }}</p>
    <p v-if="problem" class="problem">{{ problem }}</p>
  </section>
  <p v-else-if="problem" class="problem panel">{{ problem }}</p>
  <p v-else class="tuning">Tuning the station…</p>
</template>
