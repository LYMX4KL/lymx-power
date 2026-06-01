// =============================================================================
// LYMX Power — Stripe Webhook Receiver
// =============================================================================
// POST /functions/v1/stripe-webhook
//
// Stripe POSTs events here. The endpoint must be public (no auth) but verifies
// the signature header `Stripe-Signature` against a shared secret.
//
// Events we care about (v1):
//   * account.updated         — sync stripe_charges_enabled / payouts_enabled / details_submitted
//   * account.application.deauthorized — clear the business's stripe_connect_account_id
//   * invoice.paid            — log successful subscription / metered charges
//   * invoice.payment_failed  — flag the business as past_due
//
// REQUIRED SUPABASE SECRETS:
//   STRIPE_WEBHOOK_SECRET     — the whsec_... value from your Stripe Connect webhook endpoint
//
// CONFIGURE IN STRIPE DASHBOARD:
//   Developers -> Webhooks -> Add endpoint
//   URL:    https://apffootxzfwmtyjlnteo.supabase.co/functions/v1/stripe-webhook
//   Listen: Connect events (account.updated, account.application.deauthorized)
//           + invoice.paid, invoice.payment_failed
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "stripe-signature, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

// Verify Stripe webhook signature (HMAC-SHA256 of `${timestamp}.${payload}` with whsec_... as key)
async function verifyStripeSignature(payload: string, signatureHeader: string, secret: string): Promise<boolean> {
    const parts = signatureHeader.split(",").map(p => p.split("="));
    const t = parts.find(([k]) => k === "t")?.[1];
    const v1 = parts.find(([k]) => k === "v1")?.[1];
    if (!t || !v1) return false;
    const signedPayload = `${t}.${payload}`;
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
    const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
    // Allow up to 5 min clock skew
    const age = Math.abs(Math.floor(Date.now() / 1000) - parseInt(t, 10));
    if (age > 300) return false;
    return hex === v1;
}

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

    const SB_URL = Deno.env.get("SUPABASE_URL");
    const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const WHSEC = Deno.env.get("STRIPE_WEBHOOK_SECRET");
    if (!SB_URL || !SB_KEY) return json({ error: "Server config missing" }, 500);
    if (!WHSEC) return json({ error: "STRIPE_WEBHOOK_SECRET not configured" }, 500);

    const supabase = createClient(SB_URL, SB_KEY);
    const raw = await req.text();
    const sig = req.headers.get("Stripe-Signature") || "";

    const valid = await verifyStripeSignature(raw, sig, WHSEC);
    if (!valid) return json({ error: "Invalid signature" }, 401);

    let event: any;
    try { event = JSON.parse(raw); } catch { return json({ error: "Invalid JSON" }, 400); }

    // Persist the event (idempotent on stripe_event_id)
    const { error: insErr } = await supabase
        .from("stripe_webhook_events")
        .insert({
            stripe_event_id: event.id,
            event_type: event.type,
            account_id: event.account || null,
            payload: event,
        });
    // If already processed, just 200 (idempotency)
    if (insErr && insErr.message?.includes("duplicate")) return json({ ok: true, duplicate: true });

    // Handle the specific events
    try {
        switch (event.type) {
            case "account.updated": {
                const acct = event.data.object;
                const accountId = acct.id;
                await supabase.from("businesses").update({
                    stripe_charges_enabled: !!acct.charges_enabled,
                    stripe_payouts_enabled: !!acct.payouts_enabled,
                    stripe_details_submitted: !!acct.details_submitted,
                    stripe_last_synced_at: new Date().toISOString(),
                }).eq("stripe_connect_account_id", accountId);
                break;
            }
            case "account.application.deauthorized": {
                const accountId = event.account || event.data?.object?.id;
                if (accountId) {
                    await supabase.from("businesses").update({
                        stripe_connect_account_id: null,
                        stripe_charges_enabled: false,
                        stripe_payouts_enabled: false,
                        stripe_details_submitted: false,
                        stripe_last_synced_at: new Date().toISOString(),
                    }).eq("stripe_connect_account_id", accountId);
                }
                break;
            }
            case "invoice.paid": {
                // Log it; full settlement logic in future Phase 6
                console.log("invoice.paid for", event.data.object?.customer, "amount", event.data.object?.amount_paid);
                break;
            }
            case "invoice.payment_failed": {
                const customerId = event.data.object?.customer;
                if (customerId) {
                    // Mark the business's subscription as past_due in business_subscriptions
                    await supabase
                        .from("business_subscriptions")
                        .update({ status: "past_due", updated_at: new Date().toISOString() })
                        .in("business_id", (await supabase.from("businesses").select("id").eq("stripe_customer_id", customerId)).data?.map((r: any) => r.id) || []);
                }
                break;
            }
            case "checkout.session.completed": {
                // 2026-05-31 — business payment confirmed (create-checkout-session).
                // Stripe is the source of truth: only here do we mark the business
                // paid/subscribed. client_reference_id + metadata carry the biz id.
                const s = event.data.object || {};
                const bizId = s.client_reference_id || s.metadata?.business_id || null;
                const purpose = s.metadata?.purpose || (s.mode === "subscription" ? "subscription" : "signup");
                if (bizId) {
                    const patch: Record<string, unknown> = { stripe_last_synced_at: new Date().toISOString() };
                    if (s.customer) patch.stripe_customer_id = s.customer;
                    if (purpose === "signup") {
                        patch.signup_fee_paid = true;
                        patch.signup_paid_at = new Date().toISOString();
                    } else if (purpose === "subscription" && s.subscription) {
                        patch.stripe_subscription_id = s.subscription;
                    }
                    await supabase.from("businesses").update(patch).eq("id", bizId);
                }
                break;
            }
            default:
                // Unhandled event types are still logged + 200'd
                break;
        }

        await supabase
            .from("stripe_webhook_events")
            .update({ processed_at: new Date().toISOString() })
            .eq("stripe_event_id", event.id);
        return json({ ok: true });
    } catch (e: any) {
        await supabase
            .from("stripe_webhook_events")
            .update({ processing_error: e.message?.slice(0, 500) || "unknown" })
            .eq("stripe_event_id", event.id);
        return json({ error: e.message || "processing failed" }, 500);
    }
});
