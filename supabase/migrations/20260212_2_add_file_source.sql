-- Add 'file' as valid source for cron jobs (HEARTBEAT.md sync)
ALTER TABLE cron_jobs DROP CONSTRAINT IF EXISTS cron_jobs_source_check;
ALTER TABLE cron_jobs ADD CONSTRAINT cron_jobs_source_check
  CHECK (source IN ('user', 'agent', 'file'));
