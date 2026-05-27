// =============================================================================
// LYMX Power — Blast New Business To Locals
// =============================================================================
// POST /functions/v1/blast-new-business-to-locals
//
// When a business is approved in admin-business-applications.html, the admin
// page calls this EF (fire-and-forget). It:
//   1. Looks up the biz + its primary location ZIP.
//   2. Asks fn_local_customers_for_biz(business_id) for opt-in customers in
//      the same ZIP prefix (per-customer radius via local_merchant_radius_zip_digits).
//   3. Renders a "new local business" email (subject/html/text) from the biz
//      meta (display_name, category, address, slug, 4 highlight offers if any).
//   4. INSERTs a row into public.broadcasts (audience='custom', channel='email',
//      custom_emails=[...]) created_by = admin caller.
//   5. POSTs to /functions/v1/broadcast-send with { broadcast_id } to actually
//      send (re-using the locale-aware Resend pipeline + email_sends logging).
//   6. Stamps businesses.local_blast_sent_at + local_blast_broadcast_id +
//      local_blast_audience_size so future approve toggles are idempotent.
//
// REQUEST BODY:
//   { "business_id": "uuid",
//     "force": false (optional - bypass already-blasted guard, e.g. for retry) }
//
// AUTH: caller must be EITHER
//   (a) the biz owner (businesses.owner_user_id = jwt.sub), OR
//   (b) admin (staff_roles.role='admin') — for manual re-blasts.
// We don't gate on Kenny's hardcoded UUID anywhere (anti-pattern doc:
// feedback_lymx_hardcoded_admin_uuid_anti_pattern.md).
//
// RESPONSE (200):
//   { "success": true, "audience_size": 142, "broadcast_id": "uuid",
//     "skipped": false, "reason": "..." }
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
const errorResponse = (message: string, status = 400) => json({ error: message }, status);

