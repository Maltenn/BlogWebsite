/* widgets/boardlinks.js — where boards and threads live: /boards/cooking, /boards/cooking/42. */

import { enc } from '../core/dom.js';

export const boardPath = slug => '/boards/' + enc(slug);
export const threadPath = (slug, id) => boardPath(slug) + '/' + id;
