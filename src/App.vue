<script>
import { requestJson } from "./api.js";
import BindingNotice from "./components/BindingNotice.vue";
import Gate from "./views/Gate.vue";

export default {
  name: "App",
  components: { BindingNotice, Gate },
  data() {
    return {
      me: null,
      status: null,
      loading: true,
      banner: "",
    };
  },
  computed: {
    publicRoute() {
      return this.$route.meta.public === true;
    },
    showGate() {
      return !this.loading && !this.me && !this.publicRoute;
    },
  },
  watch: {
    "$route.fullPath"() {
      this.readBanner();
    },
  },
  mounted() {
    this.readBanner();
    this.loadSession();
  },
  methods: {
    readBanner() {
      const error = this.$route.query.error;
      if (error === "not-allowed") {
        this.banner = "That Google account is not on the Radio Sala list.";
        return;
      }
      if (error === "auth") {
        this.banner = "Google sign-in did not finish. Try again once the Google bindings are set.";
        return;
      }
      if (error === "missing-bindings") {
        this.banner = "Google sign-in is waiting on bindings. The list is below.";
        return;
      }
      this.banner = "";
    },
    async loadSession() {
      this.loading = true;
      const status = await requestJson("/api/status");
      this.status = status.body;
      const me = await requestJson("/api/me");
      this.me = me.ok ? me.body : null;
      this.loading = false;
    },
    async signOut() {
      await requestJson("/api/auth/logout", { method: "POST" });
      this.me = null;
      if (!this.publicRoute) await this.$router.push("/");
    },
  },
};
</script>

<template>
  <div class="night">
    <header class="mast">
      <RouterLink class="mark" to="/">Radio Sala</RouterLink>
      <p class="mast-line">A private station. The picture stays on.</p>
      <nav v-if="me">
        <RouterLink to="/settings">Settings</RouterLink>
        <button type="button" @click="signOut">Sign out</button>
      </nav>
    </header>
    <p v-if="banner" class="banner">{{ banner }}</p>
    <BindingNotice v-if="status" :status="status" />
    <p v-if="loading" class="tuning">Tuning…</p>
    <Gate v-else-if="showGate" :status="status" />
    <RouterView v-else />
  </div>
</template>
