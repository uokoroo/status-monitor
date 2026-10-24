// Grafana dashboard for the status monitor. Top row answers "is anything broken right now";
// the rows below show the trends that the alerts are thresholds on, with those thresholds drawn in.

export function dashboard(ds) {
  const src = { type: "prometheus", uid: ds };
  let id = 0;
  const q = (expr, legendFormat = "") => ({ refId: String.fromCharCode(65 + (id % 26)), expr, legendFormat, datasource: src });

  const stat = (title, expr, { x, y, w = 4, h = 4, unit = "none", mappings = [], steps, legend = "" }) => ({
    id: ++id, type: "stat", title, datasource: src, gridPos: { x, y, w, h },
    targets: [q(expr, legend)],
    options: { reduceOptions: { calcs: ["lastNotNull"] }, colorMode: "background", graphMode: "none", textMode: "value_and_name", justifyMode: "center" },
    fieldConfig: { defaults: { unit, mappings, thresholds: { mode: "absolute", steps } }, overrides: [] },
  });

  const series = (title, targets, { x, y, w = 12, h = 8, unit = "none", threshold, min }) => ({
    id: ++id, type: "timeseries", title, datasource: src, gridPos: { x, y, w, h },
    targets: targets.map(([e, l]) => q(e, l)),
    fieldConfig: {
      defaults: {
        unit, min,
        custom: { lineWidth: 2, fillOpacity: 8, showPoints: "never", ...(threshold !== undefined && { thresholdsStyle: { mode: "dashed" } }) },
        thresholds: { mode: "absolute", steps: [{ color: "transparent", value: null }, ...(threshold !== undefined ? [{ color: "red", value: threshold }] : [])] },
      },
      overrides: [],
    },
    options: { legend: { displayMode: "list", placement: "bottom" }, tooltip: { mode: "multi" } },
  });

  const upDown = [{ type: "value", options: { "0": { text: "DOWN", color: "red" }, "1": { text: "UP", color: "green" } } }];
  const yesNo = (yes, no) => [{ type: "value", options: { "1": { text: yes, color: "green" }, "0": { text: no, color: "orange" } } }];
  const green = (v = null) => ({ color: "green", value: v });

  return {
    uid: "status-monitor",
    title: "Status monitor",
    tags: ["status-monitor"],
    timezone: "Europe/Dublin",
    refresh: "1m",
    time: { from: "now-24h", to: "now" },
    schemaVersion: 39,
    panels: [
      stat("garmin-app", 'monitor_probe_success{target="garmin-app"}', { x: 0, y: 0, mappings: upDown, steps: [{ color: "red", value: null }, green(1)] }),
      stat("news-feed", 'monitor_probe_success{target="news-feed"}', { x: 4, y: 0, mappings: upDown, steps: [{ color: "red", value: null }, green(1)] }),
      stat("Garmin sync age", 'time() - garmin_sync_last_success_timestamp_seconds{kind="daily_summaries"}',
        { x: 8, y: 0, unit: "s", steps: [green(), { color: "orange", value: 4 * 3600 }, { color: "red", value: 8 * 3600 }] }),
      stat("Feeds failing", "news_feeds_erroring / news_feeds_total",
        { x: 12, y: 0, unit: "percentunit", steps: [green(), { color: "orange", value: 0.35 }] }),
      stat("Today's brief", "news_brief_present_today", { x: 16, y: 0, mappings: yesNo("Written", "Not yet"), steps: [{ color: "orange", value: null }, green(1)] }),
      stat("Today's episode", "news_episode_audio_ready_today", { x: 20, y: 0, mappings: yesNo("Ready", "No audio"), steps: [{ color: "orange", value: null }, green(1)] }),

      series("Garmin: hours since last successful sync",
        [['(time() - garmin_sync_last_success_timestamp_seconds) / 3600', "{{kind}}"]],
        { x: 0, y: 4, unit: "h", threshold: 8, min: 0 }),
      series("Garmin: sync runs per hour by outcome",
        [['sum by (status) (increase(garmin_sync_runs_total[1h]))', "{{status}}"]],
        { x: 12, y: 4, min: 0 }),
      series("News: feeds failing",
        [["news_feeds_erroring / news_feeds_total", "failing share"]],
        { x: 0, y: 12, unit: "percentunit", threshold: 0.35, min: 0 }),
      series("News: minutes since ingest last ran",
        [["(time() - news_ingest_last_run_timestamp_seconds) / 60", "ingest"]],
        { x: 12, y: 12, unit: "m", threshold: 180, min: 0 }),
      series("Probe latency (through service binding)",
        [["monitor_probe_duration_seconds", "{{target}}"]],
        { x: 0, y: 20, unit: "s", min: 0 }),
      series("Text-to-speech characters (today's episode)",
        [["news_episode_tts_chars_today", "chars"]],
        { x: 12, y: 20, threshold: 13000, min: 0 }),
    ],
  };
}
