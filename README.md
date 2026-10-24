# status-monitor

Watches the two personal Workers (`garmin-app`, `news-feed`) and the pipelines behind them, exposes
the result as Prometheus metrics, and lets Grafana Cloud store history, draw the dashboard and email
alerts.

```
Grafana Cloud ──scrape /metrics every 1m──▶ status-monitor Worker
  ├─ Prometheus (history)                     ├─ service bindings ─▶ garmin-app, news-feed   (are they answering?)
  ├─ dashboard                                ├─ garmin-health D1  (sync_log, daily_metrics: is data flowing?)
  └─ alert rules ─▶ email                     └─ news_feed D1      (feed_status, briefs, episodes: did today happen?)
```

The monitor reads the **state the pipelines write themselves**, not just whether a URL returns 200. A
Worker can be "up" while its GitHub Actions poller has silently stopped, or while the 06:11 brief task
failed. Both of those page you here.

It also serves a small status page at `/` for a phone, with the same numbers and no Grafana login.

## What it alerts on

Defined as code in [`grafana/alerts.mjs`](grafana/alerts.mjs), each with a runbook line in the email.

| Alert | Fires when | Severity |
|---|---|---|
| Status monitor not reporting | no scrape for 15 min (dead man's switch) | critical |
| Worker not answering | probe failing 10 min | critical |
| News ingest stalled | ingest cron hasn't run for 3 h | critical |
| Morning brief missing | no brief after 07:30 Dublin | critical |
| Garmin sync stale | no successful sync for 8 h | warning |
| Garmin sync erroring | a data set failed every run for 2 h | warning |
| Watch hasn't synced | newest watch day > 60 h old | warning |
| Many news feeds failing | > 35 % failing for 6 h | warning |
| Podcast episode missing | no audio after 08:30 Dublin | warning |
| Monitor check failing | a check can't run (schema change) | warning |

The thresholds come from the first two days of real data, not from defaults:

- **8 h for Garmin.** The workflow is scheduled hourly, but GitHub dropped runs for up to 7.3 h overnight.
- **35 % for feeds.** Around 20 % of feeds fail at any given moment, so this alert means "worse than normal", not "imperfect".

If the monitor dies, every other rule goes to NoData and stays quiet, and only the dead man's switch
emails you. Critical alerts re-send every 4 h; warnings send once a day. Resolved emails are on.

## Setup

1. **Deploy.** Cloudflare → Workers & Pages → Create → Import a repository → `uokoroo/status-monitor`.
   Then go to Settings → Variables and Secrets and add a secret `METRICS_TOKEN`. Generate it with
   `openssl rand -hex 32`.
2. **Check it.** Open `https://status-monitor.<you>.workers.dev/`. The browser asks for a login: any
   username, with `METRICS_TOKEN` as the password.
3. **Grafana Cloud** (free tier; this uses about 45 series). Go to Connections → Add new connection →
   **Metrics Endpoint**:
   - URL `https://status-monitor.<you>.workers.dev/metrics`
   - Basic auth: username `prometheus`, password `METRICS_TOKEN`
   - Scrape interval 1 minute
4. **Service account.** In Grafana, go to Administration → Service accounts → add one with the
   **Admin** role (alerting provisioning needs it; Editor gets 403s) and create a token.
5. **GitHub secrets.** In this repo, go to Settings → Secrets → Actions and add `GRAFANA_URL`
   (e.g. `https://you.grafana.net`), `GRAFANA_TOKEN` and `ALERT_EMAIL`. Then run **Actions →
   Apply Grafana config**. It creates the folder, email contact point, notification route, rules and
   dashboard, and prints the dashboard link.
6. **Test the email.** In Grafana, go to Alerting → Contact points → *Status monitor email* → Test.

After that, edit `grafana/*.mjs` and push; the workflow re-applies. The script only replaces its own
route (matched on `monitor=status-monitor`), so the rest of your Grafana notification tree is left alone.

## Local

`npm run dev` (needs `wrangler login`; D1 bindings point at the real databases, read-only by
convention: the code only runs SELECTs). To provision Grafana by hand, run
`GRAFANA_URL=… GRAFANA_TOKEN=… ALERT_EMAIL=… npm run grafana`.
