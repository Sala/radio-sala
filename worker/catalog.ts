import { missingBindings } from "./bindings";
import { fetchJson } from "./remote";
import type { TrackRecord } from "./types";

const SHORTEST_SONG_SECONDS = 90;
const LONGEST_SONG_SECONDS = 420;

export const EMOTIONS = [
  { id: "blue", label: "Blue", query: "melancholy soul ballad", follow: "smoky piano ballad" },
  { id: "tender", label: "Tender", query: "tender acoustic love song", follow: "close harmony love song" },
  { id: "midnight", label: "Midnight", query: "late night quiet storm", follow: "after hours slow jam" },
  { id: "heat", label: "Heat", query: "hot summer dance track", follow: "sweaty club groove" },
  { id: "glitter", label: "Glitter", query: "sparkling disco pop", follow: "mirrorball dance pop" },
  { id: "restless", label: "Restless", query: "restless indie rock", follow: "nervous electric guitar" },
  { id: "hopeful", label: "Hopeful", query: "hopeful anthemic chorus", follow: "sunrise choir pop" },
  { id: "fierce", label: "Fierce", query: "fierce driving rock", follow: "loud brass stomp" },
  { id: "dreamy", label: "Dreamy", query: "dreamy shoegaze song", follow: "hazy synth reverie" },
  { id: "homesick", label: "Homesick", query: "homesick folk song", follow: "porch light country ballad" },
] as const;

export type Emotion = (typeof EMOTIONS)[number];

type SearchOptions = {
  pages?: number;
  limit?: number;
  genre?: string;
  distinctArtists?: boolean;
};

type SearchOutcome = {
  tracks: TrackRecord[];
  rejected: Array<{ videoId: string; reason: string }>;
  missing: string[];
  error: string | null;
};

type VideoDetails = {
  id?: string;
  snippet?: {
    title?: string;
    channelTitle?: string;
    categoryId?: string;
    liveBroadcastContent?: string;
  };
  contentDetails?: {
    duration?: string;
    regionRestriction?: { allowed?: string[]; blocked?: string[] };
    contentRating?: { ytRating?: string };
  };
  status?: {
    embeddable?: boolean;
    privacyStatus?: string;
    uploadStatus?: string;
  };
};

export function embedBlock(video: VideoDetails, duration: number | null): string | null {
  const snippet = video.snippet;
  const title = snippet?.title ?? "";
  const channel = snippet?.channelTitle ?? "";
  if (!video.id || !title || duration === null) return "missing title or duration";
  if (snippet?.categoryId !== "10") return "not in the music category";
  if (snippet?.liveBroadcastContent && snippet.liveBroadcastContent !== "none") return "live broadcast";
  if (video.status?.embeddable !== true) return "status.embeddable is false";
  if (video.status?.privacyStatus && video.status.privacyStatus !== "public") return "not a public video";
  if (video.status?.uploadStatus && video.status.uploadStatus !== "processed") return "upload is not processed";
  if (video.contentDetails?.contentRating?.ytRating === "ytAgeRestricted") return "age restricted";
  if (/ - Topic$/i.test(channel)) return "YouTube topic art track";
  if (/\b(full album|compilation|megamix|playlist)\b/i.test(title)) return "mix or compilation";
  if (/\bmix\b/i.test(title) && !/\bremix\b/i.test(title)) return "mix or compilation";
  const region = video.contentDetails?.regionRestriction;
  const blocked = region?.blocked?.length ?? 0;
  const allowed = region?.allowed?.length ?? 0;
  if (blocked > 0 || allowed > 0) return "region restricted";
  if (duration < SHORTEST_SONG_SECONDS || duration > LONGEST_SONG_SECONDS) return "outside 1.5 to 7 minutes";
  return null;
}

