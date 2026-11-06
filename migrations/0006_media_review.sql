-- Moderators' photo review (phase 5): the launch plan is in-house review, no automatic CSAM scanning (docs/deploy.md).
-- The Moderation page lists uploads newest first; a moderator marks each one seen. reviewed_by / reviewed_at say who
-- looked and when (NULL: nobody yet). Times are ms since the epoch, as in 0001.
ALTER TABLE media ADD COLUMN reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE media ADD COLUMN reviewed_at INTEGER;
CREATE INDEX media_unreviewed ON media (id DESC) WHERE reviewed_at IS NULL;      -- the review queue's default view

-- A report a moderator marked "intimate image without consent" (a Take It Down request) starts the same 48-hour clock as
-- a CSAM report (reason 'csam', which needs no mark): the Moderation page shows the time left.
ALTER TABLE reports ADD COLUMN intimate INTEGER NOT NULL DEFAULT 0;
