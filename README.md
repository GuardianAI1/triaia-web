# Triaia Web UI

Web UI for Triaia with Guardian-style separation:

- UI layer: mission input, chat, grounding updates, visualization
- Core layer: sealed planning engine (`/create_mission`, `/update_state`, `/assistant_chat`, etc.)

This project is ready for GitHub + Vercel deployment.

## Architecture

```
Browser UI
  -> Next.js server routes (/api/core/* proxy)
  -> Triaia Core API (sealed)
```

The browser never talks to Core directly. It calls Next.js API routes, which proxy to Core server-side.

## Features

- Branding + mission explanation section
- Core URL selector and `/health` check
- Create mission (`POST /create_mission`)
- Mission status (`GET /mission_status`)
- Grounding controls (`POST /start_grounding`, `POST /stop_grounding`)
- Structured update form (`POST /update_state`)
- Copilot mission constructor (`POST /assistant_construct_mission`)
- Copilot mission chat with style/length controls (`POST /assistant_chat`)

## Local Run

1. Install dependencies:

```bash
cd /Users/thompham/Desktop/Triaia-WEB
npm install
```

2. Create local env file:

```bash
cp .env.example .env.local
```

3. Start UI:

```bash
npm run dev
```

4. Open [http://localhost:3000](http://localhost:3000)

5. Ensure Core is running (example):

```bash
cd /Users/thompham/Desktop/TriangleTrajectoryEngine
source .venv/bin/activate
PYTHONPATH=src python -m htp_core.api_server --host 127.0.0.1 --port 8081
```

Then in UI, Core URL should be `http://127.0.0.1:8081`.

## Environment Variables

- `HTP_CORE_URL`: default Core URL for server proxy (e.g. `http://127.0.0.1:8081`)
- `NEXT_PUBLIC_TRIAIA_WEBSITE_URL`: optional header link target
- `NEXT_PUBLIC_GITHUB_REPO_URL`: optional header link target

## Deploy to GitHub + Vercel

1. Push `/Users/thompham/Desktop/Triaia-WEB` to a GitHub repo.
2. Import repo into Vercel.
3. In Vercel Project Settings -> Environment Variables, set:
   - `HTP_CORE_URL=https://<your-core-host>`
   - optional `NEXT_PUBLIC_TRIAIA_WEBSITE_URL=https://triaia.com`
   - optional `NEXT_PUBLIC_GITHUB_REPO_URL=https://github.com/<org>/<repo>`
4. Deploy.

## Later: Move Core to DigitalOcean

When Core is hosted on DigitalOcean, update only `HTP_CORE_URL` in Vercel.
No UI code changes are required.
