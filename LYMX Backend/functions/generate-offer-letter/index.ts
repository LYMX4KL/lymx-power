// =============================================================================
// LYMX Power — generate-offer-letter
// =============================================================================
// POST /functions/v1/generate-offer-letter
//
// Generates a job-offer-letter HTML pulling LIVE values from the current
// benefits_policy. Inserts/updates an offers row (status='draft' if new,
// snapshots offer_letter_html + offer_letter_path), saves the HTML to the
// personnel-files storage bucket under <applicant_uuid>/offer_<ts>.html,
// returns a 1-hour signed URL.
//
// AUTH: caller must satisfy am_i_hr_or_admin().
//
// REQUEST BODY:
//   {
//     application_id:        uuid,    // job_applications.id
//     title:                 string,
//     target_role:           string,
//     employment_type:       'full_time'|'part_time'|'contractor'|'intern',
//     work_mode:             'onsite'|'hybrid'|'remote',
//     pay_type:              'hourly'|'salary'|'commission_only',
//     pay_period:            'hour'|'week'|'biweek'|'month'|'year',
//     pay_rate_cents:        int,
//     sign_on_bonus_cents?:  int,
//     start_date:            'YYYY-MM-DD',
//     location:              string,
//     manager_name:          string,
//     manager_title:         string,
//     custom_notes_md?:      string
//   }
//
// RESPONSE 200:
//   { ok:true, offer_id, html, storage_path, signed_url, policy_version }
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const err = (m: string, s = 400) => json({ ok: false, error: m }, s);

