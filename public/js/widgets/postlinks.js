/* widgets/postlinks.js — where a post lives: a blog post has its own page, everything else (status, reply, quote) has
   its conversation. Both are addressed under the writer's name. */

import { userPath } from '../core/dom.js';

export const blogPath = (name, id) => userPath(name) + '/blog/' + id;

// p: an item, or an item-lite ({ id, kind, author })
export const postPath = p => (p.kind === 'blog' ? blogPath(p.author.name, p.id) : userPath(p.author.name) + '/post/' + p.id);
