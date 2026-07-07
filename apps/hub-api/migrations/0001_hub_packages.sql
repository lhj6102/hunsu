CREATE TABLE IF NOT EXISTS packages (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('team', 'member', 'manager', 'skill')),
  key TEXT NOT NULL,
  owner_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
  title TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (kind, key)
);

CREATE TABLE IF NOT EXISTS package_versions (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES packages(id),
  version TEXT NOT NULL,
  integrity TEXT NOT NULL,
  manifest_r2_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'rejected')),
  published_at TEXT NOT NULL,
  published_by TEXT,
  UNIQUE (package_id, version)
);

CREATE TABLE IF NOT EXISTS package_files (
  id TEXT PRIMARY KEY,
  package_version_id TEXT NOT NULL REFERENCES package_versions(id),
  path TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS package_lineage (
  package_id TEXT PRIMARY KEY REFERENCES packages(id),
  forked_from_package_id TEXT REFERENCES packages(id),
  forked_from_version_id TEXT REFERENCES package_versions(id)
);

CREATE TABLE IF NOT EXISTS team_entities (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES packages(id),
  latest_package_version_id TEXT NOT NULL REFERENCES package_versions(id),
  executor_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (package_id, executor_id)
);

CREATE TABLE IF NOT EXISTS member_entities (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES packages(id),
  latest_package_version_id TEXT NOT NULL REFERENCES package_versions(id),
  executor_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (package_id, executor_id)
);

CREATE TABLE IF NOT EXISTS manager_entities (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES packages(id),
  latest_package_version_id TEXT NOT NULL REFERENCES package_versions(id),
  manager_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (package_id, manager_id)
);

CREATE TABLE IF NOT EXISTS resource_entities (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES packages(id),
  latest_package_version_id TEXT NOT NULL REFERENCES package_versions(id),
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('skill', 'plugin', 'package')),
  resource_key TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (package_id, resource_kind, resource_key)
);

CREATE TABLE IF NOT EXISTS publish_jobs (
  id TEXT PRIMARY KEY,
  package_version_id TEXT NOT NULL REFERENCES package_versions(id),
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor TEXT,
  action TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_package_versions_package_id ON package_versions(package_id);
CREATE INDEX IF NOT EXISTS idx_packages_kind ON packages(kind);
CREATE INDEX IF NOT EXISTS idx_team_entities_package_id ON team_entities(package_id);
CREATE INDEX IF NOT EXISTS idx_member_entities_package_id ON member_entities(package_id);
CREATE INDEX IF NOT EXISTS idx_manager_entities_package_id ON manager_entities(package_id);
CREATE INDEX IF NOT EXISTS idx_resource_entities_package_id ON resource_entities(package_id);
