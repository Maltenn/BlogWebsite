# Spotify Cloud Run Server

This application serves as a backend for accessing Spotify API data, deployed on Google Cloud Run.

## Prerequisites

- Node.js 20 or higher
- Google Cloud account
- Spotify Developer account
- Google Cloud CLI
- Docker

## Local Development

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file with your credentials:
```
SPOTIFY_CLIENT_ID=your_client_id
SPOTIFY_CLIENT_SECRET=your_client_secret
REDIRECT_URI=http://localhost:8080/callback
PORT=8080
```

3. Start the development server:
```bash
npm run dev
```

## Deployment

1. Install Google Cloud CLI
2. Initialize Google Cloud project
3. Build and deploy to Cloud Run
4. Update Spotify Developer Dashboard with new callback URL

See detailed deployment instructions in DEPLOYMENT.md

## API Endpoints

- `GET /` - Health check
- `GET /login` - Initialize Spotify OAuth flow
- `GET /callback` - Handle Spotify OAuth callback
- `GET /top-tracks` - Get user's top tracks

## Environment Variables

- `SPOTIFY_CLIENT_ID` - Your Spotify application client ID
- `SPOTIFY_CLIENT_SECRET` - Your Spotify application client secret
- `REDIRECT_URI` - OAuth callback URL
- `PORT` - Server port (defaults to 8080)

## Security

This application uses environment variables and Google Cloud Secret Manager for sensitive data.
Never commit `.env` files or tokens to version control.
