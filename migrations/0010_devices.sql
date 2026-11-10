-- The mobile apps (docs/mobile/contract.md). Times are ms since the epoch, as everywhere.

-- A phone or tablet signed in to an app. token_hash is the session it signed in with (the same SHA-256 as sessions): when
-- that session goes (logged out, password changed, expired, account deleted) the device goes with it, and revoking a
-- device from Settings deletes its session. push_token is the APNs device token or FCM registration token the app gave
-- us; push_provider says which. revoked: set just before the session is deleted (the row then goes with it).
CREATE TABLE devices (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT    NOT NULL UNIQUE REFERENCES sessions(token_hash) ON DELETE CASCADE,
  platform      TEXT    NOT NULL CHECK (platform IN ('ios', 'android')),
  label         TEXT    NOT NULL,
  push_token    TEXT,
  push_provider TEXT    CHECK (push_provider IN ('apns', 'fcm')),
  created       INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL,
  revoked       INTEGER NOT NULL DEFAULT 0,
  CHECK ((push_token IS NULL) = (push_provider IS NULL))
);
CREATE INDEX devices_user ON devices (user_id);
CREATE INDEX devices_push ON devices (push_token) WHERE push_token IS NOT NULL;

-- an app's sign-in with Google or Discord: the callback answers with a custom-scheme redirect, not a page
ALTER TABLE oauth_states ADD COLUMN client TEXT;

-- Push notifications, drained once a minute by the cron (src/push/). Every notification row puts one line here, written
-- by the trigger below, so none of the features that write notifications know about push. title, body and url are what
-- the phone shows and the page the tap opens (the same addresses the site's own pages have). attempts: how many sends
-- have been tried (the drain gives up after a few).
CREATE TABLE push_outbox (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind     TEXT    NOT NULL,
  title    TEXT    NOT NULL,
  body     TEXT    NOT NULL,
  url      TEXT    NOT NULL,
  created  INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);

-- Only for people who have a device that can be pushed to: a site without apps writes nothing here.
CREATE TRIGGER notifications_push AFTER INSERT ON notifications
WHEN EXISTS (SELECT 1 FROM devices d WHERE d.user_id = NEW.user_id AND d.push_token IS NOT NULL AND d.revoked = 0)
BEGIN
  INSERT INTO push_outbox (user_id, kind, title, body, url, created)
  SELECT NEW.user_id, NEW.kind,
    CASE WHEN NEW.kind IN ('ai_strike', 'ai_appeal', 'board_approved', 'board_declined') THEN 'ourspace' ELSE COALESCE(x.name, 'ourspace') END,
    CASE NEW.kind
      WHEN 'like' THEN 'liked your post'
      WHEN 'reply' THEN 'replied to you'
      WHEN 'repost' THEN 'reposted your post'
      WHEN 'quote' THEN 'quoted your post'
      WHEN 'mention' THEN 'mentioned you'
      WHEN 'comment' THEN 'left a comment on your page'
      WHEN 'follow' THEN 'started following you'
      WHEN 'follow_request' THEN 'wants to follow you'
      WHEN 'follow_accepted' THEN 'accepted your follow request'
      WHEN 'group_invite' THEN 'invited you to a group chat'
      WHEN 'chat_mention' THEN 'mentioned you in #ourspace'
      WHEN 'board_approved' THEN 'your board request was approved'
      WHEN 'board_declined' THEN 'your board request was declined'
      WHEN 'ai_strike' THEN 'a note about your writing'
      WHEN 'ai_appeal' THEN 'your appeal has an answer'
      ELSE 'something happened on ourspace'
    END,
    COALESCE(CASE
      WHEN NEW.kind IN ('follow', 'follow_accepted') THEN '/u/' || x.name
      WHEN NEW.kind = 'follow_request' THEN '/requests'
      WHEN NEW.kind = 'group_invite' THEN '/messages'
      WHEN NEW.kind = 'chat_mention' THEN '/ourspace'
      WHEN NEW.kind IN ('ai_strike', 'ai_appeal') THEN '/me/strikes'
      WHEN NEW.kind = 'board_approved' AND qb.slug IS NOT NULL THEN '/boards/' || qb.slug
      WHEN NEW.kind IN ('board_approved', 'board_declined') THEN '/boards'
      WHEN p.kind = 'thread' AND pb.slug IS NOT NULL THEN '/boards/' || pb.slug || '/' || p.id
      WHEN p.kind = 'comment' AND pb.slug IS NOT NULL THEN '/boards/' || pb.slug || '/' || p.root_id
      WHEN p.kind = 'wall' THEN '/u/' || po.name
      WHEN p.kind = 'blog' THEN '/u/' || pa.name || '/blog/' || p.id
      WHEN p.id IS NOT NULL THEN '/u/' || pa.name || '/post/' || p.id
    END, '/notifications'),
    NEW.created
  FROM (SELECT 1) one
  LEFT JOIN users x ON x.id = NEW.actor_id
  LEFT JOIN posts p ON p.id = NEW.post_id
  LEFT JOIN users pa ON pa.id = p.author_id
  LEFT JOIN users po ON po.id = p.target_id
  LEFT JOIN boards pb ON pb.id = p.board_id
  LEFT JOIN board_requests q ON q.id = NEW.request_id
  LEFT JOIN boards qb ON qb.id = q.board_id;
END;
