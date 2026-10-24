#!/usr/bin/env node
// Applies the monitor's Grafana config: folder, email contact point, notification route,
// alert rules (grafana/alerts.mjs) and dashboard (grafana/dashboard.mjs). Idempotent: run it after
// every change. It only touches objects it owns; the rest of your notification tree is preserved.
//
//   GRAFANA_URL=https://<stack>.grafana.net GRAFANA_TOKEN=glsa_... ALERT_EMAIL=you@example.com \
//     node scripts/provision-grafana.mjs
//
// GRAFANA_TOKEN: a service account token with the Editor role (Administration → Service accounts).
// PROM_DS_UID (optional): Prometheus data source UID, if auto-detection picks the wrong one.

import { rules } from "../grafana/alerts.mjs";
import { dashboard } from "../grafana/dashboard.mjs";

const { GRAFANA_URL, GRAFANA_TOKEN, ALERT_EMAIL, PROM_DS_UID } = process.env;
for (const [k, v] of Object.entries({ GRAFANA_URL, GRAFANA_TOKEN, ALERT_EMAIL })) {
  if (!v) { console.error(`Missing ${k}`); process.exit(1); }
}

const FOLDER = { uid: "status-monitor", title: "Status monitor" };
const GROUP = "status-monitor";
const CONTACT = { uid: "status-monitor-email", name: "Status monitor email" };
const OWNER = ["monitor", "=", "status-monitor"]; // label on every rule; the route matches on it

async function api(method, path, body, { allow = [] } = {}) {
  const res = await fetch(new URL(path, GRAFANA_URL), {
    method,
    headers: {
      authorization: `Bearer ${GRAFANA_TOKEN}`,
      "content-type": "application/json",
      // Keep provisioned objects editable in the UI, so a quick fix there doesn't need a redeploy.
      "x-disable-provenance": "true",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok && !allow.includes(res.status)) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 500)}`);
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

async function prometheusUid() {
  if (PROM_DS_UID) return PROM_DS_UID;
  const { data } = await api("GET", "/api/datasources");
  const prom = data.filter((d) => d.type === "prometheus");
  const pick = prom.find((d) => /^grafanacloud-.*-prom$/.test(d.name)) ?? prom[0];
  if (!pick) throw new Error("No Prometheus data source found; set PROM_DS_UID.");
  console.log(`Prometheus data source: ${pick.name} (${pick.uid})`);
  return pick.uid;
}

async function folder() {
  const got = await api("GET", `/api/folders/${FOLDER.uid}`, undefined, { allow: [404] });
  if (got.status === 404) await api("POST", "/api/folders", FOLDER);
  console.log(`Folder: ${FOLDER.title}`);
}

async function contactPoint() {
  const body = {
    ...CONTACT,
    type: "email",
    settings: { addresses: ALERT_EMAIL.split(/[,;\s]+/).filter(Boolean).join(";"), singleEmail: true },
    disableResolveMessage: false, // a "resolved" email closes the loop
  };
  const { data } = await api("GET", "/api/v1/provisioning/contact-points");
  if (data.some((c) => c.uid === CONTACT.uid)) await api("PUT", `/api/v1/provisioning/contact-points/${CONTACT.uid}`, body);
  else await api("POST", "/api/v1/provisioning/contact-points", body);
  console.log(`Contact point: email → ${body.settings.addresses}`);
}

async function route() {
  const { data: tree } = await api("GET", "/api/v1/provisioning/policies");
  const ours = {
    receiver: CONTACT.name,
    object_matchers: [OWNER],
    group_by: ["alertname", "severity"],
    group_wait: "1m",       // batch alerts that fire together into one email
    group_interval: "10m",
    repeat_interval: "24h",
    continue: false,
    routes: [
      { receiver: CONTACT.name, object_matchers: [["severity", "=", "critical"]], repeat_interval: "4h" },
      { receiver: CONTACT.name, object_matchers: [["severity", "=", "warning"]], repeat_interval: "24h" },
    ],
  };
  const isOurs = (r) => JSON.stringify(r.object_matchers ?? []) === JSON.stringify([OWNER]);
  tree.routes = [ours, ...(tree.routes ?? []).filter((r) => !isOurs(r))];
  await api("PUT", "/api/v1/provisioning/policies", tree);
  console.log("Notification route: monitor=status-monitor → email (critical every 4h, warning daily)");
}

async function alertRules(dsUid) {
  const body = {
    title: GROUP,
    interval: 60,
    rules: rules.map((r) => ({
      uid: r.uid,
      title: r.title,
      folderUID: FOLDER.uid,
      ruleGroup: GROUP,
      condition: "C",
      for: r.for,
      noDataState: r.noData ?? "OK",
      execErrState: "Error",
      labels: { severity: r.severity, monitor: "status-monitor" },
      annotations: { summary: r.summary, description: r.runbook },
      data: [
        {
          refId: "A",
          datasourceUid: dsUid,
          relativeTimeRange: { from: 900, to: 0 },
          model: { refId: "A", expr: r.expr, instant: true, range: false, intervalMs: 60000, maxDataPoints: 43200 },
        },
        {
          refId: "B",
          datasourceUid: "__expr__",
          relativeTimeRange: { from: 0, to: 0 },
          model: { refId: "B", type: "reduce", expression: "A", reducer: "last", settings: { mode: "dropNN" } },
        },
        {
          refId: "C",
          datasourceUid: "__expr__",
          relativeTimeRange: { from: 0, to: 0 },
          model: { refId: "C", type: "threshold", expression: "B", conditions: [{ evaluator: { type: "gt", params: [0] } }] },
        },
      ],
    })),
  };
  await api("PUT", `/api/v1/provisioning/folder/${FOLDER.uid}/rule-groups/${GROUP}`, body);
  console.log(`Alert rules: ${rules.length} (${rules.map((r) => r.title).join("; ")})`);
}

async function dash(dsUid) {
  const { data } = await api("POST", "/api/dashboards/db", { dashboard: dashboard(dsUid), folderUid: FOLDER.uid, overwrite: true });
  console.log(`Dashboard: ${new URL(data.url, GRAFANA_URL)}`);
}

const dsUid = await prometheusUid();
await folder();
await contactPoint();
await route();
await alertRules(dsUid);
await dash(dsUid);
console.log("Done.");
