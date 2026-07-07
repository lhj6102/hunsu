UPDATE package_versions
SET status = 'rejected'
WHERE status = 'published'
  AND version = '1.0.0'
  AND package_id IN (
    'team:team.superloopy.crew',
    'team:team.skills-curation'
  );
