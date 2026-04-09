# Kesha Bot — Project Instructions

## Project Conventions
- Cron schedule is bi-weekly (every 2 weeks, Wed 12:00 CET) — do not change to more frequent
- Any additional triggers (ad-hoc runs, tests) should use the manual HTTP trigger endpoint, not the cron
- Apply content filters (date range, relevance) at the data-gathering step (fetchWebContext), not only in the persona prompt — the prompt is a safety net, the source is the primary filter
