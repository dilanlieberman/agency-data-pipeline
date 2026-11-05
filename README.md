# Agency data pipeline

Scheduled jobs that pull my agency's GoHighLevel and Meta data into Supabase, so I can see the whole funnel: texts sent and what they cost, positive reply rate, pick-up rate, booking rate, show rate, close rate, renewals in months 1–3, lifetime value and acquisition cost, and so how much I can spend in each area to scale.

Built with Claude Code. Real commit history (15 Apr – 7 Jul 2026), extracted from my private agency monorepo; tokens and client data removed.

## What's here
- `scripts/agency-tracker/`: GHL billing, conversation, inbox and pipeline sync; Meta ad, daily and history sync with backfill; baselines; staleness alerts; P&L.
- `scripts/meta-sync-webhook/`: an authenticated webhook (X-API-Key, constant-time compare) that triggers a Meta sync on demand.
- `tests/agency-tracker/`: Jest tests, including the 16 derived ad metrics.

## Stack
Node.js · Supabase (Postgres) · GoHighLevel API · Meta Marketing API · cron with flock locks on a Hostinger VPS · Jest