export async function forgetTrack(env: Env, videoId: string, reason: string): Promise<void> {
  const createdAt = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO tracks (video_id, artist, title, genre, energy, duration_seconds, seed, created_at, reject_reason)
     VALUES (?, '', '', '', '', 0, '', ?, ?)
     ON CONFLICT(video_id) DO UPDATE SET reject_reason = excluded.reject_reason`,
  )
    .bind(videoId, createdAt, reason)
    .run();
  console.log(JSON.stringify({ message: "track rejected", videoId, reason }));
}

function secondsFromIsoDuration(value: string): number | null {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value);
  if (!match || (!match[1] && !match[2] && !match[3])) return null;
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

function energyFromTitle(title: string): string {
  if (/\b(acoustic|lofi|lo-fi|chill|ballad|piano|ambient|soft)\b/i.test(title)) return "low";
  if (/\b(remix|club|dance|edm|bass|rave|hard)\b/i.test(title)) return "high";
  return "mid";
}

function artistAndTitle(rawTitle: string, channelTitle: string): { artist: string; title: string } {
  const cleaned = rawTitle
    .replace(/\s*[([【][^)\]】]{0,48}(?:official|video|audio|lyric|visualizer|hd|4k)[^)\]】]{0,48}[)\]】]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const parts = cleaned.split(/\s[-–—|]\s/);
  if (parts.length >= 2 && parts[0] && parts[1]) {
    return {
      artist: parts[0].trim(),
      title: parts.slice(1).join(" - ").trim() || cleaned,
    };
  }
  const artist = channelTitle.replace(/\s+-\s+Topic$/i, "").replace(/VEVO$/i, "").trim() || "Unknown artist";
  return { artist, title: cleaned || rawTitle };
}

export async function searchSongs(env: Env, seed: string, options: SearchOptions = {}): Promise<SearchOutcome> {
  const pageLimit = options.pages ?? 2;
  const keep = options.limit ?? 6;
  const genre = options.genre ?? "song";
  const missing = missingBindings(env, ["YOUTUBE_API_KEY"]);
  if (missing.length > 0) {
    return {
      tracks: [],
      rejected: [],
      missing,
      error: "YouTube search needs the YOUTUBE_API_KEY binding.",
    };
  }

  const accepted: TrackRecord[] = [];
  const rejected: Array<{ videoId: string; reason: string }> = [];
  const createdAt = new Date().toISOString();
  let pageToken = "";
  let searchError: string | null = null;
  for (let page = 0; page < pageLimit && accepted.length < keep; page += 1) {
    const searchUrl = new URL("https://www.googleapis.com/youtube/v3/search");
    searchUrl.searchParams.set("part", "snippet");
    searchUrl.searchParams.set("type", "video");
    searchUrl.searchParams.set("videoEmbeddable", "true");
    searchUrl.searchParams.set("videoCategoryId", "10");
    searchUrl.searchParams.set("maxResults", "10");
    searchUrl.searchParams.set("q", seed);
    searchUrl.searchParams.set("key", env.YOUTUBE_API_KEY);
    if (pageToken) searchUrl.searchParams.set("pageToken", pageToken);
    const search = await fetchJson(searchUrl.toString());
    if (!search.ok) {
      searchError = `YouTube search failed. ${search.error}`;
      break;
    }
    const searchBody = search.body as {
      nextPageToken?: string;
      items?: Array<{ id?: { videoId?: string } }>;
    };
    pageToken = searchBody.nextPageToken ?? "";
    const ids = (searchBody.items ?? [])
      .map((item) => item.id?.videoId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    if (ids.length === 0) break;

    const detailsUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
    detailsUrl.searchParams.set("part", "snippet,contentDetails,status");
    detailsUrl.searchParams.set("id", ids.join(","));
    detailsUrl.searchParams.set("key", env.YOUTUBE_API_KEY);
    const details = await fetchJson(detailsUrl.toString());
    if (!details.ok) {
      searchError = `YouTube video lookup failed. ${details.error}`;
      break;
    }
    const detailBody = details.body as { items?: VideoDetails[] };
    for (const video of detailBody.items ?? []) {
      const duration = secondsFromIsoDuration(video.contentDetails?.duration ?? "");
      const reason = embedBlock(video, duration);
      const videoId = video.id;
      if (!videoId) continue;
      if (reason) {
        rejected.push({ videoId, reason });
        await forgetTrack(env, videoId, reason);
        continue;
      }
      const prior = await env.DB.prepare("SELECT reject_reason FROM tracks WHERE video_id = ?")
        .bind(videoId)
        .first<{ reject_reason: string | null }>();
      if (prior?.reject_reason) {
        rejected.push({ videoId, reason: prior.reject_reason });
        continue;
      }
      const names = artistAndTitle(video.snippet?.title ?? "", video.snippet?.channelTitle ?? "");
      if (options.distinctArtists && accepted.some((track) => track.artist.toLowerCase() === names.artist.toLowerCase())) {
        continue;
      }
      accepted.push({
        videoId,
        artist: names.artist,
        title: names.title,
        genre,
        energy: energyFromTitle(`${names.artist} ${names.title}`),
        durationSeconds: duration ?? 0,
      });
    }
    if (!pageToken) break;
  }

  if (accepted.length === 0 && searchError && rejected.length === 0) {
    return { tracks: [], rejected, missing: [], error: searchError };
  }

  if (accepted.length === 0) {
    return {
      tracks: [],
      rejected,
      missing: [],
      error: "YouTube returned videos for that seed, but none were public embeddable music between 1.5 and 7 minutes.",
    };
  }

  const statements = accepted.map((track) =>
    env.DB.prepare(
      `INSERT INTO tracks (video_id, artist, title, genre, energy, duration_seconds, seed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(video_id) DO UPDATE SET
         artist = excluded.artist,
         title = excluded.title,
         genre = excluded.genre,
         energy = excluded.energy,
         duration_seconds = excluded.duration_seconds,
         seed = excluded.seed
       WHERE tracks.reject_reason IS NULL`,
    ).bind(
      track.videoId,
      track.artist,
      track.title,
      track.genre,
      track.energy,
      track.durationSeconds,
      seed,
      createdAt,
    ),
  );
  await env.DB.batch(statements);
  return { tracks: accepted, rejected, missing: [], error: null };
}

export async function findOpeners(env: Env, query: string, genre: string): Promise<SearchOutcome> {
  return searchSongs(env, query, { pages: 2, limit: 6, genre, distinctArtists: true });
}

export async function loadTrack(env: Env, videoId: string): Promise<(TrackRecord & { foundBy: string }) | null> {
  const row = await env.DB.prepare(
    `SELECT video_id, artist, title, genre, energy, duration_seconds, seed
     FROM tracks
     WHERE video_id = ? AND reject_reason IS NULL`,
  )
    .bind(videoId)
    .first<{
      video_id: string;
      artist: string;
      title: string;
      genre: string;
      energy: string;
      duration_seconds: number;
      seed: string;
    }>();
  if (!row) return null;
  return {
    videoId: row.video_id,
    artist: row.artist,
    title: row.title,
    genre: row.genre || "song",
    energy: row.energy,
    durationSeconds: row.duration_seconds,
    foundBy: row.seed,
  };
}

export function relatedQueries(
  anchor: { artist: string; energy: string; genre: string },
  originQuery: string,
): { artistQuery: string | null; followQuery: string | null } {
  const origin = originQuery.trim().toLowerCase();
  const artist = anchor.artist.trim();
  const artistQuery = artist.length > 1 && artist.toLowerCase() !== origin ? artist : null;
  const emotion = EMOTIONS.find((item) => item.id === anchor.genre);
  const follow = emotion
    ? emotion.follow
    : anchor.energy === "high"
      ? "uptempo night groove"
      : anchor.energy === "low"
        ? "quiet after hours ballad"
        : "midtempo soulful groove";
  const followQuery = follow.toLowerCase() !== origin && follow.toLowerCase() !== artist.toLowerCase() ? follow : null;
  return { artistQuery, followQuery };
}

export async function pickRelated(
  env: Env,
  anchor: { artist: string; energy: string; genre: string },
  avoid: string[],
  alsoSeeds: string[],
): Promise<TrackRecord | null> {
  const ids = avoid.filter((id) => id.length > 0).slice(0, 30);
  const blocked = ids.length > 0 ? `AND video_id NOT IN (${ids.map(() => "?").join(", ")})` : "";
  const seeds = alsoSeeds.map((seed) => seed.trim().toLowerCase()).filter((seed) => seed.length > 1).slice(0, 4);
  const seedClause = seeds.length > 0 ? `OR lower(seed) IN (${seeds.map(() => "?").join(", ")})` : "";
  const row = await env.DB.prepare(
    `SELECT video_id, artist, title, genre, energy, duration_seconds
     FROM tracks
     WHERE reject_reason IS NULL
       AND artist != ''
       ${blocked}
       AND (
         lower(artist) = lower(?)
         ${seedClause}
       )
     ORDER BY CASE
       WHEN lower(artist) = lower(?) THEN 0
       WHEN energy = ? THEN 1
       ELSE 2
     END, RANDOM()
     LIMIT 1`,
  )
    .bind(...ids, anchor.artist, ...seeds, anchor.artist, anchor.energy)
    .first<{
      video_id: string;
      artist: string;
      title: string;
      genre: string;
      energy: string;
      duration_seconds: number;
    }>();
  if (!row) return null;
  return {
    videoId: row.video_id,
    artist: row.artist,
    title: row.title,
    genre: row.genre || anchor.genre || "song",
    energy: row.energy,
    durationSeconds: row.duration_seconds,
  };
}
