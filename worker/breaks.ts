import { fetchJson } from "./remote";
import type { BreakSettings, TrackRecord } from "./types";

export type BreakFacts = {
  script: string;
  durationSeconds: number;
  topics: string[];
  sourceNotes: string[];
};

const WEATHER_PHRASES: Record<number, string> = {
  0: "clear",
  1: "mostly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "foggy",
  48: "foggy",
  51: "drizzling",
  53: "drizzling",
  55: "drizzling",
  61: "raining",
  63: "raining",
  65: "raining hard",
  71: "snowing",
  73: "snowing",
  75: "snowing hard",
  80: "showery",
  81: "showery",
  82: "showery",
  95: "stormy",
  96: "stormy",
  99: "stormy",
};

function wordBudget(settings: BreakSettings): { seconds: number; words: number } {
  const max = settings.breakMaxSeconds;
  let seconds = max;
  if (settings.breakLength === "short") seconds = Math.min(8, max);
  else if (settings.breakLength === "medium") seconds = Math.min(22, max);
  else if (settings.breakLength === "long") seconds = Math.min(45, max);
  else {
    const low = Math.min(8, max);
    const span = Math.max(1, max - low + 1);
    const roll = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
    seconds = low + (roll % span);
  }
  return { seconds, words: Math.max(8, Math.floor(seconds * 2.4)) };
}

function trimToWords(text: string, words: number): string {
  const pieces = text.split(/\s+/).filter(Boolean);
  if (pieces.length <= words) return pieces.join(" ");
  return `${pieces.slice(0, words).join(" ").replace(/[.,;:]$/, "")}.`;
}

function plainText(value: string): string {
  return value
    .replace(/<[^>]+>/g, "")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&nbsp;", " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstSentence(value: string, limit: number): string {
  const text = plainText(value);
  const sentence = text.split(/(?<=[.!?])\s/)[0] ?? text;
  if (sentence.length <= limit) return sentence;
  const cut = sentence.slice(0, limit);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim()}.`;
}

async function todayFact(notes: string[]): Promise<string | null> {
  const now = new Date();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const result = await fetchJson(`https://en.wikipedia.org/api/rest_v1/feed/onthisday/events/${month}/${day}`);
  if (!result.ok) {
    notes.push(`Wikipedia's on-this-day feed did not answer. ${result.error}`);
    return null;
  }
  const events = (result.body as { events?: Array<{ year?: number; text?: string }> }).events ?? [];
  if (events.length === 0) {
    notes.push("Wikipedia's on-this-day feed had no events for this date.");
    return null;
  }
  const event = events[now.getUTCDate() % events.length];
  if (!event?.text || typeof event.year !== "number") return null;
  return `On this date in ${event.year}, ${firstSentence(event.text, 180)}`;
}

async function songFact(artist: string, notes: string[]): Promise<string | null> {
  const wiki = await fetchJson(
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(artist.replaceAll(" ", "_"))}`,
  );
  if (wiki.ok) {
    const page = wiki.body as { type?: string; extract?: string; title?: string };
    const extract = page.extract ? firstSentence(page.extract, 220) : "";
    if (page.type === "standard" && extract && !/may refer to/i.test(extract)) {
      return `Wikipedia says: ${extract}`;
    }
  } else {
    notes.push(`Wikipedia had no summary for ${artist}. ${wiki.error}`);
  }

  const query = encodeURIComponent(`artist:"${artist.replaceAll('"', "")}"`);
  const brainz = await fetchJson(`https://musicbrainz.org/ws/2/artist/?query=${query}&fmt=json`);
  if (!brainz.ok) {
    notes.push(`MusicBrainz did not answer for ${artist}. ${brainz.error}`);
    return null;
  }
  const artists = (brainz.body as { artists?: Array<{ name?: string; type?: string; disambiguation?: string }> }).artists ?? [];
  const match = artists.find((entry) => entry.name?.toLowerCase() === artist.toLowerCase()) ?? artists[0];
  if (!match?.name || !match.type) return null;
  const aside = match.disambiguation ? `, ${plainText(match.disambiguation)}` : "";
  return `MusicBrainz lists ${match.name} as a ${match.type}${aside}.`;
}

