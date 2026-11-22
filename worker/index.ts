import { deleteCookie } from "hono/cookie";
import { Hono, type Context } from "hono";
import { bindingMessage, missingBindings } from "./bindings";
import { beginGoogleLogin, finishGoogleLogin, readSessionUser } from "./session";
import { settingsFromBody, settingsFromRow, type SettingsRow } from "./settings";
import { SPEECH_DEV_NOTE, SPEECH_MODEL, workersAi } from "./speech";
import { EMOTIONS, findOpeners, loadTrack } from "./catalog";
import type { DjRecord, SessionUser } from "./types";

type AppContext = Context<{ Bindings: Env }>;

const app = new Hono<{ Bindings: Env }>();

function cookieFlags(requestUrl: string): { httpOnly: true; secure: boolean; sameSite: "Lax"; path: "/" } {
  return {
    httpOnly: true,
    secure: new URL(requestUrl).protocol === "https:",
    sameSite: "Lax",
    path: "/",
  };
}

async function schemaReady(env: Env): Promise<boolean> {
  try {
    await env.DB.prepare("SELECT email FROM allowed_emails LIMIT 1").first();
    return true;
  } catch (error) {
    console.error(JSON.stringify({
      message: "d1 schema missing",
      error: error instanceof Error ? error.message : String(error),
    }));
    return false;
  }
}

async function listDjs(env: Env): Promise<DjRecord[]> {
  const listed = await env.DB.prepare(
    `SELECT id, name, blurb, speaker FROM djs
     ORDER BY CASE id
       WHEN 'vinnie-vega' THEN 1
       WHEN 'rosa-marquez' THEN 2
       WHEN 'miles-crowe' THEN 3
       ELSE 4
     END`,
  ).all<DjRecord>();
  return listed.results;
}

async function requireUser(c: AppContext): Promise<SessionUser | Response> {
  if (!(await schemaReady(c.env))) {
    return c.json({ error: "D1 schema is not applied. Run npm run setup." }, 503);
  }
  const sessionMissing = missingBindings(c.env, ["SESSION_SECRET"]);
  if (sessionMissing.length > 0) {
    return c.json({ missing: sessionMissing, error: bindingMessage(sessionMissing) }, 503);
  }
  const user = await readSessionUser(c);
  if (!user) return c.json({ error: "Google sign-in is required." }, 401);
  return user;
}

function socketRequest(request: Request, role: "host" | "guest", userId: string): Request {
  const headers = new Headers(request.headers);
  headers.set("X-Radio-Role", role);
  if (role === "host") headers.set("X-Radio-User", userId);
  else headers.delete("X-Radio-User");
  return new Request(request, { headers });
}

app.onError((error, c) => {
  console.error(JSON.stringify({
    message: "request failed",
    path: new URL(c.req.url).pathname,
    error: error instanceof Error ? error.message : String(error),
  }));
  return c.json({ error: "Radio Sala hit an error and stopped this request." }, 500);
});

app.notFound((c) => c.json({ error: "No route for that." }, 404));

app.get("/api/status", async (c) => {
  const missing = missingBindings(c.env);
  return c.json({
    missing,
    aiBinding: workersAi(c.env) !== null,
    schemaReady: await schemaReady(c.env),
    speechModel: SPEECH_MODEL,
    speechNote: SPEECH_DEV_NOTE,
  });
});

app.get("/api/me", async (c) => {
  const user = await requireUser(c);
  if (user instanceof Response) return user;
  return c.json({ email: user.email, name: user.name });
});

app.post("/api/auth/logout", (c) => {
  deleteCookie(c, "sala_session", cookieFlags(c.req.url));
  return c.body(null, 204);
});

app.get("/api/auth/google", async (c) => {
  if (!(await schemaReady(c.env))) {
    return c.json({ error: "D1 schema is not applied. Run npm run setup." }, 503);
  }
  return beginGoogleLogin(c);
});

app.get("/api/auth/callback", (c) => finishGoogleLogin(c));

app.get("/api/djs", async (c) => {
  const user = await requireUser(c);
  if (user instanceof Response) return user;
  const djs = await listDjs(c.env);
  return c.json({
    djs: djs.map((dj) => ({ id: dj.id, name: dj.name, blurb: dj.blurb })),
  });
});

app.get("/api/settings", async (c) => {
  const user = await requireUser(c);
  if (user instanceof Response) return user;
  const djs = await listDjs(c.env);
  const row = await c.env.DB.prepare(
    `SELECT favorite_dj_ids, break_every_n_songs, break_length, break_max_seconds,
            topic_today, topic_next_song, topic_weather, weather_city, topic_events, events_scope
     FROM settings WHERE user_id = ?`,
  )
    .bind(user.id)
    .first<SettingsRow>();
  if (!row) return c.json({ error: "Settings were not created for this account." }, 404);
  const stored = settingsFromRow(row, djs.map((dj) => dj.id));
  if (!stored) return c.json({ error: "Stored settings could not be read." }, 500);
  return c.json({ favoriteDjIds: stored.favoriteDjIds, ...stored.break });
});

