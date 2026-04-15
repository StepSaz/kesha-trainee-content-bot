# Kesha Bot — Project Instructions

## Project Conventions
- Cron schedule is weekly (every Thursday 16:00 Warsaw / 14:00 UTC) — news window is last 7 days
- Any additional triggers (ad-hoc runs, tests) should use the manual HTTP trigger endpoint, not the cron
- Apply content filters (date range, relevance) at the data-gathering step (fetchWebContext), not only in the persona prompt — the prompt is a safety net, the source is the primary filter
