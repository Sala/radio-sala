export type BreakLength = "short" | "medium" | "long" | "random";
export type EventsScope = "world" | "romania" | "music";

export type BreakSettings = {
  breakEveryNSongs: number;
  breakLength: BreakLength;
  breakMaxSeconds: number;
  topicToday: boolean;
  topicNextSong: boolean;
  topicWeather: boolean;
  weatherCity: string;
  topicEvents: boolean;
  eventsScope: EventsScope;
};

export type DjRecord = {
  id: string;
  name: string;
  blurb: string;
  speaker: string;
};

export type TrackRecord = {
  videoId: string;
  artist: string;
  title: string;
  genre: string;
  energy: string;
  durationSeconds: number;
};

export type SongItem = {
  kind: "song";
  videoId: string;
  artist: string;
  title: string;
  genre: string;
  energy: string;
  durationSeconds: number;
};

export type BreakItem = {
  kind: "break";
  script: string;
  audioPath: string | null;
  clipKey: string | null;
  durationSeconds: number;
  speechNote: string | null;
  topics: string[];
  sourceNotes: string[];
};

export type ClockItem = SongItem | BreakItem;

export type StationClock = {
  stationId: string;
  hostUserId: string;
  djId: string;
  djName: string;
  speaker: string;
  seed: string;
  displaySeed: string;
  originQuery: string;
  status: "playing" | "paused";
  item: ClockItem;
  positionSeconds: number;
  anchorMs: number;
  songsSinceBreak: number;
  queue: TrackRecord[];
  played: TrackRecord[];
  recentVideoIds: string[];
  settings: BreakSettings;
  error: string | null;
  lastSearchMs: number;
  embedSkips: number;
};

export type ClientClock = {
  stationId: string;
  djId: string;
  djName: string;
  seed: string;
  status: "playing" | "paused";
  item: ClockItem;
  positionSeconds: number;
  anchorMs: number;
  songsSinceBreak: number;
  breakEveryNSongs: number;
  queue: TrackRecord[];
  played: TrackRecord[];
  error: string | null;
};

export type SessionUser = {
  id: string;
  email: string;
  name: string;
};
