// =============================================================================
// LYMX Power — Square Webhook Endpoint
// =============================================================================
// POST /functions/v1/square-webhook
//
// Receives Square's webhook events. The big one we care about is `payment.updated`
// firing with status=COMPLETED — that's when a customer paid the merchant and
// we should mint LYMX.
//
// SECURITY: HMAC-SHA256 verification. Square signs every webhook with the
// merchant's webhook signature key. The signature is over `notification_url +
// raw_body`. We verify before we trust ANY payload data. An invalid signature
// returns 401 immediately and we don't even insert into the events log.
//
// IDEMPOTENCY: Every webhook has a `square_event_id`. We INSERT into
// `square_webhook_events` with ON CONFLICT DO NOTHING; if the conflict fires,
// we know we've already processed this event and short-circuit with 200.
// (Square retries on 5xx and timeouts — without this, a slow processor could
// double-mint LYMX.)
//
// PIPELINE (for payment.updated events):
//   1. Verify HMAC. Bad sig → 401.
//   2. Parse body → event_id, type, merchant_id, payment data.
//   3. INSERT square_webhook_events (idempotent via UNIQUE).
//   4. If insert was a no-op (event_id collision) → return 200 idempotent.
//   5. Look up our business via square_integrations(square_merchant_id).
//   6. If no matching integration → 200 with last_error noting it (we don't
//      know this merchant; not a security issue, just no-op).
//   7. If event is `payment.updated` with status=COMPLETED:
//      a. Try to resolve a customer (via buyer_email or buyer_phone).
//      b. If matched: compute LYMX = floor(usd * issuance_rate), insert
//         a transaction + update wallet.
//      c. If not matched: log "no_customer_resolved" but return 200.
//   8. Stamp `processed_at` on the event row.
//
// AUTH: Public endpoint. Square POSTs here from their server with no JWT.
//   The HMAC signature IS the auth — only Square has the merchant's signature
//   key, so a valid signature proves the request came from Square.
//
// REQUEST: POST with Square's webhook envelope as body. Headers include
//   `X-Square-HmacSha256-Signature` (base64).
//
// RESPONSE: Always 200 unless HMAC fails (401). Square retries on non-200,
//   and we DO want at-least-once delivery for retriable errors, but:
//   - duplicate events: 200 (idempotent)
//   - unknown merchant: 200 (not retryable; would always fail)
//   - unhandled event_type: 200 (we just logged it)
//   - HMAC fail: 401 (don't process; Square shouldn't be sending this)
//
// ENV VARS REQUIRED:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   SQUARE_WEBHOOK_SIGNATURE_KEY  — secret, from Square webhook subscription
//   SQUARE_WEBHOOK_NOTIFICATION_URL — must match what Square sends to
//                                     (e.g. https://apffootxzfwmtyjlnteo.supabase.co
//                                            /functions/v1/square-webhook)
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

// =============================================================================
// Types — partial Square webhook envelope shapes (only what we read)
// =============================================================================

interface SquareWebhookEnvelope {
    merchant_id: string;
    type: string;            // e.g. "payment.updated"
    event_id: string;        // unique per-delivery idempotency key
    created_at: string;
    data?: {
        type?: string;        // e.g. "payment"
        id?: string;
        object?: {
            payment?: SquarePayment;
        };
    };
}

interface SquarePayment {
    id: string;
    status: string;          // "APPROVED" | "COMPLETED" | "CANCELED" | "FAILED"
    amount_money?: { amount: number; currency: string };
    location_id?: string;
    buyer_email_address?: string;
    note?: string;
    receipt_email?: string;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Verify Square's webhook signature.
 * Square signs `notification_url + raw_body` with HMAC-SHA256, base64-encoded.
 * We recompute and compare to the X-Square-HmacSha256-Signature header.
 */
async function verifySquareSignature(args: {
    signatureKey: string;
    notificationUrl: string;
    rawBody: string;
    headerSignature: string;
}): Promise<boolean> {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
        "raw",
        enc.encode(args.signatureKey),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );
    const sig = await crypto.subtle.sign(
        "HMAC",
        key,
        enc.encode(args.notificationUrl + args.rawBody)
    );
    // Square uses base64 (standard, with padding) for the signature header
    const computedB64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
    return computedB64 === args.headerSignature;
}

/**
 * Try to find a LYMX customer matching the Square buyer.
 * Square gives us either buyer_email_address (if collected at checkout) or
 * receipt_email. We look up the customer via their auth.users email.
 *
 * Returns null if no match — caller should log and continue.
 */
