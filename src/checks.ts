// Every check reads the real state of a pipeline (D1 rows the Workers write themselves) or probes
// a Worker through its service binding. Each check is isolated: one failing query sets
// monitor_check_success{check="..."} to 0 and the rest still report.

export interface Env {
  GARMIN: Fetcher;
  NEWS: Fetcher;
  GARMIN_DB: D1Database;
  NEWS_DB: D1Database;
  TIMEZONE: string;
  BRIEF_DEADLINE: string;
  EPISODE_DEADLINE: string;
  METRICS_TOKEN?: string;
}

type Labels = Record<string, string>;
interface Sample { labels: Labels; value: number }
interface Family { help: string; type: "gauge" | "counter"; samples: Sample[] }

export class Registry {
  families = new Map<string, Family>();

  set(name: string, help: string, value: number, labels: Labels = {}, type: "gauge" | "counter" = "gauge") {
    let f = this.families.get(name);
    if (!f) this.families.set(name, (f = { help, type, samples: [] }));
    f.samples.push({ labels, value });
  }

  get(name: string, labels: Labels = {}): number | undefined {
    const key = JSON.stringify(labels);
    return this.families.get(name)?.samples.find((s) => JSON.stringify(s.labels) === key)?.value;
  }

  /** Prometheus text exposition format 0.0.4. */
  render(): string {
    const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
    const out: string[] = [];
    for (const [name, f] of this.families) {
      out.push(`# HELP ${name} ${f.help}`, `# TYPE ${name} ${f.type}`);
      for (const s of f.samples) {
        const l = Object.entries(s.labels).map(([k, v]) => `${k}="${esc(v)}"`).join(",");
        out.push(`${name}${l ? `{${l}}` : ""} ${Number.isFinite(s.value) ? s.value : "NaN"}`);
      }
    }
    return out.join("\n") + "\n";
  }
}

const toEpoch = (iso: string | null | undefined) => (iso ? Date.parse(iso) / 1000 : NaN);

/** Local date (YYYY-MM-DD) and minutes since local midnight in the given zone. */
export function localNow(tz: string, now = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(now).map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}
const hhmm = (s: string) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };

async function probe(r: Registry, target: string, fetcher: Fetcher, path: string, expect: (res: Response) => boolean) {
  const t0 = Date.now();
  let ok = 0, status = 0;
  try {
    const res = await fetcher.fetch(`https://${target}${path}`, { redirect: "manual", signal: AbortSignal.timeout(8000) });
    status = res.status;
    ok = expect(res) ? 1 : 0;
    await res.body?.cancel();
  } catch { /* timeout or exception: ok stays 0 */ }
  r.set("monitor_probe_success", "1 if the Worker answered the probe as expected.", ok, { target });
  r.set("monitor_probe_duration_seconds", "Probe round-trip time through the service binding.", (Date.now() - t0) / 1000, { target });
  r.set("monitor_probe_http_status", "HTTP status of the last probe (0 = no response).", status, { target });
}

async function garmin(r: Registry, env: Env) {
  const db = env.GARMIN_DB;
  const [last, counts, day] = await Promise.all([
    // Newest row per kind, and newest successful row per kind.
    db.prepare(`SELECT s.kind, s.status,
                       (SELECT MAX(finished_at) FROM sync_log o WHERE o.kind = s.kind AND o.status = 'ok') AS last_ok
                FROM sync_log s WHERE s.id IN (SELECT MAX(id) FROM sync_log GROUP BY kind)`).all<{ kind: string; status: string; last_ok: string | null }>(),
    db.prepare(`SELECT kind, status, COUNT(*) AS n FROM sync_log GROUP BY kind, status`).all<{ kind: string; status: string; n: number }>(),
    // Newest day the watch has actually covered: a stale value means the watch isn't syncing to the phone.
    db.prepare(`SELECT MAX(day) AS day FROM daily_metrics WHERE day_coverage > 0.5`).first<{ day: string | null }>(),
  ]);
  for (const k of last.results) {
    r.set("garmin_sync_last_success_timestamp_seconds", "When this data kind last synced successfully.", toEpoch(k.last_ok), { kind: k.kind });
    r.set("garmin_sync_last_run_ok", "1 if the newest sync run for this kind succeeded.", k.status === "error" ? 0 : 1, { kind: k.kind });
  }
  for (const c of counts.results) {
    r.set("garmin_sync_runs_total", "Sync runs recorded, by kind and outcome.", c.n, { kind: c.kind, status: c.status }, "counter");
  }
  r.set("garmin_latest_data_day_timestamp_seconds", "Midnight UTC of the newest day the watch covered.", toEpoch(day?.day ? `${day.day}T00:00:00Z` : null));
}

