<script>
export default {
  name: "BindingNotice",
  props: {
    status: { type: Object, required: true },
  },
  computed: {
    missing() {
      return Array.isArray(this.status.missing) ? this.status.missing : [];
    },
  },
};
</script>

<template>
  <aside v-if="missing.length || status.schemaReady === false || status.aiBinding === false" class="notice">
    <p v-if="missing.length">These bindings are unset: <code v-for="name in missing" :key="name">{{ name }}</code></p>
    <p v-if="missing.length">
      Put the values in <code>.dev.vars</code> and restart <code>wrangler dev</code>. The names are
      GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SESSION_SECRET, and YOUTUBE_API_KEY.
    </p>
    <p v-if="status.aiBinding === false">
      The <code>AI</code> binding is unset. Workers AI has no local simulator, so it is commented out of <code>wrangler.jsonc</code> and the dev server can start. The speech call is still wired. After <code>wrangler login</code>, uncomment the <code>ai</code> binding to turn speech on. Until then a DJ break stays text.
    </p>
    <p v-if="status.schemaReady === false">The D1 schema is not applied. From the project folder, run <code>npm run setup</code>.</p>
  </aside>
</template>