async function weatherFact(city: string, notes: string[]): Promise<string | null> {
  const trimmed = city.trim();
  if (!trimmed) {
    notes.push("Weather is on, and the city in settings is empty.");
    return null;
  }
  const geo = await fetchJson(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(trimmed)}&count=1&language=en&format=json`,
  );
  if (!geo.ok) {
    notes.push(`Open-Meteo geocoding did not answer. ${geo.error}`);
    return null;
  }
  const place = (geo.body as { results?: Array<{ name?: string; latitude?: number; longitude?: number; country?: string }> })
    .results?.[0];
  if (!place || typeof place.latitude !== "number" || typeof place.longitude !== "number") {
    notes.push(`Open-Meteo has no match for "${trimmed}".`);
    return null;
  }
  const forecast = await fetchJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,weather_code,wind_speed_10m`,
  );
  if (!forecast.ok) {
    notes.push(`Open-Meteo forecast did not answer. ${forecast.error}`);
    return null;
  }
  const current = (forecast.body as { current?: { temperature_2m?: number; weather_code?: number; wind_speed_10m?: number } })
    .current;
  if (!current || typeof current.temperature_2m !== "number" || typeof current.weather_code !== "number") {
    notes.push("Open-Meteo returned no current conditions.");
    return null;
  }
  const phrase = WEATHER_PHRASES[current.weather_code] ?? "in some kind of weather";
  const wind = typeof current.wind_speed_10m === "number" ? `, wind ${Math.round(current.wind_speed_10m)} km/h` : "";
  const where = place.country ? `${place.name}, ${place.country}` : place.name;
  return `Open-Meteo has ${where} at ${Math.round(current.temperature_2m)}°C, ${phrase}${wind}.`;
}

async function eventsFact(scope: BreakSettings["eventsScope"], notes: string[]): Promise<string | null> {
  const queries: Record<BreakSettings["eventsScope"], string> = {
    world: "sourcelang:english",
    romania: '"Romania" sourcelang:english',
    music: "(music OR concert OR album OR song) sourcelang:english",
  };
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(queries[scope])}&mode=ArtList&maxrecords=3&format=json&sort=DateDesc`;
  const result = await fetchJson(url);
  if (!result.ok) {
    notes.push(`GDELT did not answer for ${scope}. ${result.error}`);
    return null;
  }
  const articles = (result.body as { articles?: Array<{ title?: string; domain?: string }> }).articles ?? [];
  const article = articles.find((entry) => entry.title && entry.domain);
  if (!article?.title || !article.domain) {
    notes.push(`GDELT returned no ${scope} headline.`);
    return null;
  }
  return `${article.domain} reports: ${plainText(article.title)}.`;
}

function voiceScript(
  djId: string,
  song: TrackRecord,
  lines: string[],
): string {
  const record = `${song.artist} — ${song.title}`;
  if (djId === "vinnie-vega") {
    return [`You're on Radio Sala.`, `Next, ${record}.`, ...lines].join(" ");
  }
  if (djId === "rosa-marquez") {
    return [
      `Stay with me a second. The next record is ${song.title}, and it's ${song.artist}.`,
      ...lines.map((line) => `I want this one told straight: ${line}`),
    ].join(" ");
  }
  if (djId === "miles-crowe") {
    const odd = lines.length > 0 ? lines.join(" ") : "No sourced trivia came back, so this is only the song.";
    return `${odd} Then ${record}. That is the announcement.`;
  }
  return `Next, ${record}. ${lines.join(" ")}`;
}

export async function composeBreak(
  djId: string,
  settings: BreakSettings,
  song: TrackRecord,
): Promise<BreakFacts> {
  const notes: string[] = [];
  const gathered: { today?: string; song?: string; weather?: string; events?: string } = {};
  const jobs: Array<Promise<void>> = [];
  if (settings.topicToday) {
    jobs.push(todayFact(notes).then((line) => { if (line) gathered.today = line; }));
  }
  if (settings.topicNextSong) {
    jobs.push(songFact(song.artist, notes).then((line) => { if (line) gathered.song = line; }));
  }
  if (settings.topicWeather) {
    jobs.push(weatherFact(settings.weatherCity, notes).then((line) => { if (line) gathered.weather = line; }));
  }
  if (settings.topicEvents) {
    jobs.push(eventsFact(settings.eventsScope, notes).then((line) => { if (line) gathered.events = line; }));
  }
  await Promise.all(jobs);
  const topics: string[] = [];
  const lines: string[] = [];
  const ordered: Array<[string, string | undefined]> = [
    ["today", gathered.today],
    ["the next song", gathered.song],
    ["weather", gathered.weather],
    ["recent events", gathered.events],
  ];
  for (const [topic, line] of ordered) {
    if (!line) continue;
    topics.push(topic);
    lines.push(line);
  }

  const budget = wordBudget(settings);
  const script = trimToWords(voiceScript(djId, song, lines), budget.words);
  const spokenWords = script.split(/\s+/).filter(Boolean).length;
  const durationSeconds = Math.max(4, Math.min(settings.breakMaxSeconds, Math.round(spokenWords / 2.4)));
  return { script, durationSeconds, topics, sourceNotes: notes };
}
