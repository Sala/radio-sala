import { createRouter, createWebHistory } from "vue-router";
import Start from "./views/Start.vue";
import Settings from "./views/Settings.vue";
import Station from "./views/Station.vue";
import Listen from "./views/Listen.vue";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", component: Start },
    { path: "/settings", component: Settings },
    { path: "/station/:id", component: Station },
    { path: "/listen/:id", component: Listen, meta: { public: true } },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});
