import { collect, type Env, type Registry } from "./checks";

// GET /metrics  Prometheus exposition, for Grafana Cloud's Metrics Endpoint scrape job.
// GET /         Small status page for a phone (same numbers, no Grafana login needed).
// Both need METRICS_TOKEN: HTTP Basic (any username, token as password) or Bearer.

function authorised(req: Request, env: Env): boolean {
  const token = env.METRICS_TOKEN;
  if (!token) return false; // fail closed until the secret is set
  const h = req.headers.get("authorization") ?? "";
  let given = "";
  if (h.startsWith("Bearer ")) given = h.slice(7);
  else if (h.startsWith("Basic ")) {
    try { given = atob(h.slice(6)).split(":").slice(1).join(":"); } catch { return false; }
  }
  const a = new TextEncoder().encode(given), b = new TextEncoder().encode(token);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

const challenge = () =>
  new Response("authentication required", { status: 401, headers: { "www-authenticate": 'Basic realm="status-monitor"' } });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (pathname !== "/" && pathname !== "/metrics") return new Response("not found", { status: 404 });
    if (!authorised(req, env)) return challenge();

    const { registry, detail } = await collect(env);
    if (pathname === "/metrics") {
      return new Response(registry.render(), {
        headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" },
      });
    }
    return new Response(page(registry, detail, env), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  },
};

// ---- status page -----------------------------------------------------------------------------

type State = "ok" | "warn" | "bad";
interface Row { name: string; state: State; value: string }

