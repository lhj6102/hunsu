CREATE TABLE IF NOT EXISTS team_membership_entities (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES packages(id),
  latest_package_version_id TEXT NOT NULL REFERENCES package_versions(id),
  parent_team_executor_id TEXT NOT NULL,
  child_executor_id TEXT NOT NULL,
  child_executor_kind TEXT NOT NULL CHECK (child_executor_kind IN ('team', 'member')),
  visible_profile_json TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (package_id, parent_team_executor_id, child_executor_id)
);

CREATE INDEX IF NOT EXISTS idx_team_membership_entities_package_id ON team_membership_entities(package_id);
CREATE INDEX IF NOT EXISTS idx_team_membership_entities_parent ON team_membership_entities(package_id, parent_team_executor_id);
CREATE INDEX IF NOT EXISTS idx_team_membership_entities_child ON team_membership_entities(package_id, child_executor_id);