function esc(s: unknown): string {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]!));
}
function dollars(cents: number): string {
    return "$" + (Number(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function dateFmt(d: string): string {
    return new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}
function addDays(dateStr: string, days: number): string {
    const d = new Date(dateStr + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

function payDescription(pay_type: string, pay_period: string, pay_rate_cents: number): string {
    const amt = dollars(pay_rate_cents);
    const perMap: Record<string, string> = { hour: "per hour", week: "per week", biweek: "bi-weekly", month: "per month", year: "per year" };
    const per = perMap[pay_period] || pay_period;
    if (pay_type === "commission_only") return "Commission only (see Custom Notes for structure)";
    return `${amt} ${per}` + (pay_type === "salary" ? " (salaried)" : pay_type === "hourly" ? " (hourly)" : "");
}

serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST") return err("Method not allowed", 405);

    const SB_URL = Deno.env.get("SUPABASE_URL");
    const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!SB_URL || !SB_KEY) return err("Server config missing", 500);
    const supa = createClient(SB_URL, SB_KEY);

    // Auth
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) return err("Unauthorized", 401);
    const { data: userData, error: userErr } = await supa.auth.getUser(token);
    if (userErr || !userData?.user) return err("Invalid token", 401);
    const callerId = userData.user.id;

    // Authorization: HR or admin
    const userClient = createClient(SB_URL, SB_KEY, { global: { headers: { Authorization: `Bearer ${token}` } } });
    const { data: isAuthorized, error: authErr } = await userClient.rpc("am_i_hr_or_admin");
    if (authErr) return err("Auth check failed: " + authErr.message, 500);
    if (!isAuthorized) return err("Must be HR, compliance, or admin", 403);

    // Parse body
    let body: any;
    try { body = await req.json(); } catch { return err("Bad JSON"); }
    const required = ["application_id", "title", "employment_type", "pay_type", "pay_period", "pay_rate_cents", "start_date", "location", "manager_name"];
    for (const k of required) if (body[k] === undefined || body[k] === null || body[k] === "") return err("Missing " + k);

    // Pull application + applicant
    const { data: app, error: appErr } = await supa.from("job_applications")
        .select("id, first_name, last_name, email, applicant_profile_id, job_id")
        .eq("id", body.application_id).single();
    if (appErr || !app) return err("Application not found", 404);

    // Pull current benefits policy
    const { data: policy, error: pErr } = await supa.from("benefits_policy")
        .select("*").eq("is_current", true).single();
    if (pErr || !policy) return err("No current benefits policy — seed one first", 500);

    // Build full name for letter
    const candidateName = ((app.first_name || "") + " " + (app.last_name || "")).trim() || "Candidate";

    // Render HTML
    const today = new Date().toISOString().slice(0, 10);
    const html = renderOfferLetter({
        candidateName,
        candidateEmail: app.email,
        title: body.title,
        target_role: body.target_role || "staff",
        employment_type: body.employment_type,
        work_mode: body.work_mode || "hybrid",
        pay_type: body.pay_type,
        pay_period: body.pay_period,
        pay_rate_cents: Number(body.pay_rate_cents),
        sign_on_bonus_cents: Number(body.sign_on_bonus_cents || 0),
        start_date: body.start_date,
        location: body.location,
        manager_name: body.manager_name,
        manager_title: body.manager_title || "Founder & CEO",
        custom_notes_md: body.custom_notes_md || null,
        duties_md: body.duties_md || null,
        benefit_overrides: (body.benefit_overrides && typeof body.benefit_overrides === "object") ? body.benefit_overrides : {},
        policy,
        today,
    });

    // Upsert offers row (look for existing draft on this application first)
    const { data: existing } = await supa.from("offers")
        .select("id, status")
        .eq("application_id", app.id)
        .in("status", ["draft", "sent"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

    const offerPayload: Record<string, unknown> = {
        application_id: app.id,
        job_id: app.job_id,
        applicant_profile_id: app.applicant_profile_id,
        title: body.title,
        target_role: body.target_role || "staff",
        employment_type: body.employment_type,
        pay_type: body.pay_type,
        pay_rate_cents: Number(body.pay_rate_cents),
        pay_period: body.pay_period,
        sign_on_bonus_cents: Number(body.sign_on_bonus_cents || 0) || null,
        start_date: body.start_date,
        location: body.location,
        work_mode: body.work_mode || "hybrid",
        manager_title: (body.manager_title as string) || "Founder & CEO", // 2026-05-31 #53b65335 persist so Edit-terms restores it
        benefits_policy_id: policy.id,
        custom_notes_md: body.custom_notes_md || null,
        duties_md: body.duties_md || null,
        benefit_overrides: (body.benefit_overrides && typeof body.benefit_overrides === "object") ? body.benefit_overrides : {},
        offer_letter_html: html,
        status: existing?.status === "sent" ? "sent" : "draft",
    };

    let offerId: string;
    if (existing) {
        const { data: upd, error: uErr } = await supa.from("offers").update(offerPayload).eq("id", existing.id).select("id").single();
        if (uErr) return err("Offer update failed: " + uErr.message, 500);
        offerId = upd!.id;
    } else {
        const { data: ins, error: iErr } = await supa.from("offers").insert(offerPayload).select("id").single();
        if (iErr) return err("Offer insert failed: " + iErr.message, 500);
        offerId = ins!.id;
    }

    // Save to storage. Use applicant_profile_id if it exists, else application_id.
    const folder = app.applicant_profile_id || app.id;
    const fileName = `offer_${offerId}_${today}.html`;
    const storagePath = `${folder}/${fileName}`;
    const htmlBytes = new TextEncoder().encode(html);

    let signedUrl: string | null = null;
    let storageErrMsg: string | null = null;
    const up = await supa.storage.from("personnel-files").upload(storagePath, htmlBytes, {
        contentType: "text/html",
        upsert: true,
    });
    if (up.error) {
        storageErrMsg = up.error.message;
    } else {
        // Update offers.offer_letter_path
        await supa.from("offers").update({ offer_letter_path: storagePath }).eq("id", offerId);
        const signed = await supa.storage.from("personnel-files").createSignedUrl(storagePath, 60 * 60);
        signedUrl = signed.data?.signedUrl || null;
    }

    return json({
        ok: true,
        offer_id: offerId,
        html,
        storage_path: storageErrMsg ? null : storagePath,
        signed_url: signedUrl,
        policy_version: policy.version,
        ...(storageErrMsg ? { storage_warning: storageErrMsg } : {}),
    });
});

function renderOfferLetter(p: {
    candidateName: string;
    candidateEmail: string;
    title: string;
    target_role: string;
    employment_type: string;
    work_mode: string;
    pay_type: string;
    pay_period: string;
    pay_rate_cents: number;
    sign_on_bonus_cents: number;
    start_date: string;
    location: string;
    manager_name: string;
    manager_title: string;
    custom_notes_md: string | null;
    duties_md: string | null;
    benefit_overrides: Record<string, any>;
    policy: Record<string, any>;
    today: string;
}): string {
    const firstName = p.candidateName.split(/\s+/)[0] || "there";
    const empMap: Record<string, string> = { full_time: "Full-time", part_time: "Part-time", contractor: "Contractor (1099)", intern: "Intern" };
    const wmMap: Record<string, string> = { onsite: "Onsite", hybrid: "Hybrid", remote: "Remote" };
    const empLabel = empMap[p.employment_type] || p.employment_type;
    const wmLabel = wmMap[p.work_mode] || p.work_mode;

    const ptoDays = p.employment_type === "full_time" ? p.policy.pto_days_full_time : Math.round((p.policy.pto_days_full_time || 0) / 2);
    const sickDays = p.policy.sick_days_full_time || 5;
    const holidays: string[] = Array.isArray(p.policy.paid_holidays) ? p.policy.paid_holidays : [];
    // 2026-05-30 (S1d) per-offer benefit overrides — overseas hires drop US benefits.
    const ov = p.benefit_overrides || {};
    const effPto = (ov.pto_days != null) ? ov.pto_days : ptoDays;
    const effSick = (ov.sick_days != null) ? ov.sick_days : sickDays;
    const effWait = (ov.eligibility_wait_days != null) ? ov.eligibility_wait_days : p.policy.eligibility_wait_days;
    const effHealth = (typeof ov.offers_health === "boolean") ? ov.offers_health : p.policy.offers_health;
    const effRetire = (typeof ov.offers_retirement === "boolean") ? ov.offers_retirement : p.policy.offers_retirement;
    const showHolidays = ov.hide_holidays !== true;
    // 2026-05-31 #0/#15 — domestic vs overseas template. Overseas hires (working
    // outside the US) must NOT get the US-specific I-9 work-eligibility clause or
    // the Nevada at-will framing. is_overseas rides inside benefit_overrides so no
    // schema change is needed; the form sets it and Edit-terms restores it.
    const isOverseas = ov.is_overseas === true;
    const eligibilityClause = isOverseas
        ? "your providing documentation establishing your legal eligibility to work in your country of residence"
        : "your providing documentation establishing your eligibility to work in the United States (I-9)";
    const employmentLawLine = isOverseas
        ? "Your employment with LYMX Power, LLC is governed by the applicable employment laws of your country of residence."
        : "Your employment with LYMX Power, LLC is at-will under Nevada law, meaning either party may terminate the employment relationship at any time, with or without cause or notice.";
    const employmentHeading = isOverseas ? "Employment Terms" : "At-Will Employment (Nevada)";
    const holidayList = holidays.length
        ? '<ul style="margin:.25rem 0 .75rem 1.2rem;padding:0">' + holidays.map(h => `<li>${esc(h)}</li>`).join("") + "</ul>"
        : '<p style="margin:0;color:#6B7280;font-style:italic">No paid holidays defined yet.</p>';

    // 2026-06-01 feedback #da347aa6 / #0d02770f — make benefit ELIGIBILITY explicit
    // so candidates know WHO is eligible and WHEN benefits begin, instead of inferring
    // (one tester wrongly assumed a "1 year after probation" delay). Real policy:
    // eligibility begins after the probation period, full-time only, and some benefits
    // accrue/vest over time. All read from benefits_policy config — never hardcoded.
    const empEligMap: Record<string, string> = {
        full_time: "full-time employees only",
        part_time: "full-time and part-time employees",
        all: "all employees",
    };
    const eligWho = empEligMap[p.policy.eligibility_employment_type] || "full-time employees only";
    const eligNote = (p.policy.eligibility_note && String(p.policy.eligibility_note).trim())
        ? esc(p.policy.eligibility_note)
        : `Benefit eligibility begins after the ${effWait}-day probation period and applies to ${eligWho}. ` +
          `Reaching eligibility is the START of benefits — some benefits accrue or vest over time ` +
          `(for example, PTO accrues per the accrual method shown above), so they are earned gradually rather than all at once.`;

    const signOnLine = p.sign_on_bonus_cents > 0
        ? `<tr><td>Sign-on bonus</td><td>${dollars(p.sign_on_bonus_cents)} (paid on first regular pay date after start)</td></tr>`
        : "";

    const responseBy = dateFmt(addDays(p.today, 7));

    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Offer Letter — ${esc(p.candidateName)}</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;color:#0e1116;max-width:760px;margin:2rem auto;padding:0 2rem;line-height:1.55;font-size:11pt}
  h1{font-size:1.7rem;margin:0 0 .25rem;color:#0e1116;font-weight:800}
  h2{font-size:1.15rem;margin:1.25rem 0 .35rem;color:#0e1116;border-bottom:1px solid #e6e8ec;padding-bottom:.15rem;font-weight:700}
  .meta{color:#5b6472;font-size:.85rem;margin-bottom:1.25rem}
  .signature{margin-top:2.5rem}
  .sig-line{border-bottom:1px solid #0e1116;width:280px;height:1.2rem}
  table{border-collapse:collapse;margin:.25rem 0 .85rem}
  table td{padding:.25rem 1rem .25rem 0;font-size:.95rem;vertical-align:top}
  table td:first-child{font-weight:600;color:#475569;min-width:180px}
  .notes-box{background:#f6f7f9;border-left:4px solid #0e1116;padding:.75rem 1rem;border-radius:4px;margin:.5rem 0;font-size:.92rem;color:#475569}
  .policy-version{font-size:.75rem;color:#94a3b8;margin-top:2rem;border-top:1px solid #e6e8ec;padding-top:.5rem}
  .header-row{display:flex;justify-content:space-between;align-items:flex-start}
</style></head>
<body>

<div class="header-row">
  <div>
    <h1>LYMX Power, LLC</h1>
    <div class="meta">Las Vegas, Nevada · hr@lymxpower.com · getlymx.com</div>
  </div>
  <div style="text-align:right;font-size:.85rem;color:#475569">${dateFmt(p.today)}</div>
</div>

<p>Dear ${esc(firstName)},</p>

<p>On behalf of LYMX Power, LLC, I am pleased to extend you an offer of employment for the position of
<strong>${esc(p.title)}</strong>, effective <strong>${dateFmt(p.start_date)}</strong>. The details of your offer are below.</p>

<h2>Position &amp; Compensation</h2>
<table>
  <tr><td>Position</td><td>${esc(p.title)}</td></tr>
  <tr><td>Employment type</td><td>${esc(empLabel)}</td></tr>
  <tr><td>Work mode</td><td>${esc(wmLabel)}</td></tr>
  <tr><td>Location</td><td>${esc(p.location)}</td></tr>
  <tr><td>Start date</td><td>${dateFmt(p.start_date)}</td></tr>
  <tr><td>Compensation</td><td>${esc(payDescription(p.pay_type, p.pay_period, p.pay_rate_cents))}</td></tr>
  ${signOnLine}
  <tr><td>Reports to</td><td>${esc(p.manager_name)} (${esc(p.manager_title)})</td></tr>
</table>

${p.duties_md ? `<h2>Key Responsibilities</h2><div class="notes-box">${esc(p.duties_md).replace(/\n/g, "<br>")}</div>` : ""}

<h2>Paid Time Off (PTO)</h2>
<table>
  <tr><td>Vacation / PTO</td><td>${effPto} days per year (${esc((p.policy.pto_accrual_method || "lump_annual").replace(/_/g, " "))} accrual)</td></tr>
  <tr><td>Sick leave</td><td>${effSick} days per year</td></tr>
  <tr><td>Eligibility waiting period</td><td>${effWait}-day probation from your start date before benefits eligibility begins</td></tr>
</table>

<h2>Benefits Eligibility</h2>
<p style="font-size:.92rem;color:#475569">${eligNote}</p>

${showHolidays ? `<h2>Paid Holidays</h2>${holidayList}` : ""}

<h2>Health &amp; Retirement</h2>
<table>
  ${effHealth
        ? `<tr><td>Health insurance</td><td>${ov.health_note ? esc(ov.health_note) : `Offered after the ${effWait}-day waiting period.${p.policy.health_employee_share_pct ? " Employee share: " + Number(p.policy.health_employee_share_pct).toFixed(0) + "%." : ""}`}</td></tr>`
        : `<tr><td>Health insurance</td><td>${ov.health_note ? esc(ov.health_note) : "Not offered with this position."}</td></tr>`}
  ${effRetire
        ? '<tr><td>Retirement plan</td><td>Offered. Details available from HR after eligibility period.</td></tr>'
        : '<tr><td>Retirement plan</td><td>Not offered with this position.</td></tr>'}
</table>

${p.policy.notes ? `<h2>Additional Policy Terms</h2><div class="notes-box">${esc(p.policy.notes).replace(/\n/g, "<br>")}</div>` : ""}

${p.custom_notes_md ? `<h2>Specific Notes for This Offer</h2><div class="notes-box">${esc(p.custom_notes_md).replace(/\n/g, "<br>")}</div>` : ""}

<h2>${employmentHeading}</h2>
<p style="font-size:.92rem;color:#475569">${employmentLawLine} This offer is contingent upon (a) successful completion of any background check we may run, (b) verification of references, and (c) ${eligibilityClause}.</p>

<p>If you accept this offer, please sign below and return a copy to <strong>hr@lymxpower.com</strong> by ${responseBy}. We're excited about the opportunity to have you join the LYMX team.</p>

<p style="margin-top:1.5rem">Sincerely,</p>

<div class="signature">
  <div class="sig-line"></div>
  <div style="font-size:.85rem;color:#475569;margin-top:.25rem">${esc(p.manager_name)}, ${esc(p.manager_title)}<br>LYMX Power, LLC</div>
</div>

<div class="signature">
  <div class="sig-line"></div>
  <div style="font-size:.85rem;color:#475569;margin-top:.25rem">${esc(p.candidateName)} — Accepted on ___________________</div>
</div>

<p class="policy-version">Generated from Benefits Policy v${p.policy.version}, effective ${new Date(p.policy.effective_from).toLocaleDateString()}. The terms above reflect the current company-wide policy in effect at offer issuance.</p>

</body></html>`;
}