function ago(ts: number | undefined): string {
  if (ts === undefined || !Number.isFinite(ts)) return "never";
  const s = Date.now() / 1000 - ts;
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${(s / 3600).toFixed(1)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}
const age = (ts: number | undefined) => (ts !== undefined && Number.isFinite(ts) ? Date.now() / 1000 - ts : Infinity);

const KIND_LABEL: Record<string, string> = {
  daily_summaries: "Daily summaries", sleep: "Sleep", hrv: "HRV", stress: "Stress",
  body_battery: "Body Battery", activities: "Activities", calendar: "Calendar",
};

function rows(r: Registry, env: Env): { group: string; rows: Row[] }[] {
  const checkOk = (c: string) => r.get("monitor_check_success", { check: c }) === 1;
  const failed = (what: string): Row[] => [{ name: `Couldn't read ${what}`, state: "bad", value: "see below" }];

  const probe = (t: string): Row => {
    const ok = r.get("monitor_probe_success", { target: t }) === 1;
    const ms = Math.round((r.get("monitor_probe_duration_seconds", { target: t }) ?? 0) * 1000);
    return { name: t, state: ok ? "ok" : "bad", value: ok ? `up · ${ms} ms` : `down · HTTP ${r.get("monitor_probe_http_status", { target: t }) ?? 0}` };
  };

  // One row for sync freshness (the oldest data set decides), then one row per data set whose last run failed.
  // Mirrors the Grafana rules: stale after 8 h, because GitHub drops scheduled runs.
  let garmin: Row[];
  if (!checkOk("garmin_sync")) garmin = failed("Garmin sync data");
  else {
    const kinds = (r.families.get("garmin_sync_last_success_timestamp_seconds")?.samples ?? []).map((s) => s.labels.kind);
    const oldest = Math.min(...kinds.map((k) => r.get("garmin_sync_last_success_timestamp_seconds", { kind: k }) ?? 0));
    const a = age(oldest);
    garmin = [{ name: "Last sync", state: a > 8 * 3600 ? "bad" : a > 4 * 3600 ? "warn" : "ok", value: ago(oldest) }];
    for (const k of kinds.filter((k) => r.get("garmin_sync_last_run_ok", { kind: k }) !== 1)) {
      garmin.push({ name: KIND_LABEL[k] ?? k, state: "warn", value: "last run failed" });
    }
    const watch = r.get("garmin_latest_data_day_timestamp_seconds");
    garmin.push({
      name: "Newest watch day", state: age(watch) > 60 * 3600 ? "warn" : "ok",
      value: watch !== undefined && Number.isFinite(watch)
        ? new Date(watch * 1000).toLocaleDateString("en-IE", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }) : "none yet",
    });
  }

  let news: Row[];
  if (!checkOk("news_pipeline")) news = failed("news pipeline data");
  else {
    const total = r.get("news_feeds_total") ?? 0, bad = r.get("news_feeds_erroring") ?? 0;
    const lastRun = r.get("news_ingest_last_run_timestamp_seconds");
    const brief = r.get("news_brief_present_today") === 1;
    const audio = r.get("news_episode_audio_ready_today") === 1;
    news = [
      { name: "Ingest", state: age(lastRun) > 3 * 3600 ? "bad" : "ok", value: `last run ${ago(lastRun)}` },
      { name: "Feeds", state: total && bad / total > 0.35 ? "warn" : "ok", value: `${total - bad} of ${total} healthy` },
      // Before the deadline a missing brief or episode is normal, so it stays green.
      { name: "Today's brief", state: brief ? "ok" : r.get("news_brief_overdue") ? "bad" : "ok",
        value: brief ? `written ${ago(r.get("news_brief_created_timestamp_seconds"))}` : `due by ${env.BRIEF_DEADLINE}` },
      { name: "Today's episode", state: audio ? "ok" : r.get("news_episode_overdue") ? "warn" : "ok",
        value: audio ? `ready · ${(r.get("news_episode_tts_chars_today") ?? 0).toLocaleString("en-IE")} chars` : `due by ${env.EPISODE_DEADLINE}` },
    ];
  }

  return [
    { group: "Workers", rows: [probe("garmin-app"), probe("news-feed")] },
    { group: "Garmin sync", rows: garmin },
    { group: "News pipeline", rows: news },
  ];
}

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function page(r: Registry, detail: Record<string, string>, env: Env): string {
  const groups = rows(r, env);
  const all = groups.flatMap((g) => g.rows);
  const failedChecks = (r.families.get("monitor_check_success")?.samples ?? []).filter((s) => s.value === 0);
  const overall: State = failedChecks.length || all.some((x) => x.state === "bad") ? "bad" : all.some((x) => x.state === "warn") ? "warn" : "ok";
  const headline = { ok: "All systems normal", warn: "Degraded", bad: "Something is broken" }[overall];

  const section = (g: { group: string; rows: Row[] }) => `
    <section><h2>${g.group}</h2><ul>${g.rows.map((x) =>
      `<li><span class="dot ${x.state}"></span><span class="n">${escape(x.name)}</span><span class="v">${escape(x.value)}</span></li>`).join("")}</ul></section>`;

  const notes = [
    ...failedChecks.map((s) => `Check <b>${escape(s.labels.check)}</b> failed: ${escape(detail[s.labels.check] ?? "unknown error")}`),
    ...(detail.episode_error ? [`Episode error: ${escape(detail.episode_error.slice(0, 300))}`] : []),
  ];

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Status</title><meta http-equiv="refresh" content="60">
<style>
:root{--bg:#f6f6f3;--card:#fff;--fg:#1b1b1a;--mut:#6b6b66;--line:#e6e5df;--ok:#2f8f5b;--warn:#c98a10;--bad:#c8402f}
@media (prefers-color-scheme:dark){:root{--bg:#121211;--card:#1b1b1a;--fg:#ecebe6;--mut:#9a9992;--line:#2b2b29;--ok:#4cc085;--warn:#e3a92e;--bad:#ef6b59}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:560px;margin:0 auto;padding:28px 16px 40px}
header{display:flex;align-items:flex-start;gap:12px;margin-bottom:22px}
header .dot{width:12px;height:12px;margin-top:8px}h1{font-size:20px;margin:0;font-weight:650;letter-spacing:-.01em}
.sub{color:var(--mut);font-size:13px;margin-top:2px}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;margin-bottom:14px;overflow:hidden}
h2{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--mut);margin:0;padding:12px 16px 4px;font-weight:600}
ul{list-style:none;margin:0;padding:0 0 4px}li{display:flex;align-items:center;gap:10px;padding:9px 16px;border-top:1px solid var(--line)}
li:first-child{border-top:0}.n{flex:1}.v{color:var(--mut);font-variant-numeric:tabular-nums;text-align:right}
.dot{width:9px;height:9px;border-radius:50%;flex:none}.ok{background:var(--ok)}.warn{background:var(--warn)}.bad{background:var(--bad)}
.notes{font-size:13px;color:var(--mut);padding:0 4px}.notes p{margin:6px 0}
</style></head><body><main>
<header><span class="dot ${overall}"></span><div><h1>${headline}</h1>
<div class="sub">Checked ${new Date().toLocaleTimeString("en-IE", { timeZone: env.TIMEZONE, hour: "2-digit", minute: "2-digit" })} · refreshes every minute · alerts via Grafana</div></div></header>
${groups.map(section).join("")}
${notes.length ? `<div class="notes">${notes.map((n) => `<p>${n}</p>`).join("")}</div>` : ""}
</main></body></html>`;
}
