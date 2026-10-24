// Alert rules, as code. Each `expr` evaluates to 1 while the alert condition holds and 0 otherwise
// (PromQL `bool` comparisons), and Grafana fires when it stays above 0 for the `for` duration.
//
// Design rules for these alerts:
// - Only things that need action from you, and each says what to do (runbook).
// - Thresholds come from observed behaviour, not ideals: GitHub Actions dropped scheduled Garmin runs
//   for up to 7.3 h overnight during the first two days, and ~20% of news feeds fail at any moment.
// - If the monitor itself dies, every other rule goes NoData and stays quiet (noData: OK); only the
//   dead man's switch fires. One page, one cause.
// - Severity drives repeat interval only: critical re-emails every 4 h, warning once a day.

// Metric names are unique to this monitor, so rules match on name alone (no job label assumptions).

export const rules = [
  {
    uid: "sm-monitor-down",
    title: "Status monitor not reporting",
    expr: `absent_over_time(monitor_up[10m])`,
    for: "5m",
    severity: "critical",
    noData: "OK", // absent_over_time returns nothing while the metric exists
    summary: "Grafana has had no scrape from the status monitor for 15 minutes, so nothing else can alert.",
    runbook: "Check the status-monitor Worker in the Cloudflare dashboard (deploy errors, METRICS_TOKEN set) and the Metrics Endpoint job in Grafana Cloud (URL and password).",
  },
  {
    uid: "sm-worker-down",
    title: "Worker not answering",
    expr: `monitor_probe_success == bool 0`,
    for: "10m",
    severity: "critical",
    summary: "{{ $labels.target }} has failed its probe for 10 minutes.",
    runbook: "Open the Worker in Cloudflare → Logs. A recent deploy is the usual cause; roll back from Deployments.",
  },
  {
    uid: "sm-check-broken",
    title: "Monitor check failing",
    expr: `monitor_check_success == bool 0`,
    for: "15m",
    severity: "warning",
    summary: "The monitor can't evaluate {{ $labels.check }} (query or schema error), so that check is blind.",
    runbook: "Open the status page: it shows the error text. Usually a schema change in the watched Worker's D1.",
  },
  {
    uid: "sm-garmin-stale",
    title: "Garmin sync stale",
    expr: `(time() - garmin_sync_last_success_timestamp_seconds{kind="daily_summaries"}) > bool 8 * 3600`,
    for: "15m",
    severity: "warning",
    summary: "No successful Garmin sync for over 8 hours.",
    runbook: "GitHub → uokoroo/garmin-app → Actions → Garmin sync. Run it by hand; if it fails, the Garmin key or INGEST_TOKEN has changed.",
  },
  {
    uid: "sm-garmin-erroring",
    title: "Garmin sync erroring",
    expr: `garmin_sync_last_run_ok == bool 0`,
    for: "2h",
    severity: "warning",
    summary: "Garmin data set {{ $labels.kind }} has failed on every run for 2 hours.",
    runbook: "Read the failing run's log in GitHub Actions; the error detail is also in sync_log in D1.",
  },
  {
    uid: "sm-watch-not-synced",
    title: "Watch hasn't synced",
    expr: `(time() - garmin_latest_data_day_timestamp_seconds) > bool 60 * 3600`,
    for: "1h",
    severity: "warning",
    summary: "The newest fully covered day from the watch is more than 2 days old, while the sync job itself is fine.",
    runbook: "Open Garmin Connect on your phone and let the watch sync.",
  },
  {
    uid: "sm-news-ingest-stalled",
    title: "News ingest stalled",
    expr: `(time() - news_ingest_last_run_timestamp_seconds) > bool 3 * 3600`,
    for: "10m",
    severity: "critical",
    summary: "The news-feed ingest cron hasn't run for 3 hours; tomorrow's brief will be built on stale items.",
    runbook: "Cloudflare → news-feed → Settings → Triggers (cron still there?) and Logs for exceptions.",
  },
  {
    uid: "sm-news-feeds-degraded",
    title: "Many news feeds failing",
    expr: `(news_feeds_erroring / news_feeds_total) > bool 0.35`,
    for: "6h",
    severity: "warning",
    summary: "Over 35% of news feeds have been failing for 6 hours (normal is ~20%).",
    runbook: "news-feed /health lists the failing feeds. If they share a host, it's probably blocking Workers.",
  },
  {
    uid: "sm-brief-missing",
    title: "Morning brief missing",
    expr: `news_brief_overdue`,
    for: "5m",
    severity: "critical",
    summary: "Today's brief hasn't been written and it's past the 07:30 deadline.",
    runbook: "Check the 'Morning news brief' scheduled task's last run in Claude, and run it now if it failed.",
  },
  {
    uid: "sm-episode-missing",
    title: "Podcast episode missing",
    expr: `news_episode_overdue`,
    for: "5m",
    severity: "warning",
    summary: "Today's podcast episode has no audio after 08:30.",
    runbook: "The status page shows the episode error. Re-run with POST /admin/run?task=episode on news-feed.",
  },
];
