// =============================================================================
// LYMX Power — Business Sign-up Endpoint
// =============================================================================
// POST /functions/v1/business-signup
//
// Creates a new business + (optional) primary location + subscription
// (3-month trial). Optionally attributes the sign-up to a partner.
//
// REQUEST BODY (discriminated union — `kind` selects the shape):
//
//   ── Mode 1: Storefront ────────────────────────────────────────────────
//   {
//     "kind": "storefront",
//     "owner_email": "owner@example.com",
//     "owner_password": "min10chars",
//     "legal_name": "Brew & Bean LLC",
//     "display_name": "Brew & Bean",
//     "category": "cafe",
//     "contact_email": "hello@brewandbean.com",
//     "contact_phone": "+17025551234",
//     "issuance_rate": 5,            // optional, defaults to schema default
//     "location": {                  // required for storefront
//       "name": "Main Street",
//       "street": "123 Main St",
//       "city": "Las Vegas", "state": "NV", "zip": "89101"
//     },
//     "partner_referral_code": "PARTNER-XYZ"   // optional
//   }
//
//   ── Mode 3: Self-employed professional ────────────────────────────────
//   {
//     "kind": "self_employed",
//     "owner_email": "...",  "owner_password": "...",
//     "legal_name": "Jane Doe Consulting",
//     "display_name": "Jane Doe",
//     "category": "consulting",
//     "contact_email": "...",  "contact_phone": "...",
//     "service_area": "Clark County, NV",   // optional, free text
//     "services": [                          // required, >= 1 row
//       { "service_name": "60-min consult", "price_usd": 150, "lymx_per_booking": 1500 },
//       { "service_name": "Project audit",  "price_usd": 500, "lymx_per_booking": 5000 }
//     ],
//     "partner_referral_code": "PARTNER-XYZ"   // optional
//   }
//
//   ── Legacy (no `kind`) ────────────────────────────────────────────────
//   Treated as Mode 1 storefront. Backwards-compatible with existing callers.
//
// RESPONSE (201):
// {
//   "user_id": "uuid",
//   "business_id": "uuid",
//   "location_id": "uuid" | null,
//   "subscription_id": "uuid",
//   "service_ids": ["uuid", ...]   // only for self_employed
// }
//
// IMPORTANT: This function uses service_role to bypass RLS, because we need
// to create rows BEFORE the user is signed in.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

// --- CORS + response helpers (inlined for web-editor deployment) -----------
const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
const errorResponse = (message: string, status = 400) =>
    jsonResponse({ error: message }, status);

// --- Body shapes -----------------------------------------------------------
interface CommonFields {
    owner_email: string;
    owner_password: string;
    legal_name: string;
    display_name: string;
    category?: string;
    contact_email: string;
    contact_phone?: string;
    partner_referral_code?: string;
}

interface StorefrontBody extends CommonFields {
    kind?: "storefront";
    issuance_rate?: number;
    location: {
        name: string;
        street?: string;
        city?: string;
        state?: string;
        zip?: string;
    };
}

interface SelfEmployedBody extends CommonFields {
    kind: "self_employed";
    service_area?: string;
    services: Array<{
        service_name: string;
        description?: string;
        price_usd?: number;
        lymx_per_booking: number;
        sort_order?: number;
    }>;
}

type SignupBody = StorefrontBody | SelfEmployedBody;

// --- Validators ------------------------------------------------------------
const COMMON_REQUIRED = [
    "owner_email",
    "owner_password",
    "legal_name",
    "display_name",
    "contact_email",
] as const;

function validateCommon(body: SignupBody): string | null {
    for (const k of COMMON_REQUIRED) {
        const v = (body as Record<string, unknown>)[k];
        if (v == null || v === "") return `Missing required field: ${k}`;
    }
    if (typeof body.owner_password === "string" && body.owner_password.length < 10) {
        return "owner_password must be at least 10 characters";
    }
    return null;
}

