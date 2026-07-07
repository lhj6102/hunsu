PRAGMA foreign_keys = OFF;

CREATE TABLE packages_execute (
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

INSERT INTO packages_execute (id, kind, key, owner_id, visibility, title, description, created_at, updated_at)
SELECT id, kind, key, owner_id, visibility, title, description, created_at, updated_at
FROM packages
WHERE kind IN ('team', 'member', 'manager', 'skill');

CREATE TABLE package_versions_execute (
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

INSERT INTO package_versions_execute (id, package_id, version, integrity, manifest_r2_key, status, published_at, published_by)
SELECT v.id, v.package_id, v.version, v.integrity, v.manifest_r2_key, v.status, v.published_at, v.published_by
FROM package_versions v
JOIN packages_execute p ON p.id = v.package_id;

CREATE TABLE package_files_execute (
  id TEXT PRIMARY KEY,
  package_version_id TEXT NOT NULL REFERENCES package_versions(id),
  path TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0
);

INSERT INTO package_files_execute (id, package_version_id, path, r2_key, sha256, size_bytes)
SELECT f.id, f.package_version_id, f.path, f.r2_key, f.sha256, f.size_bytes
FROM package_files f
JOIN package_versions_execute v ON v.id = f.package_version_id;

CREATE TABLE package_lineage_execute (
  package_id TEXT PRIMARY KEY REFERENCES packages(id),
  forked_from_package_id TEXT REFERENCES packages(id),
  forked_from_version_id TEXT REFERENCES package_versions(id)
);

INSERT INTO package_lineage_execute (package_id, forked_from_package_id, forked_from_version_id)
SELECT l.package_id, l.forked_from_package_id, l.forked_from_version_id
FROM package_lineage l
JOIN packages_execute p ON p.id = l.package_id
WHERE (l.forked_from_package_id IS NULL OR l.forked_from_package_id IN (SELECT id FROM packages_execute))
  AND (l.forked_from_version_id IS NULL OR l.forked_from_version_id IN (SELECT id FROM package_versions_execute));

CREATE TABLE publish_jobs_execute (
  id TEXT PRIMARY KEY,
  package_version_id TEXT NOT NULL REFERENCES package_versions(id),
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO publish_jobs_execute (id, package_version_id, status, error, created_at, updated_at)
SELECT j.id, j.package_version_id, j.status, j.error, j.created_at, j.updated_at
FROM publish_jobs j
JOIN package_versions_execute v ON v.id = j.package_version_id;

DROP TABLE publish_jobs;
DROP TABLE package_lineage;
DROP TABLE package_files;
DROP TABLE package_versions;
DROP TABLE packages;

ALTER TABLE packages_execute RENAME TO packages;
ALTER TABLE package_versions_execute RENAME TO package_versions;
ALTER TABLE package_files_execute RENAME TO package_files;
ALTER TABLE package_lineage_execute RENAME TO package_lineage;
ALTER TABLE publish_jobs_execute RENAME TO publish_jobs;

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

CREATE INDEX IF NOT EXISTS idx_package_versions_package_id ON package_versions(package_id);
CREATE INDEX IF NOT EXISTS idx_packages_kind ON packages(kind);
CREATE INDEX IF NOT EXISTS idx_team_entities_package_id ON team_entities(package_id);
CREATE INDEX IF NOT EXISTS idx_member_entities_package_id ON member_entities(package_id);
CREATE INDEX IF NOT EXISTS idx_manager_entities_package_id ON manager_entities(package_id);
CREATE INDEX IF NOT EXISTS idx_resource_entities_package_id ON resource_entities(package_id);

PRAGMA foreign_keys = ON;
