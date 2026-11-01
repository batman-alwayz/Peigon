# VaultDrop

Temporary, zero-trust file transfer. A sender uploads a file, defines a time limit, download cap and optional passkey, then receives a secret link. The receiver unlocks and downloads it before it self-destructs.

## Stack

- React 19, Vite and Tailwind CSS frontend
- Node.js / Express backend
- bcrypt passkey hashing and cryptographically-random 256-bit share tokens
- Local persistent storage for the MVP, Docker for deployment

## Features completed

- Single-file upload up to 100 MB
- Expiry choices: 10 minutes, 1 hour, 24 hours
- Download caps: 1, 3 or 10
- Passkey gate; protected shares reveal no asset metadata before unlock
- Download count is consumed before the stream begins, stopping repeat one-time downloads
- Cleanup worker runs every five minutes and deletes expired/exhausted data
- Responsive sender and receiver screens

## Local development

```bash
npm install
npm run dev
```

Vite opens at `http://localhost:5173`; the Express API runs at port `3000`.

## Public deployment — do this before submission

This project deploys as one Docker service, so the public web address serves both the React UI and API. `localhost` is only for development.

1. Create an empty GitHub repository called `vaultdrop`.
2. In this folder, run:

```bash
git init
git add .
git commit -m "Build secure temporary file sharing MVP"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/vaultdrop.git
git push -u origin main
```

3. Open [Render](https://render.com), sign in with GitHub, select **New → Blueprint**, and select this repository. It detects `render.yaml` and deploys the Docker service.
4. After deployment, copy the `https://...onrender.com` URL and test an upload/download using another browser or phone.

> The free Render plan may sleep when unused. For a more reliable final demo, choose a paid instance.

## Docker alternative

```bash
docker compose up --build
```

## Planned production milestone

The assignment’s optional cloud phase is intentionally documented as future scope: swap the local storage driver for S3 pre-signed PUT/GET URLs, PostgreSQL/Redis for multi-instance atomic counters and rate limits, and use CloudFront for the frontend.
