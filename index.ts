// X-RAY JVS · Edge Function "xray-mail"
// Every 5 minutes pg_cron (run_mailer) calls this. It asks the database which scheduled emails are due
// (or which "Send test now" was pressed), builds the reports and sends them from your Gmail.
// It also sends the GPS no-signal escalation emails (site in-charge / seniors) inside their daily time window.
// Deploy: Supabase Dashboard → Edge Functions → Deploy a new function → Via editor,
// name it  xray-mail , paste this file, and turn OFF "Verify JWT".
// Gmail address + App password are saved from the app: Settings → Scheduled email.
import { createClient } from "jsr:@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6.9.16";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const IST: Intl.DateTimeFormatOptions = { timeZone: "Asia/Kolkata" };
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const hm = (m: number) => { m = Math.round(+m || 0); return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`; };
const dur = (m: number) => {
  m = Math.round(+m || 0);
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mi = m % 60;
  return d ? `${d} d ${h} hr` : h ? `${h} hr ${mi} min` : `${mi} min`;
};
const when = (t: string) => t ? new Date(t).toLocaleString("en-IN", { ...IST, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: true }) : "";
const map = (lat: number, lng: number) => lat != null && lng != null ? `https://www.google.com/maps?q=${lat},${lng}` : "";
const STATUS: Record<string, string> = { Moving: "Moving", Idling: "Idling", Stopped: "Stopped", Offline: "Offline" };
const TYPE: Record<string, string> = { loading: "Loading", unloading: "Unloading", waiting: "Unloading queue", other: "Named place" };

type Col = [string, (r: any) => unknown, ((r: any) => string)?];
function table(cols: Col[], rows: any[], hot?: (r: any) => boolean) {
  if (!rows.length) return `<p style="color:#666;font-size:13px;margin:6px 0 18px">Nothing to show.</p>`;
  const th = cols.map(([h]) => `<th style="text-align:left;padding:8px 10px;background:#1f2937;color:#fff;font-size:11px;letter-spacing:.05em;text-transform:uppercase;white-space:nowrap">${esc(h)}</th>`).join("");
  const tr = rows.map((r, i) => `<tr style="background:${i % 2 ? "#f7f8fa" : "#fff"}">${cols.map(([, f, html]) =>
    `<td style="padding:7px 10px;border-bottom:1px solid #e5e7eb;font-size:13px;vertical-align:top;${hot && hot(r) ? "color:#b42318;" : ""}">${html ? html(r) : esc(f(r))}</td>`).join("")}</tr>`).join("");
  return `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;margin:6px 0 22px;font-family:Arial,sans-serif">${`<tr>${th}</tr>`}${tr}</table>`;
}
function csv(cols: Col[], rows: any[]) {
  const q = (v: unknown) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return "﻿" + [cols.map(([h]) => q(h)).join(","), ...rows.map((r) => cols.map(([, f]) => q(f(r))).join(","))].join("\r\n");
}
const h2 = (t: string, sub = "") => `<h2 style="font-family:Arial,sans-serif;font-size:16px;margin:18px 0 2px;color:#111">${esc(t)}</h2>${sub ? `<div style="font-family:Arial,sans-serif;color:#666;font-size:12px;margin-bottom:4px">${esc(sub)}</div>` : ""}`;
const mapCell = (r: any) => map(r.lat, r.lng) ? `<a href="${map(r.lat, r.lng)}" style="color:#2f6be0">Map</a>` : "";

function build(data: any, reports: string[]) {
  let html = "", summary: string[] = [];
  const files: { filename: string; content: string }[] = [];
  const day = new Date().toLocaleDateString("en-CA", IST);
  const thr = data.threshold_min ?? 60;

  if (reports.includes("fleet") && data.fleet_status) {
    const s = data.fleet_status, tot = data.fleet_total ?? 0;
    const card = (l: string, n: number, c: string) => `<td style="padding:10px 14px;background:#f3f4f6;border-radius:8px;font-family:Arial,sans-serif"><div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.05em">${l}</div><div style="font-size:22px;font-weight:bold;color:${c}">${n}</div></td><td width="8"></td>`;
    html += h2("Fleet summary") + `<table cellspacing="0" cellpadding="0" style="margin:6px 0 12px"><tr>${card("Total", tot, "#111")}${card("Moving", s.Moving ?? 0, "#1f9d55")}${card("Idling", s.Idling ?? 0, "#d98a00")}${card("Stopped", s.Stopped ?? 0, "#7b5cd6")}${card("Offline", s.Offline ?? 0, "#6b7280")}</tr></table>`;
    const cols: Col[] = [["Geofence", (r) => r.geofence], ["Type", (r) => r.type ? TYPE[r.type] ?? r.type : "Outside"], ["Vehicles", (r) => r.vehicles],
      ["Standing", (r) => r.standing], ["Moving", (r) => r.moving], ["Offline", (r) => r.offline]];
    html += table(cols, data.fleet_geofence ?? []);
    files.push({ filename: `fleet-by-geofence-${day}.csv`, content: csv(cols, data.fleet_geofence ?? []) });
    summary.push(`${tot} vehicles`);
  }
  if (reports.includes("alerts") && data.alerts) {
    const cols: Col[] = [["Vehicle", (r) => r.reg], ["Geofence", (r) => r.geofence], ["Status", (r) => STATUS[r.status] ?? r.status],
      ["Stopped at", (r) => (r.start_known ? "" : "≤ ") + when(r.since)], ["Duration", (r) => (r.start_known ? "" : "≥ ") + dur(r.minutes)],
      ["Location", (r) => r.location], ["Address", (r) => r.address], ["Map", (r) => map(r.lat, r.lng), mapCell]];
    html += h2(`Stopped outside points ${thr}+ min · ${data.alerts.length} vehicle(s)`, "Machines and vehicles marked as breakdown are not listed.");
    html += table(cols, data.alerts, () => true);
    files.push({ filename: `stopped-${thr}min-${day}.csv`, content: csv(cols, data.alerts) });
    summary.push(`${data.alerts.length} stopped ${thr}+ min`);
  }
  if (reports.includes("by_location") && data.by_location) {
    const cols: Col[] = [["Vehicle", (r) => r.reg], ["Geofence", (r) => r.geofence], ["Location", (r) => r.location + (r.point_type ? ` (${TYPE[r.point_type] ?? r.point_type})` : "")],
      ["Vehicles here", (r) => r.here], ["Status", (r) => STATUS[r.status] ?? r.status], ["Stopped since", (r) => (r.start_known ? "" : "≤ ") + when(r.since)],
      ["Duration", (r) => (r.start_known ? "" : "≥ ") + dur(r.minutes)], ["Trakzee location", (r) => r.landmark], ["Map", (r) => map(r.lat, r.lng), mapCell]];
    html += h2(`Stopped vehicles by location · ${data.by_location.length} vehicle(s)`);
    html += table(cols, data.by_location, (r) => !["loading", "unloading", "waiting"].includes(r.point_type) && r.minutes >= thr);
    files.push({ filename: `stopped-by-location-${day}.csv`, content: csv(cols, data.by_location) });
  }
  if (reports.includes("daily") && data.daily) {
    const cols: Col[] = [["Vehicle", (r) => r.reg], ["Geofence (now)", (r) => r.geofence], ["Type", (r) => r.type], ["KM", (r) => (+r.km).toFixed(1)],
      ["Engine on", (r) => hm(r.engine_min)], ["Working", (r) => hm(r.run_min)], ["Idle", (r) => hm(r.idle_min)],
      ["Stopped", (r) => hm(r.stop_min)], ["No signal", (r) => hm(r.nodata_min)]];
    const km = data.daily.reduce((a: number, r: any) => a + (+r.km || 0), 0), eng = data.daily.reduce((a: number, r: any) => a + (+r.engine_min || 0), 0);
    html += h2("Yesterday: km and engine hours", `Total ${km.toFixed(0)} km · engine ${hm(eng)}`);
    html += table(cols, data.daily);
    files.push({ filename: `yesterday-km-engine-${day}.csv`, content: csv(cols, data.daily) });
    summary.push(`${km.toFixed(0)} km yesterday`);
  }
  return { html, files, summary };
}

// ---------- GPS no-signal escalation emails ----------
function gpsMail(g: any) {
  const sev = g.cnt > 1 && g.idx === g.cnt ? "final" : g.idx > 1 ? "warn" : "info";
  const col = ({ info: "#d98a00", warn: "#e5612a", final: "#b42318" } as Record<string, string>)[sev];
  const rows: any[] = g.vehicles ?? [];
  const cols: Col[] = [["Vehicle", (r) => r.reg], ["Type", (r) => r.type], ["No signal for", (r) => dur((+r.hours || 0) * 60)],
    ["Last signal", (r) => when(r.since)], ["Last known location", (r) => r.place], ["Map", (r) => map(r.lat, r.lng), mapCell]];
  const msg = String(g.message || "").replace(/\{hours\}/g, String(+g.hours));
  const now = new Date().toLocaleString("en-IN", { ...IST, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true });
  const html = `<div style="font-family:Arial,sans-serif;max-width:900px">
    <div style="background:${col};color:#fff;padding:16px 20px;border-radius:10px">
      <div style="font-size:18px;font-weight:bold">${g.test ? "(TEST) " : ""}${esc(g.label)}</div>
      <div style="font-size:12px;opacity:.9;margin-top:4px">Site: ${esc(g.site)} · ${rows.length} vehicle(s) · ${esc(now)} IST</div></div>
    <p style="font-size:14px;line-height:1.5;color:#111;margin:14px 0 6px">Dear Sir,</p>
    <p style="font-size:14px;line-height:1.5;color:#111;margin:0 0 8px">${esc(msg)}</p>
    ${table(cols, rows, () => true)}
    <div style="color:#555;font-size:12px;line-height:1.5">What to do: open <b>X-RAY JVS</b> and either mark the vehicle as <b>Breakdown</b> (Breakdown page), or get the GPS repaired and log it in <b>GPS issues</b>.
    Vehicles that already have an open breakdown or GPS issue are not listed. Sent to: ${esc((g.to ?? []).join(", "))}.</div></div>`;
  return { html, subject: `${g.test ? "(TEST) " : ""}${g.label} · ${g.site} · ${rows.length} vehicle(s)` };
}

function mkTx(s: any) {
  return nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user: s.user, pass: s.pass } });
}
const niceErr = (e: unknown) => {
  const msg = String((e as Error)?.message ?? e).slice(0, 300);
  return /Invalid login|BadCredentials|535/i.test(msg) ? "Gmail rejected the login. Use a Google App password (not your normal password)." : msg;
};

