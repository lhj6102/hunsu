CREATE TABLE packages_manager_marketplace_data (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  owner_id TEXT,
  visibility TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO packages_manager_marketplace_data (id, kind, key, owner_id, visibility, title, description, created_at, updated_at)
SELECT id, kind, key, owner_id, visibility, title, description, created_at, updated_at
FROM packages
WHERE kind IN ('team', 'member', 'manager', 'skill');

CREATE TABLE package_versions_manager_marketplace_data (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL,
  version TEXT NOT NULL,
  integrity TEXT NOT NULL,
  manifest_r2_key TEXT NOT NULL,
  status TEXT NOT NULL,
  published_at TEXT NOT NULL,
  published_by TEXT
);

INSERT INTO package_versions_manager_marketplace_data (id, package_id, version, integrity, manifest_r2_key, status, published_at, published_by)
SELECT v.id, v.package_id, v.version, v.integrity, v.manifest_r2_key, v.status, v.published_at, v.published_by
FROM package_versions v
JOIN packages_manager_marketplace_data p ON p.id = v.package_id;

CREATE TABLE package_files_manager_marketplace_data (
  id TEXT PRIMARY KEY,
  package_version_id TEXT NOT NULL,
  path TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL
);

INSERT INTO package_files_manager_marketplace_data (id, package_version_id, path, r2_key, sha256, size_bytes)
SELECT f.id, f.package_version_id, f.path, f.r2_key, f.sha256, f.size_bytes
FROM package_files f
JOIN package_versions_manager_marketplace_data v ON v.id = f.package_version_id;

CREATE TABLE package_lineage_manager_marketplace_data (
  package_id TEXT PRIMARY KEY,
  forked_from_package_id TEXT,
  forked_from_version_id TEXT
);

INSERT INTO package_lineage_manager_marketplace_data (package_id, forked_from_package_id, forked_from_version_id)
SELECT l.package_id, l.forked_from_package_id, l.forked_from_version_id
FROM package_lineage l
JOIN packages_manager_marketplace_data p ON p.id = l.package_id
WHERE (l.forked_from_package_id IS NULL OR l.forked_from_package_id IN (SELECT id FROM packages_manager_marketplace_data))
  AND (l.forked_from_version_id IS NULL OR l.forked_from_version_id IN (SELECT id FROM package_versions_manager_marketplace_data));

CREATE TABLE team_entities_manager_marketplace_data (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL,
  latest_package_version_id TEXT NOT NULL,
  executor_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO team_entities_manager_marketplace_data (id, package_id, latest_package_version_id, executor_id, title, created_at, updated_at)
SELECT e.id, e.package_id, e.latest_package_version_id, e.executor_id, e.title, e.created_at, e.updated_at
FROM team_entities e
JOIN packages_manager_marketplace_data p ON p.id = e.package_id
JOIN package_versions_manager_marketplace_data v ON v.id = e.latest_package_version_id;

CREATE TABLE member_entities_manager_marketplace_data (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL,
  latest_package_version_id TEXT NOT NULL,
  executor_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO member_entities_manager_marketplace_data (id, package_id, latest_package_version_id, executor_id, title, created_at, updated_at)
SELECT e.id, e.package_id, e.latest_package_version_id, e.executor_id, e.title, e.created_at, e.updated_at
FROM member_entities e
JOIN packages_manager_marketplace_data p ON p.id = e.package_id
JOIN package_versions_manager_marketplace_data v ON v.id = e.latest_package_version_id;

CREATE TABLE resource_entities_manager_marketplace_data (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL,
  latest_package_version_id TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO resource_entities_manager_marketplace_data (id, package_id, latest_package_version_id, resource_kind, resource_key, title, created_at, updated_at)
SELECT e.id, e.package_id, e.latest_package_version_id, e.resource_kind, e.resource_key, e.title, e.created_at, e.updated_at
FROM resource_entities e
JOIN packages_manager_marketplace_data p ON p.id = e.package_id
JOIN package_versions_manager_marketplace_data v ON v.id = e.latest_package_version_id;

CREATE TABLE publish_jobs_manager_marketplace_data (
  id TEXT PRIMARY KEY,
  package_version_id TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO publish_jobs_manager_marketplace_data (id, package_version_id, status, error, created_at, updated_at)
SELECT j.id, j.package_version_id, j.status, j.error, j.created_at, j.updated_at
FROM publish_jobs j
JOIN package_versions_manager_marketplace_data v ON v.id = j.package_version_id;

DROP TABLE publish_jobs;
DROP TABLE resource_entities;
DROP TABLE IF EXISTS manager_entities;
DROP TABLE member_entities;
DROP TABLE team_entities;
DROP TABLE package_lineage;
DROP TABLE package_files;
DROP TABLE package_versions;
DROP TABLE packages;

CREATE TABLE packages (
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

INSERT INTO packages (id, kind, key, owner_id, visibility, title, description, created_at, updated_at)
SELECT id, kind, key, owner_id, visibility, title, description, created_at, updated_at
FROM packages_manager_marketplace_data;

CREATE TABLE package_versions (
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

INSERT INTO package_versions (id, package_id, version, integrity, manifest_r2_key, status, published_at, published_by)
SELECT id, package_id, version, integrity, manifest_r2_key, status, published_at, published_by
FROM package_versions_manager_marketplace_data;

CREATE TABLE package_files (
  id TEXT PRIMARY KEY,
  package_version_id TEXT NOT NULL REFERENCES package_versions(id),
  path TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0
);

INSERT INTO package_files (id, package_version_id, path, r2_key, sha256, size_bytes)
SELECT id, package_version_id, path, r2_key, sha256, size_bytes
FROM package_files_manager_marketplace_data;

CREATE TABLE package_lineage (
  package_id TEXT PRIMARY KEY REFERENCES packages(id),
  forked_from_package_id TEXT REFERENCES packages(id),
  forked_from_version_id TEXT REFERENCES package_versions(id)
);

INSERT INTO package_lineage (package_id, forked_from_package_id, forked_from_version_id)
SELECT package_id, forked_from_package_id, forked_from_version_id
FROM package_lineage_manager_marketplace_data;

CREATE TABLE team_entities (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES packages(id),
  latest_package_version_id TEXT NOT NULL REFERENCES package_versions(id),
  executor_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (package_id, executor_id)
);

INSERT INTO team_entities (id, package_id, latest_package_version_id, executor_id, title, created_at, updated_at)
SELECT id, package_id, latest_package_version_id, executor_id, title, created_at, updated_at
FROM team_entities_manager_marketplace_data;

CREATE TABLE member_entities (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES packages(id),
  latest_package_version_id TEXT NOT NULL REFERENCES package_versions(id),
  executor_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (package_id, executor_id)
);

INSERT INTO member_entities (id, package_id, latest_package_version_id, executor_id, title, created_at, updated_at)
SELECT id, package_id, latest_package_version_id, executor_id, title, created_at, updated_at
FROM member_entities_manager_marketplace_data;

CREATE TABLE manager_entities (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES packages(id),
  latest_package_version_id TEXT NOT NULL REFERENCES package_versions(id),
  manager_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (package_id, manager_id)
);

CREATE TABLE resource_entities (
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

INSERT INTO resource_entities (id, package_id, latest_package_version_id, resource_kind, resource_key, title, created_at, updated_at)
SELECT id, package_id, latest_package_version_id, resource_kind, resource_key, title, created_at, updated_at
FROM resource_entities_manager_marketplace_data;

CREATE TABLE publish_jobs (
  id TEXT PRIMARY KEY,
  package_version_id TEXT NOT NULL REFERENCES package_versions(id),
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO publish_jobs (id, package_version_id, status, error, created_at, updated_at)
SELECT id, package_version_id, status, error, created_at, updated_at
FROM publish_jobs_manager_marketplace_data;

CREATE INDEX IF NOT EXISTS idx_package_versions_package_id ON package_versions(package_id);
CREATE INDEX IF NOT EXISTS idx_packages_kind ON packages(kind);
CREATE INDEX IF NOT EXISTS idx_team_entities_package_id ON team_entities(package_id);
CREATE INDEX IF NOT EXISTS idx_member_entities_package_id ON member_entities(package_id);
CREATE INDEX IF NOT EXISTS idx_manager_entities_package_id ON manager_entities(package_id);
CREATE INDEX IF NOT EXISTS idx_resource_entities_package_id ON resource_entities(package_id);

DROP TABLE packages_manager_marketplace_data;
DROP TABLE package_versions_manager_marketplace_data;
DROP TABLE package_files_manager_marketplace_data;
DROP TABLE package_lineage_manager_marketplace_data;
DROP TABLE team_entities_manager_marketplace_data;
DROP TABLE member_entities_manager_marketplace_data;
DROP TABLE resource_entities_manager_marketplace_data;
DROP TABLE publish_jobs_manager_marketplace_data;