function validateStorefront(body: StorefrontBody): string | null {
    if (!body.location) return "Missing required field: location";
    if (!body.location.name) return "location.name is required";
    if (body.issuance_rate != null && body.issuance_rate < 0) {
        return "issuance_rate must be non-negative";
    }
    return null;
}

function validateSelfEmployed(body: SelfEmployedBody): string | null {
    if (!Array.isArray(body.services) || body.services.length === 0) {
        return "self_employed signup requires services: [...] with at least 1 row";
    }
    for (let i = 0; i < body.services.length; i++) {
        const s = body.services[i];
        if (!s.service_name) return `services[${i}].service_name is required`;
        if (typeof s.lymx_per_booking !== "number" || s.lymx_per_booking < 0) {
            return `services[${i}].lymx_per_booking must be a non-negative number`;
        }
        if (s.price_usd != null && s.price_usd < 0) {
            return `services[${i}].price_usd must be non-negative`;
        }
    }
    return null;
}

// --- Main handler ----------------------------------------------------------
serve(async (req) => {
    // CORS preflight
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }
    if (req.method !== "POST") {
        return errorResponse("Method not allowed", 405);
    }

    let body: SignupBody;
    try {
        body = await req.json();
    } catch {
        return errorResponse("Invalid JSON", 400);
    }

    // Default kind = 'storefront' for backwards compatibility
    const kind = body.kind ?? "storefront";

    // Module 1 (migration 093): optional invite_token from biz-signup.html?invite_token=…
    // If present, we link the new businesses row to the invitation row at the
    // very end of the flow (just before the final response) so the link only
    // happens when everything else succeeded.
    const invite_token = typeof body.invite_token === "string" && body.invite_token.length >= 16
        ? body.invite_token
        : null;
    if (kind !== "storefront" && kind !== "self_employed") {
        return errorResponse(
            `Unsupported kind: ${kind}. Use 'storefront' or 'self_employed'.`,
            400,
        );
    }

    const commonErr = validateCommon(body);
    if (commonErr) return errorResponse(commonErr, 400);

    const modeErr = kind === "storefront"
        ? validateStorefront(body as StorefrontBody)
        : validateSelfEmployed(body as SelfEmployedBody);
    if (modeErr) return errorResponse(modeErr, 400);

    // Service-role client — bypasses RLS
    const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        { auth: { persistSession: false } }
    );

    // ── Step 1: create the auth user ───────────────────────────────────────
    const { data: userData, error: userErr } = await supabase.auth.admin
        .createUser({
            email: body.owner_email,
            password: body.owner_password,
            email_confirm: true,
            user_metadata: { role: "business_owner", business_kind: kind },
        });

    if (userErr || !userData.user) {
        return errorResponse(`Auth creation failed: ${userErr?.message}`, 400);
    }
    const userId = userData.user.id;

    // ── Step 2: resolve partner_referral_code → partner_id ────────────────
    // Accept either a friendly P-NNNNNN partner code OR a raw UUID. Partners
    // share friendly codes; UUID is internal-only.
    let signedUpByPartnerId: string | null = null;
    if (body.partner_referral_code) {
        const ref = String(body.partner_referral_code).trim();
        // P-NNNNNN format (case-insensitive, with or without dash)
        if (/^P-?\d{4,8}$/i.test(ref)) {
            const normalized = ref.toUpperCase().replace(/^P-?/, 'P-');
            const { data: p } = await supabase
                .from("partners").select("id")
                .eq("partner_code", normalized)
                .maybeSingle();
            if (p) signedUpByPartnerId = p.id;
        }
        // Fallback: raw UUID match
        if (!signedUpByPartnerId && /^[0-9a-f-]{36}$/i.test(ref)) {
            const { data: p } = await supabase
                .from("partners").select("id")
                .eq("id", ref)
                .maybeSingle();
            if (p) signedUpByPartnerId = p.id;
        }
        if (!signedUpByPartnerId) {
            console.warn("Partner referral code not found:", ref);
        }
    }

    // ── Step 3: create the business ────────────────────────────────────────
    const bizInsert: Record<string, unknown> = {
        legal_name: body.legal_name,
        display_name: body.display_name,
        category: body.category ?? null,
        contact_email: body.contact_email,
        contact_phone: body.contact_phone ?? null,
        owner_user_id: userId,
        signed_up_by_partner_id: signedUpByPartnerId,
        business_kind: kind,
    };
    if (kind === "storefront" && (body as StorefrontBody).issuance_rate != null) {
        bizInsert.issuance_rate = (body as StorefrontBody).issuance_rate;
    }

    // 2026-05-24 audit fix — persist the new legal/tax/operations intake
    // fields from the expanded biz-signup form. Each field is optional
    // (NULL allowed at the schema level via migration 078) so legacy
    // payloads without `intake` still go through.
    const intake = (body as Record<string, unknown>).intake as Record<string, unknown> | undefined;
    if (intake && typeof intake === "object") {
        if (typeof intake.entity_type             === "string" && intake.entity_type)             bizInsert.entity_type             = intake.entity_type;
        if (typeof intake.incorporation_state     === "string" && intake.incorporation_state)     bizInsert.incorporation_state     = intake.incorporation_state;
        if (typeof intake.ein                     === "string" && intake.ein)                     bizInsert.ein                     = intake.ein;
        if (typeof intake.business_license_number === "string" && intake.business_license_number) bizInsert.business_license_number = intake.business_license_number;
        if (typeof intake.year_founded            === "number" && Number.isFinite(intake.year_founded as number)) bizInsert.year_founded = intake.year_founded;
        if (typeof intake.employee_count_range    === "string" && intake.employee_count_range)    bizInsert.employee_count_range    = intake.employee_count_range;
        if (typeof intake.website                 === "string" && intake.website)                 bizInsert.website                 = intake.website;
        if (intake.operating_hours && typeof intake.operating_hours === "object") {
            bizInsert.operating_hours = intake.operating_hours;
        }
        // Mark the intake as complete once we have at least entity_type OR
        // ein OR business_license_number — i.e. the form actually collected
        // tax/legal info, not just defaults.
        if (intake.entity_type || intake.ein || intake.business_license_number) {
            bizInsert.intake_completed_at = new Date().toISOString();
        }
    }

    const { data: biz, error: bizErr } = await supabase
        .from("businesses")
        .insert(bizInsert)
        .select("id")
        .single();

    if (bizErr || !biz) {
        await supabase.auth.admin.deleteUser(userId);
        return errorResponse(`Business creation failed: ${bizErr?.message}`, 500);
    }

    // ── Step 4: create the primary location (storefront only) ──────────────
    let locationId: string | null = null;
    if (kind === "storefront") {
        const loc = (body as StorefrontBody).location;
        const { data: locRow, error: locErr } = await supabase
            .from("business_locations")
            .insert({
                business_id: biz.id,
                name: loc.name,
                street: loc.street ?? null,
                city: loc.city ?? null,
                state: loc.state ?? null,
                zip: loc.zip ?? null,
                is_primary: true,
            })
            .select("id")
            .single();

        if (locErr || !locRow) {
            await supabase.from("businesses").delete().eq("id", biz.id);
            await supabase.auth.admin.deleteUser(userId);
            return errorResponse(`Location creation failed: ${locErr?.message}`, 500);
        }
        locationId = locRow.id;
    }

    // ── Step 4b: create custom services (self_employed only) ───────────────
    let serviceIds: string[] = [];
    if (kind === "self_employed") {
        const sb = body as SelfEmployedBody;
        const rows = sb.services.map((s, i) => ({
            business_id: biz.id,
            service_name: s.service_name,
            description: s.description ?? null,
            price_usd: s.price_usd ?? null,
            lymx_per_booking: s.lymx_per_booking,
            sort_order: s.sort_order ?? i,
        }));
        const { data: svcRows, error: svcErr } = await supabase
            .from("business_custom_services")
            .insert(rows)
            .select("id");

        if (svcErr || !svcRows) {
            await supabase.from("businesses").delete().eq("id", biz.id);
            await supabase.auth.admin.deleteUser(userId);
            return errorResponse(
                `Custom services creation failed: ${svcErr?.message}`,
                500,
            );
        }
        serviceIds = svcRows.map((r) => r.id);
    }

    // ── Step 5: create the subscription (3-month trial) ───────────────────
    const trialEnd = new Date();
    trialEnd.setMonth(trialEnd.getMonth() + 3);
    const { data: sub, error: subErr } = await supabase
        .from("business_subscriptions")
        .insert({
            business_id: biz.id,
            plan: "standard",
            status: "trialing",
            monthly_amount: 199,
            trial_ends_at: trialEnd.toISOString(),
            current_period_start: new Date().toISOString(),
            current_period_end: trialEnd.toISOString(),
        })
        .select("id")
        .single();

    if (subErr || !sub) {
        // Don't roll back — biz + (location|services) are valid; sub can be retried
        console.error("Subscription creation failed:", subErr);
    }

    // ── Step 6: log $500 sign-up bonus if a partner referred them ─────────
    if (signedUpByPartnerId) {
        const { error: commErr } = await supabase
            .from("partner_commissions")
            .insert({
                partner_id: signedUpByPartnerId,
                source_business_id: biz.id,
                type: "signup_bonus",
                generation: 1,
                amount: 500,
            });
        if (commErr) {
            console.error("Partner commission log failed:", commErr);
        }

        // 2026-05-20 #8ae35834 — Notify the sponsor partner via email so they
        // know their referral converted. Non-blocking: failure here does NOT
        // roll back the business signup. Helen/Rachel get an immediate ding
        // in their inbox the moment a prospect signs up using their code.
        try {
            const { data: sponsor } = await supabase
                .from("partners")
                .select("legal_name, display_name, contact_email, partner_code")
                .eq("id", signedUpByPartnerId)
                .maybeSingle();
            if (sponsor && sponsor.contact_email) {
                const firstName = (sponsor.display_name || sponsor.legal_name || "Partner").split(/\s+/)[0];
                const bizName = body.display_name || body.legal_name || "a Business";
                const subj = `🎉 ${bizName} just signed up using your referral code`;
                const bodyText = `Hi ${firstName},

Quick news — ${bizName} just submitted their LYMX Business signup using your referral code (${sponsor.partner_code || ""}).

That means a $500 activation bonus is pending verification on your account. As soon as admin approves their application, the bonus posts to your commission ledger.

You can see this activation on your Partner Dashboard:
https://getlymx.com/rep-dashboard.html#myActivationsCard

If they back out before verification you won't see the bonus — but most Businesses that submit the form complete the process. Keep the momentum going.

— The LYMX team`;
                await fetch(Deno.env.get("SUPABASE_URL") + "/functions/v1/send-email", {
                    method: "POST",
                    headers: {
                        "Authorization": "Bearer " + Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        recipient_email: sponsor.contact_email,
                        subject: subj,
                        body_text: bodyText,
                        kind: "partner_referral_activation",
                        channel: "transactional",
                    }),
                });
            }
        } catch (notifyErr) {
            console.warn("Partner referral notification failed (non-fatal):", (notifyErr as Error).message);
        }
    }

    // ─── New-Business welcome bonus (10,000 LYMX, configurable) ─────────────
    // Fires a separate LYMX issuance for the business owner. Amount comes from
    // platform_promos.new_business_signup_bonus so Kenny can change it via SQL.
    let welcomeBonus = null;
    try {
        const { data: promoAmt } = await supabase.rpc("get_active_promo_amount", { p_key: "new_business_signup_bonus" });
        const bonusAmount = Number(promoAmt) || 0;
        if (bonusAmount > 0) {
            const idem = "new_business_bonus_" + biz.id;
            const { data: bonusRow, error: bonusErr } = await supabase
                .from("lymx_issuances")
                .insert({
                    recipient_user_id: userId,
                    business_id: null,                     // null = platform-issued, fraud guard skips
                    amount_lymx: bonusAmount,
                    reason: "promo",
                    lymx_cost_cents: bonusAmount,          // LYMX absorbs the cost (CAC)
                    business_cost_cents: 0,
                    transaction_method: "signup",
                    verified: true,
                    idempotency_key: idem,
                    user_agent: "business-signup-fn",
                })
                .select()
                .single();
            if (bonusErr) {
                console.warn("New-business bonus issuance failed (non-fatal):", bonusErr.message);
            } else {
                welcomeBonus = { issuance_id: bonusRow.id, amount_lymx: bonusAmount };
            }
        }
    } catch (e) {
        console.warn("New-business bonus error (non-fatal):", e.message);
    }
    // ────────────────────────────────────────────────────────────────────────

    // ─── Business welcome email (#b8472a66) ────────────────────────────────
    // Fire-and-forget; don't block the response on email send.
    try {
        const recipientEmail = body.owner_email;
        const displayName = body.display_name || body.legal_name || 'there';
        const dashboardUrl = `https://getlymx.com/biz-dashboard.html`;
        const welcomeHtml = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#0e1116;line-height:1.55">
  <h2 style="margin:0 0 12px;font-size:22px">Welcome to LYMX, ${escapeHtml(displayName)}!</h2>
  <p>Thanks for signing up your business. Your application has been received and is being reviewed by our team. We typically approve new businesses within 24 hours.</p>
  ${welcomeBonus ? `<p style="background:#e6f5ee;border-left:4px solid #13a26b;padding:12px 16px;border-radius:6px"><strong>🎉 ${welcomeBonus.amount_lymx.toLocaleString()} LYMX</strong> welcome bonus credited to your account.</p>` : ''}
  <h3 style="margin:18px 0 8px;font-size:16px">What happens next:</h3>
  <ul>
    <li>Our team verifies your business details (usually within 24 hours)</li>
    <li>You'll get a second email when your listing goes live on getlymx.com</li>
    <li>Then you can sign in and start setting up your LYMX issuance settings</li>
  </ul>
  <p style="margin-top:20px"><a href="${dashboardUrl}" style="display:inline-block;background:#0e1116;color:#fff;padding:11px 22px;border-radius:9px;text-decoration:none;font-weight:700">Open your business dashboard →</a></p>
  <p style="margin-top:24px;color:#5b6472;font-size:13.5px">Questions? Reply to this email or use the floating Help & Feedback button on any page on getlymx.com.</p>
  <p style="margin-top:18px;color:#5b6472;font-size:13.5px">— The LYMX team</p>
</div>`;
        const welcomeText = `Welcome to LYMX, ${displayName}!\n\nThanks for signing up your business. Your application is being reviewed - we typically approve new businesses within 24 hours.\n${welcomeBonus ? `\n${welcomeBonus.amount_lymx.toLocaleString()} LYMX welcome bonus credited to your account.\n` : ''}\nWhat happens next:\n- Our team verifies your business details (within 24h)\n- You'll get a second email when your listing goes live\n- Then sign in to set up your issuance settings\n\nDashboard: ${dashboardUrl}\n\nQuestions? Reply or use Help & Feedback on getlymx.com\n\n- The LYMX team`;
        // Fire the email via send-email EF using service-role key (server-to-server)
        const sbUrl = Deno.env.get("SUPABASE_URL")!;
        const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        await fetch(sbUrl + '/functions/v1/send-email', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + sbKey,
                'apikey': sbKey,
            },
            body: JSON.stringify({
                channel: 'transactional',
                recipient_email: recipientEmail,
                recipient_name: displayName,
                subject: `Welcome to LYMX, ${displayName} - your application is being reviewed`,
                body_text: welcomeText,
                body_html: welcomeHtml,
                template_key: 'business_welcome',
            }),
        });
    } catch (welcomeEmailErr) {
        console.warn('Business welcome email send failed (non-fatal):', welcomeEmailErr);
    }

    // ─── Admin notification (audit fix 2026-05-24) ──────────────────────────
    // Previously NO admin / team member got pinged when a new biz signed up.
    // Susan's launch batch + future signups would land in admin-business-
    // applications.html silently and Kenny would have to remember to check.
    // Now we fan out a notification to every admin staff member so someone
    // approves the application within the SLA we promise (24 hours).
    try {
        const sbUrl = Deno.env.get("SUPABASE_URL")!;
        const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        // Pull every active staff_roles user we have an auth email for.
        const { data: staffRows } = await supabase
            .from("staff_roles")
            .select("user_id");
        const adminUserIds = (staffRows || []).map((r) => (r as { user_id: string }).user_id).filter(Boolean);
        const adminEmails: string[] = [];
        for (const uid of adminUserIds) {
            try {
                const { data: u } = await supabase.auth.admin.getUserById(uid);
                if (u?.user?.email) adminEmails.push(u.user.email);
            } catch (_) { /* skip missing */ }
        }
        // Belt + suspenders: include the canonical hello@ inbox so the
        // notification still lands even if staff_roles is empty.
        if (!adminEmails.includes("hello@getlymx.com")) {
            adminEmails.push("hello@getlymx.com");
        }
        const bizLabel = body.display_name || body.legal_name || "A new Business";
        const ownerLabel = body.owner_name || body.owner_email;
        const refLabel = signedUpByPartnerId
            ? ` via partner referral`
            : ` (direct signup, no partner)`;
        const subj = `🆕 ${bizLabel} just signed up — pending approval`;
        const text = `${bizLabel} (${kind}) just submitted a LYMX Business signup${refLabel}.

` +
            `Owner: ${ownerLabel}
` +
            `Owner email: ${body.owner_email}
` +
            `Contact email: ${body.contact_email}
` +
            `Category: ${body.category || "(none)"}
` +
            `Business ID: ${biz.id}

` +
            `Approve or reject here: https://getlymx.com/admin-business-applications.html?id=${biz.id}

` +
            `— LYMX automatic notification`;
        for (const to of adminEmails) {
            try {
                await fetch(sbUrl + "/functions/v1/send-email", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": "Bearer " + sbKey,
                        "apikey": sbKey,
                    },
                    body: JSON.stringify({
                        recipient_email: to,
                        subject: subj,
                        body_text: text,
                        kind: "biz_signup_admin_alert",
                        channel: "transactional",
                        related_id: biz.id,
                    }),
                });
            } catch (_) { /* per-recipient failure is non-fatal */ }
        }
    } catch (adminAlertErr) {
        console.warn("Admin notification fan-out failed (non-fatal):", adminAlertErr);
    }

    // Link the invitation row (Module 1, migration 093) — service-role RPC
    let invitation_linked: { linked: boolean; reason?: string; assigned_partner_id?: string | null } | null = null;
    if (invite_token) {
        try {
            const { data: linkResult, error: linkErr } = await supabase.rpc(
                "fn_link_invitation_to_business",
                { p_token: invite_token, p_business_id: biz.id }
            );
            if (linkErr) {
                console.warn("[business-signup] fn_link_invitation_to_business failed", linkErr);
            } else {
                invitation_linked = linkResult as any;
            }
        } catch (e) {
            console.warn("[business-signup] invitation link threw", e);
        }
    }

    return jsonResponse({
        user_id: userId,
        business_id: biz.id,
        location_id: locationId,
        subscription_id: sub?.id ?? null,
        service_ids: serviceIds,
        kind,
        welcome_bonus: welcomeBonus,
        invitation_linked,
    }, 201);
});

function escapeHtml(s: string): string {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c] as string));
}
