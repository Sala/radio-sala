<script>
import OnAir from "../components/OnAir.vue";

export default {
  name: "Station",
  components: { OnAir },
  data() {
    return { copied: false };
  },
  computed: {
    id() {
      return String(this.$route.params.id ?? "");
    },
    listenHref() {
      return `${window.location.origin}/listen/${this.id}`;
    },
  },
  methods: {
    async copyShare() {
      try {
        await navigator.clipboard.writeText(this.listenHref);
        this.copied = true;
      } catch {
        const field = this.$refs.share;
        field.focus();
        field.select();
        this.copied = document.execCommand("copy");
      }
    },
  },
};
</script>

<template>
  <section class="page">
    <OnAir
      :key="id"
      :snapshot-path="'/api/stations/' + id"
      :socket-path="'/api/stations/' + id + '/socket'"
      :listen-only="false"
    />
    <div class="share panel">
      <label for="share">Share link</label>
      <div class="share-row">
        <input id="share" ref="share" :value="listenHref" readonly />
        <button type="button" @click="copyShare">{{ copied ? "Copied" : "Copy" }}</button>
      </div>
      <p>Anyone with this link hears the same item at the same position.</p>
    </div>
  </section>
</template>
