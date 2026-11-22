import { DurableObject } from "cloudflare:workers";
import { forgetTrack, pickRelated, relatedQueries, searchSongs } from "./catalog";
import { composeBreak } from "./breaks";
import { spokenClip } from "./speech";
import type { BreakSettings, ClientClock, SongItem, StationClock, TrackRecord } from "./types";

export type StartRequest = {
  stationId: string;
  hostUserId: string;
  djId: string;
  djName: string;
  speaker: string;
  originQuery: string;
  displaySeed: string;
  track: TrackRecord;
  settings: BreakSettings;
};

export type StartResult =
  | { ok: true; clock: ClientClock; serverNowMs: number }
  | { ok: false; missing: string[]; error: string };

type Pull = {
  track: TrackRecord | null;
  error: string | null;
  missing: string[];
  searched: boolean;
};

type SocketAttachment = {
  role: "host" | "guest";
  userId: string;
};

function playedAfter(state: StationClock): TrackRecord[] {
  const prior = state.played ?? [];
  if (state.item.kind !== "song") return prior;
  const entry: TrackRecord = {
    videoId: state.item.videoId,
    artist: state.item.artist,
    title: state.item.title,
    genre: state.item.genre || "song",
    energy: state.item.energy,
    durationSeconds: state.item.durationSeconds,
  };
  return [...prior, entry].slice(-40);
}

function songItem(track: TrackRecord): SongItem {
  return {
    kind: "song",
    videoId: track.videoId,
    artist: track.artist,
    title: track.title,
    genre: track.genre || "song",
    energy: track.energy,
    durationSeconds: track.durationSeconds,
  };
}

function anchorFrom(track: { artist: string; energy: string; genre?: string }): { artist: string; energy: string; genre: string } {
  return {
    artist: track.artist,
    energy: track.energy || "mid",
    genre: track.genre || "song",
  };
}

