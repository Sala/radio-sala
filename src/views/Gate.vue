<script>
export default {
  name: "Gate",
  props: {
    status: { type: Object, default: null },
  },
  computed: {
    googleReady() {
      const missing = this.status && Array.isArray(this.status.missing) ? this.status.missing : [];
      return !missing.some((name) => name === "GOOGLE_CLIENT_ID" || name === "GOOGLE_CLIENT_SECRET" || name === "SESSION_SECRET");
    },
    schemaReady() {
      return !this.status || this.status.schemaReady !== false;
    },
  },
};
</script>

<template>
  <section class="panel gate">
    <p class="kicker">Members</p>
    <h1>Sign in to open the station.</h1>
    <p class="lede">
      Google login is required to start a station, change settings, or pick a DJ. A share link is the exception: anyone with it can listen, and they cannot choose the songs.
    </p>
    <a v-if="googleReady && schemaReady" class="button" href="/api/auth/google">Sign in with Google</a>
    <p v-else class="problem">The sign-in button stays off until the Google bindings and the D1 schema are in place.</p>
  </section>
</template>
