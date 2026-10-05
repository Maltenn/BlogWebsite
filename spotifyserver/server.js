require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const querystring = require('querystring');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

// Tokens: prefer spotify_tokens.json (written on login/refresh), fall back to env
const TOKENS_FILE = path.join(__dirname, 'spotify_tokens.json');
let ACCESS_TOKEN = process.env.SPOTIFY_ACCESS_TOKEN;
let REFRESH_TOKEN = process.env.SPOTIFY_REFRESH_TOKEN;
try {
  const saved = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
  if (saved.access_token) ACCESS_TOKEN = saved.access_token;
  if (saved.refresh_token) REFRESH_TOKEN = saved.refresh_token;
  console.log('Loaded saved Spotify tokens from spotify_tokens.json');
} catch {
  console.log('No saved tokens file — visit /login to authenticate');
}

function saveTokens() {
  try {
    fs.writeFileSync(TOKENS_FILE, JSON.stringify({ access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN }, null, 2));
  } catch (e) {
    console.error('Could not save tokens:', e.message);
  }
}

app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/', (req, res) => {
  res.status(200).send('Spotify Server is running');
});

app.get('/login', (req, res) => {
  res.redirect('https://accounts.spotify.com/authorize?' +
    querystring.stringify({
      response_type: 'code',
      client_id: CLIENT_ID,
      scope: 'user-top-read',
      redirect_uri: REDIRECT_URI,
    }));
});

app.get('/callback', async (req, res) => {
  const code = req.query.code || null;
  
  try {
    const response = await axios.post('https://accounts.spotify.com/api/token', 
      querystring.stringify({
        code: code,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code'
      }), {
        headers: {
          'Authorization': 'Basic ' + (Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64')),
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );
    
    ACCESS_TOKEN = response.data.access_token;
    if (response.data.refresh_token) REFRESH_TOKEN = response.data.refresh_token;
    saveTokens();

    res.send('Authentication successful! Tokens saved — you can close this tab. The blog\'s OurSpace page will now show your real top songs.');
  } catch (error) {
    console.error('Error during authentication:', error.response ? error.response.data : error.message);
    res.status(500).send('Error during authentication');
  }
});

async function refreshAccessToken() {
  try {
    const response = await axios.post('https://accounts.spotify.com/api/token', 
      querystring.stringify({
        grant_type: 'refresh_token',
        refresh_token: REFRESH_TOKEN
      }), {
        headers: {
          'Authorization': 'Basic ' + Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );
    ACCESS_TOKEN = response.data.access_token;
    if (response.data.refresh_token) REFRESH_TOKEN = response.data.refresh_token;
    saveTokens();
    return ACCESS_TOKEN;
  } catch (error) {
    console.error('Error refreshing access token:', error.response ? error.response.data : error.message);
    throw error;
  }
}

const previewCache = new Map();
async function itunesPreview(name, artist) {
    const key = `${name}|${artist}`.toLowerCase();
    if (previewCache.has(key)) return previewCache.get(key);
    let url = null;
    try {
        const r = await axios.get('https://itunes.apple.com/search', {
            params: { term: `${name} ${artist}`, media: 'music', entity: 'song', limit: 1 },
            timeout: 5000,
        });
        url = (r.data.results[0] || {}).previewUrl || null;
    } catch (e) {
        console.error('iTunes preview lookup failed:', e.message);
    }
    previewCache.set(key, url);
    return url;
}

app.get('/top-tracks', async (req, res) => {
    try {
        if (!ACCESS_TOKEN) {
            return res.status(401).json({ error: 'No access token available. Please log in.' });
        }

        // ?limit=N (1-20, default 5) — OurSpace asks for 10
        const limit = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 5));
        const params = { limit, time_range: 'short_term' };

        let response;
        try {
            response = await axios.get('https://api.spotify.com/v1/me/top/tracks', {
                params,
                headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` }
            });
        } catch (error) {
            if (error.response && error.response.status === 401) {
                // Token expired, try to refresh
                ACCESS_TOKEN = await refreshAccessToken();
                response = await axios.get('https://api.spotify.com/v1/me/top/tracks', {
                    params,
                    headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` }
                });
            } else {
                throw error;
            }
        }

        const topTracks = response.data.items.map(track => {
            const images = (track.album && track.album.images) || [];   // largest first
            return {
                name: track.name,
                artist: track.artists.map(a => a.name).join(', '),
                album: track.album.name,
                preview_url: track.preview_url,
                image_url: images.length ? images[0].url : null,
                image_small: images.length ? images[images.length - 1].url : null,   // 64px thumb for lists
                url: (track.external_urls && track.external_urls.spotify) || null     // open.spotify.com link
            };
        });
        // Spotify deprecated preview_url (null for most tracks since late 2024).
        // Fall back to the iTunes Search API, which still serves 30s previews.
        await Promise.all(topTracks.map(async t => {
            if (t.preview_url) return;
            t.preview_url = await itunesPreview(t.name, t.artist.split(', ')[0]);
        }));
        res.json(topTracks);
    } catch (error) {
        console.error('Error fetching top tracks:', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Failed to fetch top tracks' });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});