async function news(r: Registry, env: Env) {
  const db = env.NEWS_DB;
  const { date, minutes } = localNow(env.TIMEZONE);
  const [feeds, brief, ep] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS total, SUM(last_error IS NOT NULL) AS erroring, MAX(updated_at) AS last_run,
                       MAX(last_ok) AS last_ok FROM feed_status`).first<{ total: number; erroring: number; last_run: number; last_ok: number }>(),
    db.prepare(`SELECT created_at FROM briefs WHERE date = ?`).bind(date).first<{ created_at: number }>(),
    db.prepare(`SELECT audio_at, attempts, error, chars FROM episodes WHERE date = ?`).bind(date)
      .first<{ audio_at: number | null; attempts: number; error: string | null; chars: number | null }>(),
  ]);
  r.set("news_feeds_total", "Feeds the ingest job tracks.", feeds?.total ?? 0);
  r.set("news_feeds_erroring", "Feeds whose last fetch failed.", feeds?.erroring ?? 0);
  r.set("news_ingest_last_run_timestamp_seconds", "When the ingest cron last touched any feed.", feeds?.last_run ?? NaN);
  r.set("news_ingest_last_ok_timestamp_seconds", "When any feed was last fetched successfully.", feeds?.last_ok ?? NaN);

  const briefOverdue = !brief && minutes >= hhmm(env.BRIEF_DEADLINE) ? 1 : 0;
  r.set("news_brief_present_today", "1 if today's brief has been written.", brief ? 1 : 0);
  r.set("news_brief_overdue", `1 if today's brief is missing after ${env.BRIEF_DEADLINE} ${env.TIMEZONE}.`, briefOverdue);
  if (brief) r.set("news_brief_created_timestamp_seconds", "When today's brief was written.", brief.created_at);

  const hasAudio = ep?.audio_at ? 1 : 0;
  r.set("news_episode_audio_ready_today", "1 if today's podcast episode has audio.", hasAudio);
  r.set("news_episode_overdue", `1 if today's episode has no audio after ${env.EPISODE_DEADLINE} ${env.TIMEZONE}.`,
    !hasAudio && minutes >= hhmm(env.EPISODE_DEADLINE) ? 1 : 0);
  r.set("news_episode_attempts_today", "Text-to-speech attempts for today's episode.", ep?.attempts ?? 0);
  r.set("news_episode_error_today", "1 if today's episode recorded an error.", ep?.error ? 1 : 0);
  r.set("news_episode_tts_chars_today", "Characters sent to text-to-speech today (drives cost).", ep?.chars ?? 0);
  return { episodeError: ep?.error ?? null };
}

export async function collect(env: Env) {
  const r = new Registry();
  const t0 = Date.now();
  const detail: Record<string, string> = {};

  const run = async (check: string, fn: () => Promise<unknown>) => {
    try {
      const res = await fn();
      if (res && typeof res === "object" && "episodeError" in res && res.episodeError) detail.episode_error = String(res.episodeError);
      r.set("monitor_check_success", "1 if the monitor could evaluate this check (0 = query or code failed).", 1, { check });
    } catch (e) {
      detail[check] = e instanceof Error ? e.message : String(e);
      r.set("monitor_check_success", "1 if the monitor could evaluate this check (0 = query or code failed).", 0, { check });
    }
  };

  await Promise.all([
    run("probe_garmin", () => probe(r, "garmin-app", env.GARMIN, "/login", (res) => res.status === 200)),
    // news-feed answers 404 on / without its session cookie, so probe the open /health page instead.
    run("probe_news", () => probe(r, "news-feed", env.NEWS, "/health", (res) => res.status === 200)),
    run("garmin_sync", () => garmin(r, env)),
    run("news_pipeline", () => news(r, env)),
  ]);

  // Heartbeat for the dead-man's-switch alert: if this series disappears, the monitor itself is down.
  r.set("monitor_up", "Always 1 when the monitor answers.", 1);
  r.set("monitor_collect_duration_seconds", "Time to evaluate all checks.", (Date.now() - t0) / 1000);
  return { registry: r, detail };
}
