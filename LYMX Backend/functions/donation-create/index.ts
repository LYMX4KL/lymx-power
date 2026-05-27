// =============================================================================
// LYMX Power — Donation Create (Sprint 2)
// =============================================================================
// POST /functions/v1/donation-create
//
// A signed-in customer donates LYMX from their wallet to a verified nonprofit.
// All the load-bearing logic lives in public.fn_request_donation (migration
// 107) — this EF is a thin wrapper that validates the JWT and returns a
// receipt-friendly response shape.
//
// AUTH: any signed-in user. The RPC checks balance + nonprofit status. Admin
//       JWTs pass through the same path (an admin donating their own LYMX
//       behaves exactly like a customer).
//
// REQUEST BODY (JSON):
//   {
//     "nonprofit_id":      "uuid",                  // required
//     "lymx_amount":       100,                     // required, positive int
//     "client_request_id": "<client-uuid>"          // optional but recommended;
//                                                   // dedupes double-clicks
//   }
//
// RESPONSE (200):
//   {
//     "ok": true,
//     "donation_id":   "uuid",
//     "receipt_token": "abc123...",                 // public-shareable receipt id
//     "lymx_amount":   100,
//     "usd_cents":     80,                          // at $0.008 per LYMX default
//     "nonprofit": {
//       "id":             "uuid",
//       "name":           "Local Food Bank",
//       "slug":           "local-food-bank",
//       "mission_short":  "..."
//     },
//     "status":        "pending",
//     "idempotent":    false                        // true if dedup hit
//   }
//
// ERRORS:
//   400 — invalid JSON / missing fields / non-positive amount
//   401 — no/invalid JWT
//   403 — donations gated off (Sprint 2 Phase B can add a feature flag check)
//   404 — nonprofit not found
//   409 — nonprofit not verified, insufficient balance, etc.
//   500 — RPC failure
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), {
        status: s,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
const err = (m: string, s = 400) => json({ ok: false, error: m }, s);

interface DonateBody {
    nonprofit_id?: string;
    lymx_amount?: number;
    client_request_id?: string;
}

function decodeJwt(jwt: string): Record<string, unknown> | null {
    try {
        const parts = jwt.split(".");
        if (parts.length !== 3) return null;
        return JSON.parse(
            atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))
        );
    } catch {
        return null;
    }
}

serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }
    if (req.method !== "POST") {
        return err("Method not allowed", 405);
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
        return err("Missing Authorization header", 401);
    }
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    const payload = decodeJwt(token);
    if (!payload || !payload["sub"]) {
        return err("Invalid JWT", 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) {
        return err("Server misconfiguration: SUPABASE_URL / SERVICE_ROLE_KEY missing", 500);
    }

    let body: DonateBody;
    try {
        body = await req.json();
    } catch {
        return err("Invalid JSON body", 400);
    }
    if (!body.nonprofit_id) return err("nonprofit_id required", 400);
    if (!body.lymx_amount || body.lymx_amount <= 0 || !Number.isInteger(body.lymx_amount)) {
        return err("lymx_amount must be a positive integer", 400);
    }

    // Build a client stamped with the caller's JWT so the RPC runs as them
    // (auth.uid() resolves correctly; v_my_lymx_balance filters to their rows).
    const callerClient = createClient(supabaseUrl, serviceKey, {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth:   { persistSession: false },
    });

    // Idempotency pre-check: if the EF gets retried with the same client_request_id,
    // return the existing donation without re-running the RPC.
    if (body.client_request_id) {
        const { data: pre, error: preErr } = await callerClient
            .from("donations")
            .select("id, receipt_token, lymx_amount, usd_cents, status, nonprofit_id")
            .eq("donor_user_id", payload["sub"] as string)
            .eq("client_request_id", body.client_request_id)
            .maybeSingle();
        if (preErr) {
            console.warn("[donation-create] idempotency check failed", preErr.message);
        } else if (pre) {
            // Hydrate the nonprofit payload
            const { data: np } = await callerClient
                .from("nonprofits")
                .select("id, name, slug, mission_short")
                .eq("id", pre.nonprofit_id)
                .single();
            return json({
                ok: true,
                donation_id:   pre.id,
                receipt_token: pre.receipt_token,
                lymx_amount:   pre.lymx_amount,
                usd_cents:     pre.usd_cents,
                nonprofit:     np ?? { id: pre.nonprofit_id, name: null, slug: null, mission_short: null },
                status:        pre.status,
                idempotent:    true,
            });
        }
    }

    // Real RPC call
    const { data: row, error: rpcErr } = await callerClient.rpc(
        "fn_request_donation",
        {
            p_nonprofit_id:      body.nonprofit_id,
            p_lymx_amount:       body.lymx_amount,
            p_client_request_id: body.client_request_id ?? null,
        }
    );
    if (rpcErr) {
        const msg = rpcErr.message || "";
        // Map known RPC errors to HTTP status codes
        let status = 500;
        if (/must be signed in/i.test(msg))              status = 401;
        else if (/not found/i.test(msg))                 status = 404;
        else if (/not accepting donations/i.test(msg))   status = 409;
        else if (/insufficient balance/i.test(msg))      status = 409;
        else if (/required|positive|misconfigured/i.test(msg)) status = 400;
        return err(msg, status);
    }

    const donation = row as {
        id: string;
        receipt_token: string;
        lymx_amount: number;
        usd_cents: number;
        nonprofit_id: string;
        status: string;
    };

    // Hydrate the nonprofit name + slug for the receipt
    const { data: np, error: npErr } = await callerClient
        .from("nonprofits")
        .select("id, name, slug, mission_short")
        .eq("id", donation.nonprofit_id)
        .single();
    if (npErr) {
        console.warn("[donation-create] nonprofit hydrate failed", npErr.message);
    }

    return json({
        ok: true,
        donation_id:   donation.id,
        receipt_token: donation.receipt_token,
        lymx_amount:   donation.lymx_amount,
        usd_cents:     donation.usd_cents,
        nonprofit:     np ?? { id: donation.nonprofit_id, name: null, slug: null, mission_short: null },
        status:        donation.status,
        idempotent:    false,
    });
});