async function resolveCustomer(
    supabase: ReturnType<typeof createClient>,
    payment: SquarePayment
): Promise<{ customer_id: string; user_id: string } | null> {
    const email = payment.buyer_email_address || payment.receipt_email;
    if (!email) return null;

    // auth.users.email → customers.user_id
    // V1 implementation: use the admin auth API to list all users and find by email.
    //
    // SCALE WARNING: this is O(n) per webhook. Fine while we have <500 customers.
    // At scale, replace with either:
    //   - a SECURITY DEFINER Postgres function `lookup_user_id_by_email(email)`, or
    //   - denormalize `email` onto our `customers` table at signup time.
    const { data: users, error } = await supabase.auth.admin.listUsers();
    if (error || !users) return null;

    const user = users.users.find(
        (u) => u.email?.toLowerCase() === email.toLowerCase()
    );
    if (!user) return null;

    const { data: customer } = await supabase
        .from("customers")
        .select("id, user_id")
        .eq("user_id", user.id)
        .maybeSingle();
    if (!customer) return null;

    return { customer_id: customer.id, user_id: user.id };
}

/**
 * Mint LYMX for this payment — UPDATED 2026-05-19 to use the unified
 * `lymx_issuances` ledger so all DB-side fraud layers fire (migration 012
 * owner-array hard-block, migration 050 daily concentration scan, migration
 * 053 receipt-scan dedupe is exempt because reason='transaction' not 'manual').
 *
 *   1. Resolve the matching `business_partners` row via the businesses.owner_user_id
 *      that came back from the square_integrations join.  If no match (legacy biz
 *      not yet bridged to business_partners), business_id is left null and the
 *      issuance still records — just without per-business fraud grouping.
 *   2. Compute LYMX = floor(usd_amount * issuance_rate)
 *   3. INSERT into lymx_issuances with:
 *        reason='transaction', transaction_method='webhook',
 *        transaction_id=square_payment_id (UNIQUE — duplicate webhooks no-op),
 *        idempotency_key=square_event_id (belt + braces).
 *      The migration 012 trigger fires on insert; if the recipient happens to
 *      be the business's owner, it raises FRAUD BLOCK and we surface that
 *      back to Square as a 200 + logged error (no retry — humans investigate).
 */
async function mintLymxForPayment(args: {
    supabase: ReturnType<typeof createClient>;
    business: { id: string; issuance_rate: number; owner_user_id?: string | null };
    customer: { customer_id: string; user_id: string };
    payment: SquarePayment;
    eventId: string;
}): Promise<{ issuance_id: string; lymx_issued: number; usd_amount: number; blocked_reason?: string }> {
    const cents = args.payment.amount_money?.amount ?? 0;
    const usd_amount = cents / 100;
    if (usd_amount <= 0) {
        throw new Error(`Payment ${args.payment.id} has non-positive amount: ${cents} cents`);
    }
    const lymxIssued = Math.floor(usd_amount * args.business.issuance_rate);
    if (lymxIssued <= 0) {
        throw new Error(`Computed LYMX is 0 for $${usd_amount} at rate ${args.business.issuance_rate}`);
    }

    // Look up the matching business_partners row.  Bridge: business_partners
    // has owner_user_ids[] — find one where businesses.owner_user_id is in the
    // array.  If we don't find one, business_id stays null (legacy data); the
    // issuance still lands and is queryable by transaction_id.
    let businessPartnerId: string | null = null;
    if (args.business.owner_user_id) {
        const { data: bp } = await args.supabase
            .from("business_partners")
            .select("id")
            .contains("owner_user_ids", [args.business.owner_user_id])
            .limit(1)
            .maybeSingle();
        if (bp) businessPartnerId = bp.id;
    }

    // 80% of face value billed to business (FEE_RATE = $0.008 per LYMX).
    const businessCostCents = Math.round(lymxIssued * 0.8);

    const { data: row, error: insErr } = await args.supabase
        .from("lymx_issuances")
        .insert({
            recipient_user_id: args.customer.user_id,
            business_id: businessPartnerId,
            issuing_user_id: null,                          // webhook origin — no human cashier
            amount_lymx: lymxIssued,
            reason: "transaction",
            transaction_method: "webhook",
            transaction_id: args.payment.id,
            transaction_amount_cents: cents,
            business_cost_cents: businessCostCents,
            idempotency_key: `square_evt_${args.eventId}`,
            verified: true,
            admin_status: "auto",
            user_agent: "square-webhook",
        })
        .select("id")
        .single();

    if (insErr) {
        const msg = insErr.message || "";
        // Migration 012 hard-block raises this exact prefix on self-issuance:
        if (/FRAUD BLOCK/i.test(msg)) {
            return { issuance_id: "", lymx_issued: 0, usd_amount, blocked_reason: msg.slice(0, 200) };
        }
        // Idempotency collision means we already wrote this issuance — treat as
        // a benign no-op so Square doesn't retry.
        if (/duplicate key|idempotency|transaction_id/i.test(msg)) {
            return { issuance_id: "", lymx_issued: lymxIssued, usd_amount, blocked_reason: "duplicate" };
        }
        throw new Error(`Issuance insert failed: ${msg}`);
    }
    if (!row) {
        throw new Error("Issuance insert returned no row");
    }
    return { issuance_id: row.id, lymx_issued: lymxIssued, usd_amount };
}


