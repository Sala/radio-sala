<script>
import { requestJson } from "../api.js";

const EMPTY = {
  favoriteDjIds: [],
  breakEveryNSongs: 2,
  breakLength: "medium",
  breakMaxSeconds: 40,
  topicToday: true,
  topicNextSong: true,
  topicWeather: false,
  weatherCity: "",
  topicEvents: false,
  eventsScope: "world",
};

export default {
  name: "Settings",
  data() {
    return {
      djs: [],
      form: { ...EMPTY, favoriteDjIds: [] },
      problem: "",
      saved: "",
      speechNote: "",
      busy: false,
    };
  },
  mounted() {
    this.load();
  },
  methods: {
    async load() {
      const [djs, settings, status] = await Promise.all([
        requestJson("/api/djs"),
        requestJson("/api/settings"),
        requestJson("/api/status"),
      ]);
      if (!djs.ok || !settings.ok) {
        const failed = !djs.ok ? djs : settings;
        this.problem = failed.body && failed.body.error ? failed.body.error : "Settings did not load.";
        return;
      }
      this.djs = djs.body.djs;
      this.form = {
        favoriteDjIds: settings.body.favoriteDjIds.slice(),
        breakEveryNSongs: settings.body.breakEveryNSongs,
        breakLength: settings.body.breakLength,
        breakMaxSeconds: settings.body.breakMaxSeconds,
        topicToday: settings.body.topicToday,
        topicNextSong: settings.body.topicNextSong,
        topicWeather: settings.body.topicWeather,
        weatherCity: settings.body.weatherCity,
        topicEvents: settings.body.topicEvents,
        eventsScope: settings.body.eventsScope,
      };
      this.speechNote = status.body && status.body.speechNote ? status.body.speechNote : "";
    },
    toggleDj(id, checked) {
      const next = this.form.favoriteDjIds.filter((djId) => djId !== id);
      if (checked) next.push(id);
      this.form.favoriteDjIds = next;
    },
    async save() {
      this.problem = "";
      this.saved = "";
      this.busy = true;
      const result = await requestJson("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          ...this.form,
          breakEveryNSongs: Number(this.form.breakEveryNSongs),
          breakMaxSeconds: Number(this.form.breakMaxSeconds),
        }),
      });
      this.busy = false;
      if (!result.ok) {
        this.problem = result.body && result.body.error ? result.body.error : "Settings were not saved.";
        return;
      }
      this.saved = "Saved. This applies to the next station you start.";
    },
  },
};
</script>

<template>
  <section class="panel settings">
    <p class="kicker">Booth</p>
    <h1>Settings</h1>
    <p class="lede">Favorites decide who shows up on the start screen. Breaks use the cadence and topics from the moment a station starts.</p>
    <form @submit.prevent="save">
      <fieldset>
        <legend>DJs on the start screen</legend>
        <label v-for="dj in djs" :key="dj.id" class="check">
          <input
            type="checkbox"
            :checked="form.favoriteDjIds.includes(dj.id)"
            @change="toggleDj(dj.id, $event.target.checked)"
          />
          <span><strong>{{ dj.name }}</strong> <small>{{ dj.blurb }}</small></span>
        </label>
      </fieldset>
      <label for="cadence">Break every N songs</label>
      <input id="cadence" v-model.number="form.breakEveryNSongs" type="number" min="1" max="12" />
      <label for="length">Break length</label>
      <select id="length" v-model="form.breakLength">
        <option value="short">Short</option>
        <option value="medium">Medium</option>
        <option value="long">Long</option>
        <option value="random">Random</option>
      </select>
      <label for="max">Max break, seconds</label>
      <input id="max" v-model.number="form.breakMaxSeconds" type="number" min="8" max="180" />
      <p class="hint">Short, medium, long, and random all stop at this max.</p>
      <fieldset>
        <legend>Topics</legend>
        <label class="check"><input v-model="form.topicToday" type="checkbox" /> <span>Trivia about today, from Wikipedia</span></label>
        <label class="check"><input v-model="form.topicNextSong" type="checkbox" /> <span>Trivia about the next song or artist, from the real title and artist</span></label>
        <label class="check"><input v-model="form.topicWeather" type="checkbox" /> <span>Weather for a city, from Open-Meteo</span></label>
        <label for="city">City</label>
        <input id="city" v-model="form.weatherCity" maxlength="80" autocomplete="address-level2" />
        <label class="check"><input v-model="form.topicEvents" type="checkbox" /> <span>Recent events, from GDELT headlines</span></label>
        <label for="scope">Events scope</label>
        <select id="scope" v-model="form.eventsScope">
          <option value="world">World</option>
          <option value="romania">Romania</option>
          <option value="music">Music</option>
        </select>
      </fieldset>
      <button type="submit" :disabled="busy">{{ busy ? "Saving…" : "Save settings" }}</button>
    </form>
    <p v-if="saved" class="saved">{{ saved }}</p>
    <p v-if="problem" class="problem">{{ problem }}</p>
    <p v-if="speechNote" class="dev-note">{{ speechNote }}</p>
  </section>
</template>
