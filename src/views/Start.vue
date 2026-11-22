<script>
import { requestJson } from "../api.js";

export default {
  name: "Start",
  data() {
    return {
      emotions: [],
      emotionId: "",
      query: "",
      tracks: [],
      videoId: "",
      djId: "",
      djs: [],
      favoriteDjIds: [],
      problem: "",
      missing: [],
      finding: false,
      busy: false,
    };
  },
  computed: {
    visibleDjs() {
      return this.djs.filter((dj) => this.favoriteDjIds.includes(dj.id));
    },
    chosen() {
      return this.tracks.find((track) => track.videoId === this.videoId) || null;
    },
  },
  mounted() {
    this.load();
  },
  methods: {
    async load() {
      const [djs, settings, emotions] = await Promise.all([
        requestJson("/api/djs"),
        requestJson("/api/settings"),
        requestJson("/api/catalog/emotions"),
      ]);
      if (!djs.ok) {
        this.problem = djs.body && djs.body.error ? djs.body.error : "The DJ list did not load.";
        this.missing = djs.body && djs.body.missing ? djs.body.missing : [];
        return;
      }
      if (!settings.ok) {
        this.problem = settings.body && settings.body.error ? settings.body.error : "Settings did not load.";
        this.missing = settings.body && settings.body.missing ? settings.body.missing : [];
        return;
      }
      this.djs = djs.body.djs;
      this.favoriteDjIds = settings.body.favoriteDjIds;
      if (!emotions.ok) {
        this.problem = emotions.body && emotions.body.error ? emotions.body.error : "The mood list did not load.";
        this.missing = emotions.body && emotions.body.missing ? emotions.body.missing : [];
      } else {
        this.emotions = emotions.body.emotions;
      }
      const visible = this.djs.filter((dj) => this.favoriteDjIds.includes(dj.id));
      if (visible.length > 0) this.djId = visible[0].id;
      if (this.djs.length === 0) this.problem = "No DJs are seeded in D1. Apply the migration with npm run setup.";
    },
    async pickMood(emotion) {
      this.emotionId = emotion.id;
      this.query = "";
      await this.findSongs();
    },
    async findFromWords() {
      this.emotionId = "";
      await this.findSongs();
    },
    async findSongs() {
      this.problem = "";
      this.missing = [];
      this.finding = true;
      const body = this.emotionId ? { emotion: this.emotionId } : { query: this.query };
      const result = await requestJson("/api/catalog/openers", {
        method: "POST",
        body: JSON.stringify(body),
      });
      this.finding = false;
      if (!result.ok) {
        this.tracks = [];
        this.videoId = "";
        this.problem = result.body && result.body.error ? result.body.error : "No song turned up.";
        this.missing = result.body && result.body.missing ? result.body.missing : [];
        return;
      }
      this.tracks = result.body.tracks;
      this.videoId = this.tracks.length > 0 ? this.tracks[0].videoId : "";
    },
    async start() {
      this.problem = "";
      this.missing = [];
      this.busy = true;
      const result = await requestJson("/api/stations", {
        method: "POST",
        body: JSON.stringify({ videoId: this.videoId, djId: this.djId }),
      });
      this.busy = false;
      if (!result.ok) {
        this.problem = result.body && result.body.error ? result.body.error : "The station did not start.";
        this.missing = result.body && result.body.missing ? result.body.missing : [];
        return;
      }
      await this.$router.push(`/station/${result.body.stationId}`);
    },
  },
};
</script>

<template>
  <section class="panel start">
    <div>
      <p class="kicker">Tonight</p>
      <h1>What are we playing?</h1>
      <p class="lede">
        Pick a mood, or look up one song. The station starts on the track you choose. What comes next follows that song — the same artist, then a related mood — instead of more hits for the same search.
      </p>
      <p class="kicker">Mood</p>
      <div class="cloud" role="list">
        <button
          v-for="emotion in emotions"
          :key="emotion.id"
          type="button"
          class="mood"
          :class="{ on: emotionId === emotion.id }"
          :disabled="finding"
          @click="pickMood(emotion)"
        >
          {{ emotion.label }}
        </button>
      </div>
      <form @submit.prevent="findFromWords">
        <label for="query">Or find a song</label>
        <input id="query" v-model="query" maxlength="120" autocomplete="off" placeholder="an artist or a title" />
        <button type="submit" :disabled="finding || query.trim().length < 2">{{ finding ? "Looking…" : "Find songs" }}</button>
      </form>
      <fieldset v-if="tracks.length > 0">
        <legend>First track</legend>
        <label v-for="track in tracks" :key="track.videoId" class="opener">
          <input v-model="videoId" type="radio" name="opener" :value="track.videoId" />
          <span>
            <strong>{{ track.title }}</strong>
            <small>{{ track.artist }}</small>
          </span>
        </label>
      </fieldset>
      <form @submit.prevent="start">
        <fieldset>
          <legend>DJ</legend>
          <label v-for="dj in visibleDjs" :key="dj.id" class="dj">
            <input v-model="djId" type="radio" name="dj" :value="dj.id" />
            <span>
              <strong>{{ dj.name }}</strong>
              <small>{{ dj.blurb }}</small>
            </span>
          </label>
          <p v-if="visibleDjs.length === 0" class="problem">None of your favorite DJs are on the start screen. Turn one on in settings.</p>
        </fieldset>
        <button type="submit" :disabled="busy || finding || !chosen || visibleDjs.length === 0">
          {{ busy ? "Opening the station…" : chosen ? `Start with ${chosen.title}` : "Choose a song first" }}
        </button>
      </form>
      <p v-if="problem" class="problem">{{ problem }}</p>
      <p v-if="missing.length" class="problem">Unset: <code v-for="name in missing" :key="name">{{ name }}</code></p>
    </div>
  </section>
</template>
