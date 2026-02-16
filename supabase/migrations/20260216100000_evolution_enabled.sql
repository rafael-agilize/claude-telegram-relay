-- v1.4 Phase 21: Evolution pause/resume control
-- Add evolution_enabled flag to heartbeat_config table

ALTER TABLE heartbeat_config
ADD COLUMN IF NOT EXISTS evolution_enabled BOOLEAN DEFAULT true;

COMMENT ON COLUMN heartbeat_config.evolution_enabled IS 'Controls whether daily soul evolution runs. Set via /soul pause and /soul resume commands.';
