// =============================================================================
// LYMX Power — QR Resolver (anon-callable)
// =============================================================================
// POST /functions/v1/qr-resolve
//
// Takes a QR token + kind and returns non-sensitive display info so the
// scanning UI can show "You're issuing to: Jane Smith" or "Business: Brew &
// Bean Café" before the user confirms an amount.
//
// AUTH: anon key is sufficient (the underlying RPC is GRANTed to anon).
//       Returns only display_name / category / issuance_rate — never the
//       email, phone, balance, or any other sensitive field.
//
// REQUEST BODY:
//   { "token": "uuid", "kind": "business" | "customer" }
//
// RESPONSE (200):
//   { ok: true, kind, id, name, ... }    // business / customer detail
//   { ok: false, error: "token_not_found" }
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

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

interface ResolveBody {
    token?: string;
    kind?: "business" | "customer";
}

serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }
    if (req.method !== "POST") {
        return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
    }

    // Anon-client is fine — the RPC is SECURITY DEFINER and GRANTed to anon.
    const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { auth: { persistSession: false } }
    );

    let body: ResolveBody;
    try {
        body = await req.json();
    } catch {
        return jsonResponse({ ok: false, error: "invalid_json" }, 400);
    }

    if (!body.token || !body.kind) {
        return jsonResponse(
            { ok: false, error: "token_and_kind_required" },
            400
        );
    }
    if (body.kind !== "business" && body.kind !== "customer") {
        return jsonResponse({ ok: false, error: "unknown_kind" }, 400);
    }
    // Defensive UUID regex — gen_random_uuid output is always v4
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(body.token)) {
        return jsonResponse({ ok: false, error: "invalid_token_format" }, 400);
    }

    const { data, error } = await supabase.rpc("resolve_qr_token", {
        p_token: body.token,
        p_kind: body.kind,
    });
    if (error) {
        console.error("[qr-resolve] rpc error", error);
        return jsonResponse({ ok: false, error: "rpc_failed", detail: error.message }, 500);
    }
    return jsonResponse(data, 200);
});