app.put("/api/settings", async (c) => {
  const user = await requireUser(c);
  if (user instanceof Response) return user;
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Settings need a JSON object." }, 400);
  }
  const djs = await listDjs(c.env);
  const parsed = settingsFromBody(body, djs.map((dj) => dj.id));
  if (typeof parsed === "string") return c.json({ error: parsed }, 400);
  await c.env.DB.prepare(
    `UPDATE settings SET
       favorite_dj_ids = ?,
       break_every_n_songs = ?,
       break_length = ?,
       break_max_seconds = ?,
       topic_today = ?,
       topic_next_song = ?,
       topic_weather = ?,
       weather_city = ?,
       topic_events = ?,
       events_scope = ?
     WHERE user_id = ?`,
  )
    .bind(
      JSON.stringify(parsed.favoriteDjIds),
      parsed.break.breakEveryNSongs,
      parsed.break.breakLength,
      parsed.break.breakMaxSeconds,
      parsed.break.topicToday ? 1 : 0,
      parsed.break.topicNextSong ? 1 : 0,
      parsed.break.topicWeather ? 1 : 0,
      parsed.break.weatherCity,
      parsed.break.topicEvents ? 1 : 0,
      parsed.break.eventsScope,
      user.id,
    )
    .run();
  return c.json({ favoriteDjIds: parsed.favoriteDjIds, ...parsed.break });
});

app.get("/api/catalog/emotions", async (c) => {
  const user = await requireUser(c);
  if (user instanceof Response) return user;
  return c.json({ emotions: EMOTIONS.map((emotion) => ({ id: emotion.id, label: emotion.label })) });
});

app.post("/api/catalog/openers", async (c) => {
  const user = await requireUser(c);
  if (user instanceof Response) return user;
  let body: { emotion?: unknown; query?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Choose a mood or type a song to find the first track." }, 400);
  }
  const emotion = typeof body.emotion === "string" ? EMOTIONS.find((item) => item.id === body.emotion) : undefined;
  const typed = typeof body.query === "string" ? body.query.trim().replace(/\s+/g, " ") : "";
  const query = emotion ? emotion.query : typed;
  const genre = emotion ? emotion.id : "song";
  if (query.length < 2 || query.length > 120) {
    return c.json({ error: "Type a song or a few words, up to 120 characters." }, 400);
  }
  const found = await findOpeners(c.env, query, genre);
  if (found.missing.length > 0) {
    return c.json({ missing: found.missing, error: found.error }, 503);
  }
  if (found.tracks.length === 0) {
    return c.json({ error: found.error ?? "No embeddable song turned up for that." }, 422);
  }
  return c.json({
    tracks: found.tracks.map((track) => ({
      videoId: track.videoId,
      artist: track.artist,
      title: track.title,
      energy: track.energy,
    })),
  });
});

