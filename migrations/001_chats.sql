CREATE TABLE IF NOT EXISTS chats (
  id uuid PRIMARY KEY,
  owner_user_id text NOT NULL,
  agent_key text NOT NULL DEFAULT 'client-assistant' CHECK (agent_key = 'client-assistant'),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  archived_at timestamptz(3)
);

CREATE INDEX IF NOT EXISTS chats_owner_archive_updated
  ON chats (owner_user_id, archived_at, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS chats_owner_updated
  ON chats (owner_user_id, updated_at DESC, id DESC);
