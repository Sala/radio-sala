import type { BreakLength, BreakSettings, EventsScope } from "./types";

const LENGTHS: BreakLength[] = ["short", "medium", "long", "random"];
const SCOPES: EventsScope[] = ["world", "romania", "music"];

export type SettingsRow = {
  favorite_dj_ids: string;
  break_every_n_songs: number;
  break_length: string;
  break_max_seconds: number;
  topic_today: number;
  topic_next_song: number;
  topic_weather: number;
  weather_city: string;
  topic_events: number;
  events_scope: string;
};

export type StoredSettings = {
  favoriteDjIds: string[];
  break: BreakSettings;
};

function booleanValue(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === 0) return value === 1;
  return null;
}

export function settingsFromRow(row: SettingsRow, knownDjIds: string[]): StoredSettings | null {
  let favorites: unknown;
  try {
    favorites = JSON.parse(row.favorite_dj_ids) as unknown;
  } catch {
    return null;
  }
  if (!Array.isArray(favorites) || favorites.some((id) => typeof id !== "string")) return null;
  const favoriteDjIds = favorites.filter((id): id is string => knownDjIds.includes(id));
  if (!LENGTHS.includes(row.break_length as BreakLength)) return null;
  if (!SCOPES.includes(row.events_scope as EventsScope)) return null;
  return {
    favoriteDjIds,
    break: {
      breakEveryNSongs: row.break_every_n_songs,
      breakLength: row.break_length as BreakLength,
      breakMaxSeconds: row.break_max_seconds,
      topicToday: row.topic_today === 1,
      topicNextSong: row.topic_next_song === 1,
      topicWeather: row.topic_weather === 1,
      weatherCity: row.weather_city,
      topicEvents: row.topic_events === 1,
      eventsScope: row.events_scope as EventsScope,
    },
  };
}

export function settingsFromBody(body: unknown, knownDjIds: string[]): StoredSettings | string {
  if (!body || typeof body !== "object") return "Settings need a JSON object.";
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.favoriteDjIds) || record.favoriteDjIds.some((id) => typeof id !== "string")) {
    return "Pick the DJs by id.";
  }
  const favoriteDjIds = record.favoriteDjIds.filter((id): id is string => knownDjIds.includes(id));
  if (favoriteDjIds.length === 0) return "Keep at least one DJ on the start screen.";
  if (favoriteDjIds.length !== record.favoriteDjIds.length) return "One of those DJs is not on this station.";
  if (typeof record.breakEveryNSongs !== "number" || !Number.isInteger(record.breakEveryNSongs)) {
    return "Break cadence needs a whole number of songs.";
  }
  if (record.breakEveryNSongs < 1 || record.breakEveryNSongs > 12) {
    return "Break cadence has to stay between 1 and 12 songs.";
  }
  if (typeof record.breakLength !== "string" || !LENGTHS.includes(record.breakLength as BreakLength)) {
    return "Break length is short, medium, long, or random.";
  }
  if (typeof record.breakMaxSeconds !== "number" || !Number.isInteger(record.breakMaxSeconds)) {
    return "Max break length needs a whole number of seconds.";
  }
  if (record.breakMaxSeconds < 8 || record.breakMaxSeconds > 180) {
    return "Max break length has to stay between 8 and 180 seconds.";
  }
  const topicToday = booleanValue(record.topicToday);
  const topicNextSong = booleanValue(record.topicNextSong);
  const topicWeather = booleanValue(record.topicWeather);
  const topicEvents = booleanValue(record.topicEvents);
  if (topicToday === null || topicNextSong === null || topicWeather === null || topicEvents === null) {
    return "Each topic is on or off.";
  }
  if (typeof record.weatherCity !== "string" || record.weatherCity.trim().length > 80) {
    return "The weather city needs to be 80 characters or fewer.";
  }
  if (topicWeather && record.weatherCity.trim() === "") {
    return "Turn weather on with a city, or leave weather off.";
  }
  if (typeof record.eventsScope !== "string" || !SCOPES.includes(record.eventsScope as EventsScope)) {
    return "Events scope is world, Romania, or music.";
  }
  return {
    favoriteDjIds,
    break: {
      breakEveryNSongs: record.breakEveryNSongs,
      breakLength: record.breakLength as BreakLength,
      breakMaxSeconds: record.breakMaxSeconds,
      topicToday,
      topicNextSong,
      topicWeather,
      weatherCity: record.weatherCity.trim(),
      topicEvents,
      eventsScope: record.eventsScope as EventsScope,
    },
  };
}