app.post("/api/stations", async (c) => {
  const user = await requireUser(c);
  if (user instanceof Response) return user;
  let body: { videoId?: unknown; djId?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Choose a song and a DJ to start the station." }, 400);
  }
  const videoId = typeof body.videoId === "string" ? body.videoId.trim() : "";
  if (!/^[\w-]{6,20}$/.test(videoId)) {
    return c.json({ error: "Choose one song from the list." }, 400);
  }
  const track = await loadTrack(c.env, videoId);
  if (!track) return c.json({ error: "That song is not in the catalog. Find it again." }, 404);
  if (typeof body.djId !== "string") return c.json({ error: "Pick a DJ." }, 400);
  const djs = await listDjs(c.env);
  const dj = djs.find((entry) => entry.id === body.djId);
  if (!dj) return c.json({ error: "That DJ is not seeded in D1." }, 400);
  const row = await c.env.DB.prepare(
    `SELECT favorite_dj_ids, break_every_n_songs, break_length, break_max_seconds,
            topic_today, topic_next_song, topic_weather, weather_city, topic_events, events_scope
     FROM settings WHERE user_id = ?`,
  )
    .bind(user.id)
    .first<SettingsRow>();
  if (!row) return c.json({ error: "Settings were not created for this account." }, 404);
  const stored = settingsFromRow(row, djs.map((entry) => entry.id));
  if (!stored) return c.json({ error: "Stored settings could not be read." }, 500);
  if (!stored.favoriteDjIds.includes(dj.id)) {
    return c.json({ error: "That DJ is not on your start screen. Turn them on in settings." }, 400);
  }
  const stationId = crypto.randomUUID();
  const started = await c.env.STATION.getByName(stationId).start({
    stationId,
    hostUserId: user.id,
    djId: dj.id,
    djName: dj.name,
    speaker: dj.speaker,
    originQuery: track.foundBy,
    displaySeed: `${track.artist} — ${track.title}`,
    track,
    settings: stored.break,
  });
  if (!started.ok) {
    return c.json(
      { missing: started.missing, error: started.error },
      started.missing.length > 0 ? 503 : 422,
    );
  }
  await c.env.DB.prepare(
    "INSERT INTO stations (id, host_user_id, dj_id, seed, display_seed, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(stationId, user.id, dj.id, track.foundBy, `${track.artist} — ${track.title}`, new Date().toISOString())
    .run();
  return c.json({
    stationId,
    listenPath: `/listen/${stationId}`,
    clock: started.clock,
    serverNowMs: started.serverNowMs,
  });
});

app.get("/api/stations/:id", async (c) => {
  const user = await requireUser(c);
  if (user instanceof Response) return user;
  const id = c.req.param("id");
  const station = await c.env.DB.prepare("SELECT host_user_id FROM stations WHERE id = ?")
    .bind(id)
    .first<{ host_user_id: string }>();
  if (!station) return c.json({ error: "No station with that id." }, 404);
  if (station.host_user_id !== user.id) return c.json({ error: "Only the host can run this station." }, 403);
  const viewed = await c.env.STATION.getByName(id).view();
  if (!viewed) return c.json({ error: "That station has no clock yet." }, 404);
  return c.json(viewed);
});

app.get("/api/stations/:id/socket", async (c) => {
  const user = await requireUser(c);
  if (user instanceof Response) return user;
  const id = c.req.param("id");
  const station = await c.env.DB.prepare("SELECT host_user_id FROM stations WHERE id = ?")
    .bind(id)
    .first<{ host_user_id: string }>();
  if (!station) return c.json({ error: "No station with that id." }, 404);
  if (station.host_user_id !== user.id) return c.json({ error: "Only the host can run this station." }, 403);
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    return c.json({ error: "This route is the station socket." }, 426);
  }
  return c.env.STATION.getByName(id).fetch(socketRequest(c.req.raw, "host", user.id));
});

app.get("/api/listen/:id", async (c) => {
  if (!(await schemaReady(c.env))) {
    return c.json({ error: "D1 schema is not applied. Run npm run setup." }, 503);
  }
  const id = c.req.param("id");
  const station = await c.env.DB.prepare("SELECT id FROM stations WHERE id = ?").bind(id).first();
  if (!station) return c.json({ error: "This share link does not match a station." }, 404);
  const viewed = await c.env.STATION.getByName(id).view();
  if (!viewed) return c.json({ error: "That station has no clock yet." }, 404);
  return c.json(viewed);
});

app.get("/api/listen/:id/audio", async (c) => {
  if (!(await schemaReady(c.env))) {
    return c.json({ error: "D1 schema is not applied. Run npm run setup." }, 503);
  }
  const id = c.req.param("id");
  const station = await c.env.DB.prepare("SELECT id FROM stations WHERE id = ?").bind(id).first();
  if (!station) return c.json({ error: "This share link does not match a station." }, 404);
  const clock = await c.env.STATION.getByName(id).snapshot();
  if (!clock || clock.item.kind !== "break" || !clock.item.clipKey) {
    return c.json({ error: "No DJ clip is on right now." }, 404);
  }
  const object = await c.env.CLIPS.get(clock.item.clipKey);
  if (!object) {
    return c.json({
      error: "The clip is not in R2.",
      speechNote: clock.item.speechNote ?? SPEECH_DEV_NOTE,
    }, 404);
  }
  const contentType = object.httpMetadata?.contentType ?? "audio/mpeg";
  return new Response(object.body, {
    headers: {
      "content-type": contentType,
      "cache-control": "private, max-age=3600",
    },
  });
});

app.get("/api/listen/:id/socket", async (c) => {
  if (!(await schemaReady(c.env))) {
    return c.json({ error: "D1 schema is not applied. Run npm run setup." }, 503);
  }
  const id = c.req.param("id");
  const station = await c.env.DB.prepare("SELECT id FROM stations WHERE id = ?").bind(id).first();
  if (!station) return c.json({ error: "This share link does not match a station." }, 404);
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    return c.json({ error: "This route is the listen socket." }, 426);
  }
  return c.env.STATION.getByName(id).fetch(socketRequest(c.req.raw, "guest", ""));
});

export { Station } from "./station";

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
