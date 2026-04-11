CREATE TABLE IF NOT EXISTS events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       TEXT    NOT NULL,
  type     TEXT    NOT NULL,  -- 'chat' | 'search'
  country  TEXT,
  provider TEXT,
  mode     TEXT,
  rag      TEXT,
  passages INTEGER,
  qlen     INTEGER,
  query    TEXT
);