async function runGps() {
  const { data, error } = await sb.rpc("gps_mail_due");
  if (error) return { error: error.message };
  const groups: any[] = data?.groups ?? [];
  if (!groups.length) return { sent: 0 };
  const s = data.sender ?? {};
  try {
    if (!s.user || !s.pass) {
      await sb.rpc("gps_mail_done", { p_group: groups[0], p_ok: false, p_status: "Gmail is not set up (Settings → Scheduled email)" });
      return { error: "no sender" };
    }
    const tx = mkTx(s);
    let ok = 0, vehicles = 0, lastErr = "";
    for (const g of groups) {
      try {
        const m = gpsMail(g);
        await tx.sendMail({ from: `"${(s.name || "X-RAY JVS").replace(/"/g, "")}" <${s.user}>`, to: g.to, subject: m.subject, html: m.html });
        ok++; vehicles += (g.vehicles ?? []).length;
        await sb.rpc("gps_mail_done", { p_group: g, p_ok: true, p_status: "ok" });
      } catch (e) {
        lastErr = niceErr(e);
        await sb.rpc("gps_mail_done", { p_group: g, p_ok: false, p_status: "error: " + lastErr });
      }
    }
    if (ok) await sb.rpc("gps_mail_done", { p_group: { test: true }, p_ok: true, p_status: `ok: ${ok} email(s) for ${vehicles} vehicle(s)` + (lastErr ? " · some failed: " + lastErr : "") });
    return { sent: ok, error: lastErr || undefined };
  } finally {
    await sb.rpc("gps_mail_finish");
  }
}

