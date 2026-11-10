// Chat SQL that more than one feature needs: which conversations a member may open and which are on their list (the
// chat list, the WebSocket, the unread badge in GET /api/me), and handing a group to its next owner (leaving, and
// deleting an account).
import { NOT_BLOCKED } from './db.js';

// SQL: conversation `v` is open to its member ?1: every group; a DM only while the other person isn't banned and has
// no block with them either way
export const CHAT_OPEN = `(v.kind = 'group' OR NOT EXISTS (SELECT 1 FROM conversation_members o JOIN users ou ON ou.id = o.user_id
  WHERE o.conversation_id = v.id AND o.user_id != ?1 AND (ou.banned = 1 OR NOT ${NOT_BLOCKED('o.user_id')})))`;

// SQL: conversation `v` is on member ?1's list: every group; a DM once somebody wrote in it, or if they opened it
export const CHAT_LISTED = `(v.kind = 'group' OR v.last_message_at IS NOT NULL OR v.created_by = ?1)`;

// SQL: messages in membership `cm`'s conversation that its member ?1 hasn't read: newer than their last_read_id, by
// somebody else who isn't banned and has no block with them, not deleted or taken down
export const UNREAD_IN = cm => `SELECT 1 FROM chat_messages um JOIN users ua ON ua.id = um.author_id
  WHERE um.conversation_id = ${cm}.conversation_id AND um.id > ${cm}.last_read_id AND um.author_id != ?1
    AND um.hidden = 0 AND um.deleted = 0 AND ua.banned = 0 AND ${NOT_BLOCKED('um.author_id')}`;

// SQL: how many of member ?1's conversations have unread messages (the badge), up to 99
export const UNREAD_CHATS = `(SELECT COUNT(*) FROM (SELECT 1 FROM conversation_members cm JOIN conversations v ON v.id = cm.conversation_id
  WHERE cm.user_id = ?1 AND cm.status = 'joined' AND ${CHAT_OPEN} AND EXISTS (${UNREAD_IN('cm')}) LIMIT 99))`;

// SQL: in the groups `which` (SQL on o.conversation_id) that member ?1 owns, the longest-standing other member (joined
// first) becomes the owner. For the batch that takes ?1 out of them: run it first.
export const HANDOVER = which => `UPDATE conversation_members SET role = 'owner'
  WHERE status = 'joined' AND user_id != ?1
    AND conversation_id IN (SELECT o.conversation_id FROM conversation_members o WHERE o.user_id = ?1 AND o.role = 'owner' AND ${which})
    AND user_id = (SELECT n.user_id FROM conversation_members n WHERE n.conversation_id = conversation_members.conversation_id
      AND n.status = 'joined' AND n.user_id != ?1 ORDER BY n.joined, n.user_id LIMIT 1)`;