function userFromJwt(authHeader: string | null): string | null {
    if (!authHeader) return null;
    const tok = authHeader.replace(/^Bearer\s+/i, "").trim();
    const parts = tok.split(".");
    if (parts.length !== 3) return null;
    try {
        const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
        return payload.sub || null;
    } catch {
        return null;
    }
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function renderEmail(opts: {
    biz_display_name: string;
    biz_category: string | null;
    biz_emoji: string | null;
    biz_tagline: string | null;
    biz_description: string | null;
    biz_address: string | null;
    biz_slug: string;
    offers: Array<{ title?: string; body?: string; badge?: string }>;
}): { subject: string; html: string; text: string } {
    const name = opts.biz_display_name;
    const safeName = escapeHtml(name);
    const cat = opts.biz_category ? escapeHtml(opts.biz_category) : "local business";
    const emoji = (opts.biz_emoji || "✨").slice(0, 4);
    const tagline = opts.biz_tagline ? escapeHtml(opts.biz_tagline) : "";
    const desc = opts.biz_description ? escapeHtml(opts.biz_description) : "";
    const addr = opts.biz_address ? escapeHtml(opts.biz_address) : "";
    const storefrontUrl = `https://getlymx.com/biz?slug=${encodeURIComponent(opts.biz_slug)}`;

    const offersBlock = (opts.offers || []).slice(0, 4).filter(o => o && (o.title || o.body)).map(o => {
        const t = o.title ? `<strong>${escapeHtml(o.title)}</strong>` : "";
        const b = o.body  ? `<span>${escapeHtml(o.body)}</span>`     : "";
        const sep = t && b ? " — " : "";
        return `<li style="margin:6px 0;line-height:1.5">${t}${sep}${b}</li>`;
    }).join("");

    const subject = `New on LYMX near you: ${name}${tagline ? ` — ${opts.biz_tagline}` : ""}`;

    const html = `<p>Hi,</p>

<p>A new local merchant just went live on LYMX in your area: <strong>${emoji} ${safeName}</strong>${cat ? ` <span style="color:#5b6472">· ${cat}</span>` : ""}.</p>

${tagline ? `<p style="font-size:16px;font-style:italic;color:#1a1f27;margin:10px 0">"${tagline}"</p>` : ""}

${desc ? `<p style="margin:10px 0 16px">${desc}</p>` : ""}

${offersBlock ? `<p style="margin:14px 0 6px"><strong>What they're offering right now:</strong></p>
<ul style="margin:0 0 16px 22px;padding:0">${offersBlock}</ul>` : ""}

<p style="margin:18px 0"><a href="${storefrontUrl}" style="display:inline-block;background:#0a84ff;color:#fff;padding:13px 24px;border-radius:9px;font-weight:700;text-decoration:none">See ${safeName} on LYMX →</a></p>

${addr ? `<p style="color:#5b6472;font-size:13px;margin:6px 0">📍 ${addr}</p>` : ""}

<p style="color:#5b6472;font-size:13px;margin-top:18px">You're getting this because you opted in to "Local merchant alerts" on your LYMX profile (we only email when a new merchant matches your home ZIP area). To turn these off any time, visit <a href="https://getlymx.com/profile.html">your profile</a>.</p>`;

    // Plain-text fallback — translation pipeline in broadcast-send uses this
    // as the source for non-English locales, then re-wraps to HTML.
    const text = [
        `New on LYMX near you: ${name}`,
        cat ? `Category: ${cat}` : "",
        tagline ? `"${tagline}"` : "",
        desc || "",
        opts.offers && opts.offers.length ? "" : "",
        opts.offers && opts.offers.length ? "What they're offering right now:" : "",
        ...(opts.offers || []).slice(0, 4).map(o => `- ${o.title || ""}${o.title && o.body ? " — " : ""}${o.body || ""}`),
        "",
        `See them on LYMX: ${storefrontUrl}`,
        addr ? `Address: ${addr}` : "",
        "",
        "You're getting this because you opted in to Local merchant alerts. Turn off in your profile: https://getlymx.com/profile.html",
    ].filter(Boolean).join("\n");

    return { subject, html, text };
}

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST") return errorResponse("Method not allowed", 405);

    // ---- Admin auth ---------------------------------------------------------
    const userId = userFromJwt(req.headers.get("Authorization"));
    if (!userId) return errorResponse("Sign in required.", 401);

    // ---- Parse body ---------------------------------------------------------
    let body: any;
    try { body = await req.json(); } catch { return errorResponse("Invalid JSON.", 400); }
    const businessId = (body && body.business_id) as string | undefined;
    const force = !!(body && body.force);
    if (!businessId) return errorResponse("Missing business_id.", 400);

    // ---- Service-role client -----------------------------------------------
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SVC_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(SUPABASE_URL, SVC_KEY);

    // ---- Load business first (so we can do owner-or-admin gate) ------------
    const { data: biz, error: bizErr } = await supabase
        .from("businesses")
        .select("id, slug, display_name, legal_name, category, contact_email, current_promos, demo_only, approval_status, owner_user_id, local_blast_sent_at, local_blast_broadcast_id, local_blast_audience_size")
        .eq("id", businessId)
        .single();

    if (bizErr || !biz) return errorResponse(`Business not found: ${bizErr?.message || ""}`, 404);

    // Gate: owner of THIS biz, OR admin. Either is sufficient.
    let isOwner = biz.owner_user_id === userId;
    let isAdmin = false;
    if (!isOwner) {
        const { data: staff, error: staffErr } = await supabase.from("staff_roles")
            .select("role").eq("user_id", userId).maybeSingle();
        if (staffErr) {
            console.warn(`[blast-new-business-to-locals] staff_roles lookup failed for user ${userId}:`, staffErr.message);
            return errorResponse("Auth check failed. Please try again.", 503);
        }
        isAdmin = !!(staff && staff.role === "admin");
    }
    if (!isOwner && !isAdmin) {
        return errorResponse("Only the business owner or an admin can fire this blast.", 403);
    }

    // 'force' (re-blast bypass) is admin-only — owners can only fire once.
    if (force && !isAdmin) {
        return errorResponse("Only admin can re-fire a blast (force:true).", 403);
    }

    // Refuse to blast for demo or non-approved rows — silently skip.
    if (biz.demo_only) {
        return json({ success: true, skipped: true, reason: "demo_only business — no blast" });
    }
    if (biz.approval_status !== "approved") {
        return json({ success: true, skipped: true, reason: `approval_status=${biz.approval_status} — not approved yet` });
    }
    if (biz.local_blast_sent_at && !force) {
        return json({
            success: true,
            skipped: true,
            reason: "already blasted on " + biz.local_blast_sent_at + " (pass force:true to re-send)",
            audience_size: biz.local_blast_audience_size,
            broadcast_id: biz.local_blast_broadcast_id,
        });
    }

    // ---- Minimum-content gate ----------------------------------------------
    // Prevent a "look at us!" email landing on a totally empty page. We need
    // at least ONE of: a meaningful description (>=40 chars) / a tagline /
    // 1+ photos / 1+ current offers / 3+ menu items. Owners hit this when
    // they click Publish before actually editing anything — surface a clear
    // 422 the UI can turn into "Fill in your page first".
    const promosArr = Array.isArray(biz.current_promos) ? (biz.current_promos as any[]) : [];
    const nonEmptyPromos = promosArr.filter(p => p && (p.title || p.body));
    const { data: storefrontMeta } = await supabase.rpc("fn_biz_public_meta", { p_slug: biz.slug });
    const sf = (storefrontMeta && storefrontMeta[0]) || {} as any;
    const hasDesc    = (sf.description || "").trim().length >= 40;
    const hasTagline = (sf.tagline || "").trim().length >= 6;
    const { count: photoCount } = await supabase
        .from("business_photos")
        .select("id", { count: "exact", head: true })
        .eq("business_id", businessId)
        .is("archived_at", null);
    const { count: menuCount } = await supabase
        .from("business_menu_items")
        .select("id", { count: "exact", head: true })
        .eq("business_id", businessId)
        .eq("available", true)
        .is("archived_at", null);
    const hasPhotos = (photoCount || 0) >= 1;
    const hasMenu   = (menuCount  || 0) >= 3;
    const hasOffers = nonEmptyPromos.length >= 1;

    if (!hasDesc && !hasTagline && !hasPhotos && !hasOffers && !hasMenu) {
        return json({
            success: false,
            error: "Your storefront looks empty. Add at least one of: a description (40+ chars), a tagline, one photo, one offer, or three menu items — then try again.",
            details: {
                has_description: hasDesc,
                has_tagline: hasTagline,
                photo_count: photoCount || 0,
                menu_count: menuCount || 0,
                offer_count: nonEmptyPromos.length,
            },
        }, 422);
    }

    // ---- Resolve audience via fn_local_customers_for_biz --------------------
    const { data: audRows, error: audErr } = await supabase.rpc("fn_local_customers_for_biz", {
        p_business_id: businessId,
    });
    if (audErr) return errorResponse(`Audience lookup failed: ${audErr.message}`, 500);

    const emails = Array.from(new Set(
        (audRows || [])
            .map((r: any) => (r.email || "").trim().toLowerCase())
            .filter((e: string) => /\S+@\S+\.\S+/.test(e))
    ));

    if (emails.length === 0) {
        // Stamp the row so we don't keep trying. v1 behaviour: a biz with no
        // local customers still counts as "blasted" (audience_size=0). If
        // population grows later, admin can pass force:true to retry.
        await supabase.from("businesses").update({
            local_blast_sent_at: new Date().toISOString(),
            local_blast_audience_size: 0,
        }).eq("id", businessId);
        return json({
            success: true,
            audience_size: 0,
            skipped: false,
            reason: "no opt-in customers in zip prefix",
        });
    }

    // ---- Storefront meta (for email body) -----------------------------------
    // fn_biz_public_meta is SECURITY DEFINER and returns the same shape that
    // biz.html consumes — keeps the email and the storefront in sync. Reuse
    // the storefront-meta lookup we already did for the minimum-content gate.
    const meta = sf as any;

    // Primary location address (one line) for the email footer
    let addressLine: string | null = null;
    try {
        const { data: loc } = await supabase
            .from("business_locations")
            .select("street, city, state, zip, is_primary, created_at")
            .eq("business_id", businessId)
            .order("is_primary", { ascending: false })
            .order("created_at", { ascending: true })
            .limit(1)
            .maybeSingle();
        if (loc) {
            addressLine = [loc.street, loc.city, loc.state, loc.zip].filter(Boolean).join(", ");
        }
    } catch { /* ignore — address is optional */ }

    // ---- Render email -------------------------------------------------------
    const rendered = renderEmail({
        biz_display_name: biz.display_name || biz.legal_name || "A new LYMX merchant",
        biz_category: biz.category || meta.category || null,
        biz_emoji: (meta && (meta as any).emoji) || null,
        biz_tagline: (meta && (meta as any).tagline) || null,
        biz_description: (meta && (meta as any).description) || null,
        biz_address: addressLine,
        biz_slug: biz.slug,
        offers: Array.isArray(biz.current_promos) ? (biz.current_promos as any[]) : [],
    });

    // ---- Insert broadcast row -----------------------------------------------
    const { data: bcRow, error: bcErr } = await supabase
        .from("broadcasts")
        .insert({
            audience: "custom",
            custom_emails: emails,
            channel: "email",
            subject: rendered.subject,
            body_html: rendered.html,
            body_text: rendered.text,
            status: "draft",
            created_by: userId,
        })
        .select("id")
        .single();

    if (bcErr || !bcRow) return errorResponse(`Broadcast insert failed: ${bcErr?.message || ""}`, 500);
    const broadcastId = bcRow.id as string;

    // ---- Fire broadcast-send (forward the caller's bearer so it runs as admin)
    const sendRes = await fetch(SUPABASE_URL + "/functions/v1/broadcast-send", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": req.headers.get("Authorization") || `Bearer ${SVC_KEY}`,
            "apikey": SVC_KEY,
        },
        body: JSON.stringify({ broadcast_id: broadcastId }),
    });
    let sendJson: any = {};
    try { sendJson = await sendRes.json(); } catch { /* */ }

    // ---- Stamp business + return -------------------------------------------
    await supabase.from("businesses").update({
        local_blast_sent_at: new Date().toISOString(),
        local_blast_broadcast_id: broadcastId,
        local_blast_audience_size: emails.length,
    }).eq("id", businessId);

    return json({
        success: true,
        audience_size: emails.length,
        broadcast_id: broadcastId,
        sent_count: sendJson?.sent_count ?? null,
        send_status: sendRes.status,
        send_errors: (sendJson?.errors || []).slice(0, 3),
    });
});
