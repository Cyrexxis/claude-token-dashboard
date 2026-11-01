-- Sub-agent names from Claude Code's agent-<id>.meta.json; agent ids are random and unique across sessions.
CREATE TABLE agents (
  agent_id TEXT PRIMARY KEY,
  agent_type TEXT,
  description TEXT
);
