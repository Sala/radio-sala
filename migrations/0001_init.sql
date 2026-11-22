CREATE TABLE allowed_emails (
  email TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

INSERT INTO allowed_emails (email, created_at)
VALUES ('scorbaciufermecat@gmail.com', '2026-11-18T00:00:00Z');

CREATE TABLE djs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  blurb TEXT NOT NULL,
  speaker TEXT NOT NULL
);

INSERT INTO djs (id, name, blurb, speaker) VALUES
  (
    'vinnie-vega',
    'Vinnie Vega',
    'Slick night host. Confident, and he keeps the lines short.',
    'orion'
  ),
  (
    'rosa-marquez',
    'Rosa Marquez',
    'Warm, and she stays with a story longer than the others.',
    'athena'
  ),
  (
    'miles-crowe',
    'Miles Crowe',
    'Dry, deadpan, and fond of the odd bit of trivia.',
    'angus'
  );

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE settings (
  user_id TEXT PRIMARY KEY,
  favorite_dj_ids TEXT NOT NULL,
  break_every_n_songs INTEGER NOT NULL,
  break_length TEXT NOT NULL,
  break_max_seconds INTEGER NOT NULL,
  topic_today INTEGER NOT NULL,
  topic_next_song INTEGER NOT NULL,
  topic_weather INTEGER NOT NULL,
  weather_city TEXT NOT NULL,
  topic_events INTEGER NOT NULL,
  events_scope TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id)
);

CREATE TABLE tracks (
  video_id TEXT PRIMARY KEY,
  artist TEXT NOT NULL,
  title TEXT NOT NULL,
  genre TEXT NOT NULL,
  energy TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL,
  seed TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX tracks_seed ON tracks (seed);

CREATE TABLE stations (
  id TEXT PRIMARY KEY,
  host_user_id TEXT NOT NULL,
  dj_id TEXT NOT NULL,
  seed TEXT NOT NULL,
  display_seed TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (host_user_id) REFERENCES users (id)
);