// ---------- Scheduled report emails ----------
async function runSchedules() {
  const { data: due, error } = await sb.rpc("mail_due");
  if (error) return { error: error.message };
  const list = due?.schedules ?? [];
  if (!list.length) return { sent: 0 };
  const s = due.sender ?? {};
  if (!s.user || !s.pass) {
    for (const m of list) await sb.rpc("mail_done", { p_id: m.id, p_status: "Gmail is not set up (Settings → Scheduled email)", p_scheduled: false });
    return { error: "no sender" };
  }
  const tx = mkTx(s);
  const out: any[] = [];
  for (const m of list) {
    try {
      const { data, error } = await sb.rpc("mail_report_data", { p_reports: m.reports });
      if (error) throw new Error(error.message);
      const b = build(data, m.reports);
      const now = new Date().toLocaleString("en-IN", { ...IST, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true });
      const html = `<div style="font-family:Arial,sans-serif;max-width:1100px">
        <div style="background:#0b0d11;color:#fff;padding:16px 20px;border-radius:10px">
          <div style="font-size:18px;font-weight:bold;letter-spacing:.04em">X-RAY JVS · ${esc(m.name)}${m.is_test ? " (TEST)" : ""}</div>
          <div style="font-size:12px;color:#9aa1ad;margin-top:4px">Data as of ${esc(now)} IST${b.summary.length ? " · " + esc(b.summary.join(" · ")) : ""}</div></div>
        ${b.html}
        <div style="color:#888;font-size:11px;margin-top:10px">Geofence column: name of the geofence the vehicle is in, or the nearest geofence and its distance (straight line).
        The same tables are attached as CSV files (open in Excel). Change or stop this email in the app: Settings → Scheduled email.</div></div>`;
      await tx.sendMail({
        from: `"${(s.name || "X-RAY JVS").replace(/"/g, "")}" <${s.user}>`,
        to: m.recipients,
        subject: `X-RAY JVS · ${m.name}${m.is_test ? " (test)" : ""} · ${now}`,
        html,
        attachments: b.files.map((f) => ({ filename: f.filename, content: f.content, contentType: "text/csv; charset=utf-8" })),
      });
      await sb.rpc("mail_done", { p_id: m.id, p_status: "ok", p_scheduled: !!m.scheduled && !m.is_test });
      out.push({ id: m.id, ok: true });
    } catch (e) {
      const nice = niceErr(e);
      await sb.rpc("mail_done", { p_id: m.id, p_status: "error: " + nice, p_scheduled: false });
      out.push({ id: m.id, error: nice });
    }
  }
  return { sent: out.filter((x) => x.ok).length, results: out };
}

Deno.serve(async () => {
  const reports = await runSchedules();
  const gps = await runGps();
  return Response.json({ ok: true, reports, gps });
});
