<script>
import OnAir from "../components/OnAir.vue";

export default {
  name: "Listen",
  components: { OnAir },
  computed: {
    id() {
      return String(this.$route.params.id ?? "");
    },
  },
};
</script>

<template>
  <section class="page">
    <p class="kicker listen-kicker">Listen only</p>
    <OnAir
      :key="id"
      :snapshot-path="'/api/listen/' + id"
      :socket-path="'/api/listen/' + id + '/socket'"
      :listen-only="true"
    />
  </section>
</template>
