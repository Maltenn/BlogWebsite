-- Push, read-time: the cron checks a line against the same rule the Notifications tab uses (SHOWN, src/shared/notify.js)
-- just before it sends, so a like that was hidden, blocked, deleted or declined in the last minute is never pushed
-- (docs/mobile/redteam.md R6). For that each outbox line has to say which notification it came from. And a line now
-- remembers which devices it has already reached, so a retry (one phone said "try again later") sends only to the others
-- (R12).
--
-- And the third thing: a push never carries what a member wrote, and never says who is under moderation (R5, the owner's
-- decision: sender-only notifications). A push leaves our servers and is read by Apple and Google in the clear. 0010's lines
-- were already fixed phrases, but two kinds told them something they have no business knowing: an AI-writing strike ("a note
-- about your writing") and an appeal's answer, and their tap address (/me/strikes) said the same. Both now read as any
-- other notice. Lines already waiting are rewritten too.

-- the notification a line is about. When the notification goes (the account, a cleanup) its line goes with it.
ALTER TABLE push_outbox ADD COLUMN notification_id INTEGER REFERENCES notifications(id) ON DELETE CASCADE;

-- Lines already waiting (at most a minute's worth, plus anything a switched-off push left behind): find their
-- notification (the same person, kind and instant; if two notifications are identical, either one will do, they are the
-- same news). A line that matches nothing has no notification to check, so it is dropped rather than sent unchecked.
UPDATE push_outbox SET notification_id = (
  SELECT n.id FROM notifications n
  WHERE n.user_id = push_outbox.user_id AND n.kind = push_outbox.kind AND n.created = push_outbox.created
  ORDER BY n.id LIMIT 1);
DELETE FROM push_outbox WHERE notification_id IS NULL;

CREATE INDEX push_outbox_user ON push_outbox (user_id, id);
CREATE INDEX push_outbox_notification ON push_outbox (notification_id);

-- A device that has been dealt with for a line: the push went, or can never go (the service refused it for good, or the
-- token was dead). Only a "try again later" leaves no row. Gone with the line, or with the device.
CREATE TABLE push_sent (
  outbox_id INTEGER NOT NULL REFERENCES push_outbox(id) ON DELETE CASCADE,
  device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  PRIMARY KEY (outbox_id, device_id)
) WITHOUT ROWID;
CREATE INDEX push_sent_device ON push_sent (device_id);

UPDATE push_outbox SET title = 'ourspace', body = 'you have a notification from OurSpace', url = '/notifications'
  WHERE kind IN ('ai_strike', 'ai_appeal');

-- The trigger of 0010, now writing the notification's id as well and saying nothing about moderation. Every body is a
-- fixed phrase; the only member-chosen text in a line is the sender's screen name (title, and in an address).
DROP TRIGGER notifications_push;
CREATE TRIGGER notifications_push AFTER INSERT ON notifications
WHEN EXISTS (SELECT 1 FROM devices d WHERE d.user_id = NEW.user_id AND d.push_token IS NOT NULL AND d.revoked = 0)
BEGIN
  INSERT INTO push_outbox (user_id, kind, title, body, url, created, notification_id)
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
      WHEN 'ai_strike' THEN 'you have a notification from OurSpace'
      WHEN 'ai_appeal' THEN 'you have a notification from OurSpace'
      ELSE 'something happened on ourspace'
    END,
    COALESCE(CASE
      WHEN NEW.kind IN ('follow', 'follow_accepted') THEN '/u/' || x.name
      WHEN NEW.kind = 'follow_request' THEN '/requests'
      WHEN NEW.kind = 'group_invite' THEN '/messages'
      WHEN NEW.kind = 'chat_mention' THEN '/ourspace'
      WHEN NEW.kind = 'board_approved' AND qb.slug IS NOT NULL THEN '/boards/' || qb.slug
      WHEN NEW.kind IN ('board_approved', 'board_declined') THEN '/boards'
      WHEN NEW.kind IN ('ai_strike', 'ai_appeal') THEN '/notifications'
      WHEN p.kind = 'thread' AND pb.slug IS NOT NULL THEN '/boards/' || pb.slug || '/' || p.id
      WHEN p.kind = 'comment' AND pb.slug IS NOT NULL THEN '/boards/' || pb.slug || '/' || p.root_id
      WHEN p.kind = 'wall' THEN '/u/' || po.name
      WHEN p.kind = 'blog' THEN '/u/' || pa.name || '/blog/' || p.id
      WHEN p.id IS NOT NULL THEN '/u/' || pa.name || '/post/' || p.id
    END, '/notifications'),
    NEW.created, NEW.id
  FROM (SELECT 1) one
  LEFT JOIN users x ON x.id = NEW.actor_id
  LEFT JOIN posts p ON p.id = NEW.post_id
  LEFT JOIN users pa ON pa.id = p.author_id
  LEFT JOIN users po ON po.id = p.target_id
  LEFT JOIN boards pb ON pb.id = p.board_id
  LEFT JOIN board_requests q ON q.id = NEW.request_id
  LEFT JOIN boards qb ON qb.id = q.board_id;
END;