export class Station extends DurableObject<Env> {
  private moving = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS clock (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          body TEXT NOT NULL
        )
      `);
    });
  }

  async start(input: StartRequest): Promise<StartResult> {
    const first = input.track;
    const queue: TrackRecord[] = [];
    const avoid = [first.videoId];
    let lastSearchMs = 0;
    for (let index = 0; index < 3; index += 1) {
      const pulled = await this.nextRelated(anchorFrom(first), input.originQuery, avoid, lastSearchMs);
      if (pulled.searched) lastSearchMs = Date.now();
      if (pulled.missing.length > 0) {
        return { ok: false, missing: pulled.missing, error: pulled.error ?? "A binding is unset." };
      }
      if (!pulled.track) break;
      queue.push(pulled.track);
      avoid.push(pulled.track.videoId);
    }
    const clock: StationClock = {
      stationId: input.stationId,
      hostUserId: input.hostUserId,
      djId: input.djId,
      djName: input.djName,
      speaker: input.speaker,
      seed: input.originQuery,
      displaySeed: input.displaySeed,
      originQuery: input.originQuery,
      status: "paused",
      item: songItem(first),
      positionSeconds: 0,
      anchorMs: Date.now(),
      songsSinceBreak: 0,
      queue,
      played: [],
      recentVideoIds: [],
      settings: input.settings,
      error: null,
      lastSearchMs,
      embedSkips: 0,
    };
    this.writeClock(clock);
    console.log(JSON.stringify({
      message: "station started",
      stationId: input.stationId,
      djId: input.djId,
      queued: queue.length + 1,
    }));
    return { ok: true, clock: this.clientClock(clock), serverNowMs: Date.now() };
  }

  async snapshot(): Promise<StationClock | null> {
    return this.readClock();
  }

  async view(): Promise<{ clock: ClientClock; serverNowMs: number } | null> {
    await this.leaveRejected();
    const clock = this.readClock();
    if (!clock) return null;
    return { clock: this.clientClock(clock), serverNowMs: Date.now() };
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket.", { status: 426 });
    }
    const clock = this.readClock();
    if (!clock) return new Response("No station.", { status: 404 });
    const role = request.headers.get("X-Radio-Role");
    const userId = request.headers.get("X-Radio-User") ?? "";
    if (role !== "host" && role !== "guest") return new Response("Missing role.", { status: 400 });
    if (role === "host" && userId !== clock.hostUserId) {
      return new Response("Only the host can run this station.", { status: 403 });
    }
    await this.leaveRejected();
    const current = this.readClock() ?? clock;
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role, userId } satisfies SocketAttachment);
    server.send(JSON.stringify({ type: "state", serverNowMs: Date.now(), clock: this.clientClock(current) }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async alarm(): Promise<void> {
    const state = this.readClock();
    if (!state || state.status !== "playing") return;
    const elapsed = state.positionSeconds + (Date.now() - state.anchorMs) / 1000;
    if (elapsed + 0.5 < state.item.durationSeconds) {
      await this.arm(state);
      return;
    }
    await this.advance(this.itemKey(state));
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    if (!attachment) return;
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    if (text.length > 4000) return;
    let body: { type?: string; status?: string; positionSeconds?: number; videoId?: string };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      return;
    }
    if (attachment.role !== "host") {
      if (body.type === "reject" && typeof body.videoId === "string") {
        const guestState = this.readClock();
        if (!guestState || guestState.item.kind !== "song" || body.videoId !== guestState.item.videoId) return;
        await this.replaceUnplayable(this.itemKey(guestState), body.videoId);
        return;
      }
      ws.send(JSON.stringify({ type: "rejected", error: "This link is listen-only." }));
      return;
    }
    const state = this.readClock();
    if (!state) return;
    if (body.type === "skip") {
      await this.advance(this.itemKey(state));
      return;
    }
    if (body.type === "reject") {
      if (state.item.kind !== "song" || body.videoId !== state.item.videoId) return;
      await this.replaceUnplayable(this.itemKey(state), body.videoId);
      return;
    }
    if (body.type === "ended") {
      if (state.item.kind !== "song" || body.videoId !== state.item.videoId || state.status !== "playing") return;
      await this.advance(this.itemKey(state));
      return;
    }
    if (body.type !== "transport") return;
    if (body.status !== "playing" && body.status !== "paused") return;
    if (typeof body.positionSeconds !== "number" || !Number.isFinite(body.positionSeconds) || body.positionSeconds < 0) return;
    if (state.item.kind === "song" && body.videoId !== state.item.videoId) return;
    const extrapolated = state.status === "playing"
      ? state.positionSeconds + (Date.now() - state.anchorMs) / 1000
      : state.positionSeconds;
    const position = Math.min(state.item.durationSeconds, body.positionSeconds);
    const statusChanged = body.status !== state.status;
    const drifted = Math.abs(position - extrapolated) > 1.5;
    if (!statusChanged && !drifted) return;
    const next: StationClock = {
      ...state,
      status: body.status,
      positionSeconds: position,
      anchorMs: Date.now(),
      embedSkips: body.status === "playing" ? 0 : state.embedSkips,
    };
    this.writeClock(next);
    await this.arm(next);
    this.broadcast();
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    console.log(JSON.stringify({
      message: "socket closed",
      role: attachment?.role ?? "unknown",
      code,
      wasClean,
      reason,
    }));
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    console.error(JSON.stringify({
      message: "socket error",
      role: attachment?.role ?? "unknown",
      error: error instanceof Error ? error.message : String(error),
    }));
  }

  private async advance(expectedKey: string): Promise<void> {
    if (this.moving) return;
    this.moving = true;
    try {
      const state = this.readClock();
      if (!state || this.itemKey(state) !== expectedKey) return;
      const next = await this.nextClock(state);
      const again = this.readClock();
      if (!again || this.itemKey(again) !== expectedKey) return;
      this.writeClock(next);
      await this.arm(next);
      this.broadcast();
      console.log(JSON.stringify({
        message: "station advanced",
        stationId: next.stationId,
        kind: next.item.kind,
        status: next.status,
      }));
    } finally {
      this.moving = false;
    }
  }

  private async nextClock(state: StationClock): Promise<StationClock> {
    if (state.item.kind === "break") {
      const queue = state.queue.slice();
      const song = queue.shift() ?? null;
      if (!song) {
        return { ...state, status: "paused", error: "No song was queued after the break." };
      }
      const refilled = await this.refill(state, queue, [song.videoId, ...state.recentVideoIds], anchorFrom(song));
      return {
        ...state,
        status: "playing",
        item: songItem(song),
        queue: refilled.queue,
        played: playedAfter(state),
        positionSeconds: 0,
        anchorMs: Date.now(),
        songsSinceBreak: 0,
        lastSearchMs: refilled.lastSearchMs,
        error: null,
      };
    }

    const finished = state.songsSinceBreak + 1;
    const recent = [...state.recentVideoIds, state.item.videoId].slice(-12);
    if (finished >= state.settings.breakEveryNSongs) {
      let queue = state.queue.slice();
      let upcoming: TrackRecord | null = queue[0] ?? null;
      let lastSearchMs = state.lastSearchMs;
      if (!upcoming) {
        const pulled = await this.pullSong(state, [state.item.videoId, ...recent], anchorFrom(state.item));
        if (pulled.searched) lastSearchMs = Date.now();
        upcoming = pulled.track;
        if (!upcoming) {
          const missingName = pulled.missing[0];
          return {
            ...state,
            status: "paused",
            songsSinceBreak: finished,
            recentVideoIds: recent,
            lastSearchMs,
            error: missingName ? `${missingName} is unset.` : pulled.error ?? "No song for the break.",
          };
        }
        queue = [upcoming];
      }
      const facts = await composeBreak(state.djId, state.settings, upcoming);
      const speech = await spokenClip(this.env, state.djId, state.speaker, facts.script);
      return {
        ...state,
        status: "playing",
        item: {
          kind: "break",
          script: facts.script,
          audioPath: speech.clipKey ? `/api/listen/${state.stationId}/audio` : null,
          clipKey: speech.clipKey,
          durationSeconds: facts.durationSeconds,
          speechNote: speech.note,
          topics: facts.topics,
          sourceNotes: facts.sourceNotes,
        },
        positionSeconds: 0,
        anchorMs: Date.now(),
        songsSinceBreak: 0,
        queue,
        played: playedAfter(state),
        recentVideoIds: recent,
        lastSearchMs,
        error: null,
      };
    }

    const queue = state.queue.slice();
    let song = queue.shift() ?? null;
    let lastSearchMs = state.lastSearchMs;
    if (!song) {
      const pulled = await this.pullSong(state, [state.item.videoId, ...recent], anchorFrom(state.item));
      if (pulled.searched) lastSearchMs = Date.now();
      song = pulled.track;
      if (!song) {
        const missingName = pulled.missing[0];
        return {
          ...state,
          status: "paused",
          songsSinceBreak: finished,
          recentVideoIds: recent,
          lastSearchMs,
          error: missingName ? `${missingName} is unset.` : pulled.error ?? "No more songs stored for that seed.",
        };
      }
    }
    const refilled = await this.refill(
      { ...state, lastSearchMs },
      queue,
      [song.videoId, ...recent],
      anchorFrom(song),
    );
    return {
      ...state,
      status: "playing",
      item: songItem(song),
      queue: refilled.queue,
      played: playedAfter(state),
      positionSeconds: 0,
      anchorMs: Date.now(),
      songsSinceBreak: finished,
      recentVideoIds: recent,
      lastSearchMs: refilled.lastSearchMs,
      error: null,
    };
  }

  private async refill(
    state: StationClock,
    queue: TrackRecord[],
    avoid: string[],
    anchor: { artist: string; energy: string; genre: string },
  ): Promise<{ queue: TrackRecord[]; lastSearchMs: number }> {
    let lastSearchMs = state.lastSearchMs;
    const nextQueue = queue.slice();
    const used = [...avoid];
    while (nextQueue.length < 3) {
      const pulled = await this.pullSong({ ...state, lastSearchMs }, used, anchor);
      if (pulled.searched) lastSearchMs = Date.now();
      const picked = pulled.track;
      if (!picked) break;
      if (used.includes(picked.videoId) || nextQueue.some((track) => track.videoId === picked.videoId)) break;
      nextQueue.push(picked);
      used.push(picked.videoId);
    }
    return { queue: nextQueue, lastSearchMs };
  }

  private async pullSong(
    state: StationClock,
    avoid: string[],
    anchor: { artist: string; energy: string; genre: string },
  ): Promise<Pull> {
    return this.nextRelated(anchor, state.originQuery || state.seed, avoid, state.lastSearchMs);
  }

  private async nextRelated(
    anchor: { artist: string; energy: string; genre: string },
    originQuery: string,
    avoid: string[],
    lastSearchMs: number,
  ): Promise<Pull> {
    const plan = relatedQueries(anchor, originQuery);
    const followSeeds = plan.followQuery ? [plan.followQuery] : [];
    const ready = await pickRelated(this.env, anchor, avoid, followSeeds);
    if (ready) return { track: ready, error: null, missing: [], searched: false };
    if (lastSearchMs > 0 && Date.now() - lastSearchMs < 60_000) {
      return { track: null, error: "No related song is stored yet.", missing: [], searched: false };
    }
    const searches: Array<{ query: string; distinctArtists: boolean }> = [];
    if (plan.artistQuery) searches.push({ query: plan.artistQuery, distinctArtists: false });
    if (plan.followQuery) searches.push({ query: plan.followQuery, distinctArtists: true });
    if (searches.length === 0) {
      return { track: null, error: "No related song was found.", missing: [], searched: false };
    }
    let lastError: string | null = "No related song was found.";
    for (const search of searches) {
      const found = await searchSongs(this.env, search.query, {
        pages: 1,
        limit: 5,
        genre: anchor.genre,
        distinctArtists: search.distinctArtists,
      });
      if (found.missing.length > 0) {
        return { track: null, error: found.error, missing: found.missing, searched: true };
      }
      if (found.error) lastError = found.error;
    }
    const picked = await pickRelated(this.env, anchor, avoid, followSeeds);
    return { track: picked, error: picked ? null : lastError, missing: [], searched: true };
  }

  private async leaveRejected(): Promise<void> {
    for (let step = 0; step < 8; step += 1) {
      const state = this.readClock();
      if (!state || state.item.kind !== "song") return;
      const row = await this.env.DB.prepare("SELECT reject_reason FROM tracks WHERE video_id = ?")
        .bind(state.item.videoId)
        .first<{ reject_reason: string | null }>();
      if (!row?.reject_reason) return;
      const before = state.item.videoId;
      await this.replaceUnplayable(this.itemKey(state), state.item.videoId);
      const after = this.readClock();
      if (!after || after.item.kind !== "song" || after.item.videoId === before) return;
    }
  }

  private async replaceUnplayable(expectedKey: string, videoId: string): Promise<void> {
    if (this.moving) return;
    this.moving = true;
    try {
      await forgetTrack(this.env, videoId, "The embed player refused this video.");
      const state = this.readClock();
      if (!state || this.itemKey(state) !== expectedKey) return;
      if (state.item.kind !== "song" || state.item.videoId !== videoId) return;
      const skips = state.embedSkips + 1;
      const queue = state.queue.filter((track) => track.videoId !== videoId);
      const recent = [...state.recentVideoIds, videoId].slice(-24);
      let song = queue.shift() ?? null;
      let lastSearchMs = state.lastSearchMs;
      if (!song) {
        const pulled = await this.pullSong({ ...state, recentVideoIds: recent, lastSearchMs }, recent, anchorFrom(state.item));
        if (pulled.searched) lastSearchMs = Date.now();
        song = pulled.track;
      }
      if (skips > 12 && (!song || song.videoId === videoId)) {
        const stopped: StationClock = {
          ...state,
          status: "paused",
          queue,
          recentVideoIds: recent,
          embedSkips: skips,
          error: "YouTube would not embed the next videos, so the station held.",
        };
        this.writeClock(stopped);
        await this.arm(stopped);
        this.broadcast();
        return;
      }
      if (!song || song.videoId === videoId) {
        const stopped: StationClock = {
          ...state,
          status: "paused",
          queue,
          recentVideoIds: recent,
          embedSkips: skips,
          lastSearchMs,
          error: "No embeddable song was left for that seed.",
        };
        this.writeClock(stopped);
        await this.arm(stopped);
        this.broadcast();
        return;
      }
      const refilled = await this.refill(
        { ...state, lastSearchMs, recentVideoIds: recent },
        queue,
        [song.videoId, ...recent],
        anchorFrom(song),
      );
      const next: StationClock = {
        ...state,
        status: state.status,
        item: songItem(song),
        queue: refilled.queue,
        positionSeconds: 0,
        anchorMs: Date.now(),
        recentVideoIds: recent,
        embedSkips: skips,
        lastSearchMs: refilled.lastSearchMs,
        error: null,
      };
      this.writeClock(next);
      await this.arm(next);
      this.broadcast();
      console.log(JSON.stringify({
        message: "track skipped",
        stationId: state.stationId,
        videoId,
        reason: "embed player refused it",
        nextVideoId: song.videoId,
      }));
    } finally {
      this.moving = false;
    }
  }

  private itemKey(state: StationClock): string {
    const id = state.item.kind === "song" ? state.item.videoId : state.item.clipKey ?? state.item.script;
    return `${state.item.kind}:${id}:${state.anchorMs}`;
  }

  private readClock(): StationClock | null {
    const rows = this.ctx.storage.sql.exec<{ body: string }>("SELECT body FROM clock WHERE id = 1").toArray();
    const body = rows[0]?.body;
    if (!body) return null;
    try {
      const parsed = JSON.parse(body) as StationClock;
      if (!Array.isArray(parsed.played)) parsed.played = [];
      if (typeof parsed.embedSkips !== "number") parsed.embedSkips = 0;
      if (typeof parsed.originQuery !== "string") parsed.originQuery = parsed.seed;
      return parsed;
    } catch (error) {
      console.error(JSON.stringify({
        message: "clock unreadable",
        error: error instanceof Error ? error.message : String(error),
      }));
      return null;
    }
  }

  private writeClock(state: StationClock): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO clock (id, body) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body",
      JSON.stringify(state),
    );
  }

  private clientClock(state: StationClock): ClientClock {
    const item = state.item.kind === "break" ? { ...state.item, clipKey: null } : state.item;
    return {
      stationId: state.stationId,
      djId: state.djId,
      djName: state.djName,
      seed: state.displaySeed,
      status: state.status,
      item,
      positionSeconds: state.positionSeconds,
      anchorMs: state.anchorMs,
      songsSinceBreak: state.songsSinceBreak,
      breakEveryNSongs: state.settings.breakEveryNSongs,
      queue: state.queue,
      played: state.played ?? [],
      error: state.error,
    };
  }

  private broadcast(): void {
    const state = this.readClock();
    if (!state) return;
    const payload = JSON.stringify({ type: "state", serverNowMs: Date.now(), clock: this.clientClock(state) });
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(payload);
      } catch (error) {
        console.error(JSON.stringify({
          message: "socket send failed",
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    }
  }

  private async arm(state: StationClock): Promise<void> {
    if (state.status !== "playing") {
      try {
        await this.ctx.storage.deleteAlarm();
      } catch (error) {
        console.error(JSON.stringify({
          message: "alarm clear failed",
          error: error instanceof Error ? error.message : String(error),
        }));
      }
      return;
    }
    const remainingMs = Math.max(750, (state.item.durationSeconds - state.positionSeconds) * 1000);
    await this.ctx.storage.setAlarm(Date.now() + remainingMs);
  }
}
