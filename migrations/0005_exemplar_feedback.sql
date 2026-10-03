-- Track real-world exemplar utilization and success rates
ALTER TABLE exemplars ADD COLUMN times_applied INTEGER NOT NULL DEFAULT 0;
ALTER TABLE exemplars ADD COLUMN successful_applications INTEGER NOT NULL DEFAULT 0;
