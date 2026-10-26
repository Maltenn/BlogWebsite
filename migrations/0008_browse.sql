-- Browse (phase 6): mutuals, board recommendations from interests, and the discovery stream, by the small explainable
-- rules of docs/decisions/001-ranking.md. Nothing here records what anybody looks at: no views, dwell or scroll time.
-- The only thing a member's browsing writes is a "not interested" they asked for. Times are ms since the epoch, as in 0001.

-- The curated crosswalk from what people list under their interests (General, Music, Movies, Television, Books,
-- Heroes) to the boards. `term` is one to three words, lower case, without accents or punctuation, as a person might
-- type it; both sides are folded the same way when they're compared (src/browse/score.js: a trailing "s" on longer
-- words, a leading "the"), so "the killers" and "killer" meet. Each board's own name counts too (added in the Worker,
-- not stored). `weight` scales the term (1 = an ordinary term). Moderators add and remove terms
-- (PUT /api/admin/boards/:slug/terms), so a board made from a request can get its own.
CREATE TABLE board_terms (
  term     TEXT    NOT NULL,
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  weight   REAL    NOT NULL DEFAULT 1,
  PRIMARY KEY (term, board_id)
) WITHOUT ROWID;
CREATE INDEX board_terms_board ON board_terms (board_id);

-- "Not interested": a member hid a suggestion. kind: person (out of Mutuals and Who to follow, and their posts out of
-- discovery) | board (out of the board suggestions, its threads out of discovery) | post (that one post or thread out
-- of discovery). ref_id is the user, board or post id: a plain id, so a row about something that's gone is harmless.
CREATE TABLE browse_hidden (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind    TEXT    NOT NULL CHECK (kind IN ('person', 'board', 'post')),
  ref_id  INTEGER NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind, ref_id)
) WITHOUT ROWID;

-- the boards a member posts in (threads and comments): "boards you're active in" is one short index seek per board
CREATE INDEX posts_author_board ON posts (author_id, board_id, created) WHERE board_id IS NOT NULL;

-- discovery's candidates: the kinds it shows, by bucket of writers (author_id % 8, src/browse/browse.js), newest
-- first, so each bucket's newest few dozen are read straight off the index (replies, comments and Friends' Comments
-- aren't in it, so a flood of those costs nothing, and one account's flood only crowds its own bucket). author_id and
-- kind are in it too, so it covers the query: no post row is read until the candidates are chosen.
CREATE INDEX posts_discover ON posts (author_id % 8, created, author_id, kind) WHERE kind IN ('status', 'blog', 'quote', 'thread');

-- a member's newest follows (and whom), off the index: Mutuals reads each friend's newest few, never the whole list
CREATE INDEX follows_recent ON follows (follower_id, status, accepted, followee_id);

-- the launch boards' terms (0004's fourteen, by slug; a board that isn't there gets none)
INSERT INTO board_terms (term, board_id)
  SELECT t.value, b.id FROM boards b JOIN json_each(CASE b.slug
    WHEN 'music' THEN '["music","band","song","album","mixtape","mix cd","playlist","concert","vinyl","record","dj","mixing","guitar","drum","singing","punk","pop punk","emo","rock","indie","metal","hip hop","rap","pop","chiptune","paramore","my chemical romance","mcr","fall out boy","blink 182","green day","the killers","avril","avril lavigne","britney","britney spears","daft punk","gorillaz","outkast","missy elliott","fleetwood mac","lana del rey","florence","taking back sunday","dashboard confessional","yellowcard","sum 41","postal service","weezer","linkin park","the strokes","nirvana","radiohead","beyonce"]'
    WHEN 'movies-tv' THEN '["movie","film","tv","television","anime","cartoon","sitcom","horror movie","mean girls","shes the man","aquamarine","donnie darko","the matrix","hackers","lords of dogtown","practical magic","stardust","scott pilgrim","high fidelity","star wars","buffy","charmed","the oc","laguna beach","futurama","gilmore girls","the simpsons","yo gabba gabba","rob and big"]'
    WHEN 'games' THEN '["games","video games","gaming","gamer","xbox","playstation","nintendo","game boy","pokemon","zelda","mario","halo","the sims","tony hawk","retro games","lan party","cheat codes","arcade","neopets"]'
    WHEN 'art-layouts' THEN '["art","drawing","painting","sketching","pixel art","layout","glitter","glitter gifs","gifs","css","web design","graphic design","photography","photo booths","collage","scrapbooking","sparkle cursor"]'
    WHEN 'cooking' THEN '["cooking","baking","recipe","food","banana bread","cupcakes","cookies","snacks","midnight snacks","pizza","ramen","kitchen"]'
    WHEN 'pets' THEN '["pets","cats","dogs","kitten","puppy","hamster","lizard","rabbit","bunny","fish","horses","animals"]'
    WHEN 'sports' THEN '["sports","skating","skateboarding","skate","kickflip","bmx","bmx videos","soccer","football","basketball","baseball","hockey","snowboarding","surfing","running","swimming","roller skating"]'
    WHEN 'tech' THEN '["tech","computer","html","coding","programming","building pcs","linux","internet","geocities","websites","gadgets","ipod"]'
    WHEN 'fashion' THEN '["fashion","clothes","thrift","thrift stores","thrifting","band tees","outfits","makeup","eyeliner","shoes","sneakers","jewelry","hello kitty"]'
    WHEN 'books-writing' THEN '["books","reading","writing","poetry","poems","journaling","notebook","novels","manga","comics","fan fiction","harry potter","twilight","princess diaries","little prince","snow crash","wallflower","thrasher"]'
    WHEN 'astrology' THEN '["astrology","horoscope","zodiac","tarot","stargazing","astronomy","crystals","full moon","star signs","mercury retrograde"]'
    WHEN 'school' THEN '["school","homework","studying","math","science","chemistry","history","college","teachers","yearbook","debate"]'
    WHEN 'advice' THEN '["advice","crushes","relationships","friendship","dating","friend drama","life advice"]'
    WHEN 'random' THEN '["random","surveys","chain posts","memes","quizzes","sleepovers","everything"]'
    ELSE '[]' END) t;