// =============================================================================
// Main handler
// =============================================================================

serve(async (req) => {
    if (req.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
    }

    // ---- Read raw body BEFORE JSON parsing (HMAC needs the exact bytes) -----
    const rawBody = await req.text();

    // ---- Env var sanity ----------------------------------------------------
    const env = (k: string) => Deno.env.get(k);
    const required = [
        "SUPABASE_URL",
        "SUPABASE_SERVICE_ROLE_KEY",
        "SQUARE_WEBHOOK_SIGNATURE_KEY",
        "SQUARE_WEBHOOK_NOTIFICATION_URL",
    ];
    const missing = required.filter((k) => !env(k));
    if (missing.length > 0) {
        console.error(`[square-webhook] Missing env vars: ${missing.join(",")}`);
        // Return 200 so Square doesn't retry forever — but a human needs to fix this.
        return new Response("ok", { status: 200 });
    }

    // ---- Verify HMAC -------------------------------------------------------
    const headerSig = req.headers.get("x-square-hmacsha256-signature");
    if (!headerSig) {
        console.error("[square-webhook] Missing signature header");
        return new Response("Unauthorized", { status: 401 });
    }
    const sigOk = await verifySquareSignature({
        signatureKey: env("SQUARE_WEBHOOK_SIGNATURE_KEY")!,
        notificationUrl: env("SQUARE_WEBHOOK_NOTIFICATION_URL")!,
        rawBody,
        headerSignature: headerSig,
    });
    if (!sigOk) {
        console.error("[square-webhook] HMAC signature mismatch");
        return new Response("Unauthorized", { status: 401 });
    }

    // ---- Parse the envelope ------------------------------------------------
    let envelope: SquareWebhookEnvelope;
    try {
        envelope = JSON.parse(rawBody);
    } catch {
        console.error("[square-webhook] Body is not JSON");
        // Bad request, but ack so Square doesn't retry indefinitely
        return new Response("ok", { status: 200 });
    }
    if (!envelope.event_id || !envelope.type || !envelope.merchant_id) {
        console.error("[square-webhook] Envelope missing required fields");
        return new Response("ok", { status: 200 });
    }

    const supabase = createClient(
        env("SUPABASE_URL")!,
        env("SUPABASE_SERVICE_ROLE_KEY")!,
        { auth: { persistSession: false } }
    );

    // ---- Insert into square_webhook_events (atomic dedupe) ------------------
    // We use upsert with ignoreDuplicates so a duplicate event_id is a no-op
    // rather than an error. The .select() tells us if a row was actually
    // inserted — empty array means duplicate.
    const { data: insertResult, error: insertErr } = await supabase
        .from("square_webhook_events")
        .upsert(
            {
                square_event_id: envelope.event_id,
                event_type: envelope.type,
                square_merchant_id: envelope.merchant_id,
                raw_payload: envelope,
                received_signature: headerSig,
            },
            {
                onConflict: "square_event_id",
                ignoreDuplicates: true,
            }
        )
        .select("id");
    if (insertErr) {
        console.error(`[square-webhook] Insert failed: ${insertErr.message}`);
        // Return 5xx so Square retries — this is an internal error
        return new Response("Internal error", { status: 500 });
    }
    const isDuplicate = !insertResult || insertResult.length === 0;
    if (isDuplicate) {
        // Already processed (or being processed). Idempotent success.
        return new Response("ok", { status: 200 });
    }
    const eventRowId = insertResult[0].id;

    // ---- Look up the business via square_integrations -----------------------
    // Also pull `owner_user_id` so mintLymxForPayment can bridge into
    // business_partners (the canonical biz table on the new ledger).
    const { data: integration, error: intErr } = await supabase
        .from("square_integrations")
        .select(
            "id, business_id, issuance_enabled, " +
            "businesses!inner(id, issuance_rate, archived_at, owner_user_id)"
        )
        .eq("square_merchant_id", envelope.merchant_id)
        .is("disconnected_at", null)
        .maybeSingle();

    const markProcessed = async (
        opts: { error?: string | null; transactionId?: string | null } = {}
    ) => {
        await supabase
            .from("square_webhook_events")
            .update({
                processed_at: new Date().toISOString(),
                processing_error: opts.error ?? null,
                transaction_id: opts.transactionId ?? null,
            })
            .eq("id", eventRowId);
    };

    if (intErr) {
        console.error(`[square-webhook] Integration lookup failed: ${intErr.message}`);
        // Don't mark processed — let reconciliation retry
        return new Response("ok", { status: 200 });
    }
    if (!integration) {
        // Webhook from a Square merchant we don't know — log + ack
        await markProcessed({ error: "no_matching_integration" });
        return new Response("ok", { status: 200 });
    }

    // Update business_id on the event row now that we know it
    await supabase
        .from("square_webhook_events")
        .update({ business_id: integration.business_id })
        .eq("id", eventRowId);

    if (!integration.issuance_enabled) {
        await markProcessed({ error: "issuance_disabled_by_merchant" });
        return new Response("ok", { status: 200 });
    }

    // deno-lint-ignore no-explicit-any
    const biz = (integration as any).businesses;
    if (biz?.archived_at) {
        await markProcessed({ error: "business_archived" });
        return new Response("ok", { status: 200 });
    }

    // ---- Switch on event type ----------------------------------------------
    if (envelope.type !== "payment.updated") {
        // Other events (refund, dispute, etc.) — log + ack. Future work: handle these.
        await markProcessed({ error: `unhandled_event_type:${envelope.type}` });
        return new Response("ok", { status: 200 });
    }

    const payment = envelope.data?.object?.payment;
    if (!payment) {
        await markProcessed({ error: "missing_payment_object" });
        return new Response("ok", { status: 200 });
    }

    if (payment.status !== "COMPLETED") {
        // We only mint on COMPLETED. APPROVED, PENDING, etc. are skipped.
        await markProcessed({ error: `payment_status_${payment.status}` });
        return new Response("ok", { status: 200 });
    }

    // ---- Resolve the LYMX customer -----------------------------------------
    let customer: { customer_id: string; user_id: string } | null = null;
    try {
        customer = await resolveCustomer(supabase, payment);
    } catch (e) {
        console.error("[square-webhook] Customer resolution failed:", e);
        // Treat as "no match" — not fatal
    }

    if (!customer) {
        await markProcessed({ error: "no_customer_resolved" });
        return new Response("ok", { status: 200 });
    }

    // ---- Mint LYMX ----------------------------------------------------------
    try {
        const result = await mintLymxForPayment({
            supabase,
            business: {
                id: integration.business_id as string,
                issuance_rate: Number(biz.issuance_rate) || 5,
                owner_user_id: biz.owner_user_id ?? null,
            },
            customer,
            payment,
            eventId: envelope.event_id,
        });
        if (result.blocked_reason) {
            // Either a fraud-block trigger (self-issuance) or an idempotency
            // collision (duplicate webhook). Neither is retryable — log + ack.
            await markProcessed({ error: `blocked: ${result.blocked_reason}` });
            return new Response("ok", { status: 200 });
        }
        await markProcessed({ transactionId: result.issuance_id });
        // Bump last_used_at on the integration so we know the merchant's wired in
        await supabase
            .from("square_integrations")
            .update({ last_used_at: new Date().toISOString() })
            .eq("id", integration.id);
        return new Response("ok", { status: 200 });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[square-webhook] Minting failed: ${msg}`);
        await markProcessed({ error: `minting_failed: ${msg}` });
        // Return 200 — re-running won't help. A human can investigate via the
        // square_webhook_events row. Returning 5xx would have Square retry
        // forever for an unrecoverable error.
        return new Response("ok", { status: 200 });
    }
});
