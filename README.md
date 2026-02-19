# Triaia Web UI

General Planning UI (Phase A) for Triaia.

Title in app:

`Triaia — Trajectory Risk Estimator`

Subtitle in app:

`Estimate probability of completing a time-constrained goal.`

## Current UX Flow

1. Landing screen
   - `Create New Plan`
   - `What is this?`
2. Plan setup
   - Goal name + future deadline
   - Sequential steps with:
     - step name
     - estimated duration
     - uncertainty level
     - importance weight
   - Add/remove/reorder/expand-collapse steps
3. Risk result
   - `P(Goal Achieved Before Deadline)`
   - Color bands: green / orange / red
   - Details toggle (completion estimate, CI, drift, simulations)
4. Update progress
   - Step checklist with timestamp on completion
   - Recalculation after each update
5. Completion
   - Yes/No outcome
   - Optional actual completion time
   - Local calibration record logging
6. Assistant panel
   - Expand/collapse chat
   - Guidance-only (cannot submit forms or override probabilities)

## Calibration Logging

Outcome records are stored locally in browser storage:

- key: `triaia_calibration_records_v1`
- includes initial/final predicted probability, outcome, and timing summary

No server-side persistence is required for this Phase A UI.

## Architecture

The app currently ships a self-contained Phase A estimator in the UI for rapid testing.
The server-side Core proxy route is kept in the project for deployment compatibility and future sealed-Core wiring:

`/app/api/core/[...path]/route.ts`

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

## Environment Variables

- `HTP_CORE_URL`: optional default Core URL for server proxy
- `NEXT_PUBLIC_TRIAIA_WEBSITE_URL`: optional
- `NEXT_PUBLIC_GITHUB_REPO_URL`: optional

## Deploy to GitHub + Vercel

1. Push `/Users/thompham/Desktop/Triaia-WEB` to a GitHub repo.
2. Import repo into Vercel.
3. In Vercel Project Settings -> Environment Variables, set optional values as needed:
   - `HTP_CORE_URL=https://<your-core-host>` (only when wiring sealed Core)
   - `NEXT_PUBLIC_TRIAIA_WEBSITE_URL=https://triaia.com`
   - `NEXT_PUBLIC_GITHUB_REPO_URL=https://github.com/<org>/<repo>`
4. Deploy.

## Later: Move Core to DigitalOcean

When Core is hosted on DigitalOcean, update only `HTP_CORE_URL` in Vercel.
No UI code changes are required.
