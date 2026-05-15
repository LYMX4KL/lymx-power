// =============================================================================
// LYMX Power — Feedback Submit Endpoint
// =============================================================================
// POST /functions/v1/feedback-submit
//
// Accepts the Send Feedback modal payload from any page on getlymx.com.
// Auto-categorizes by URL pattern. Inserts into public.feedback.
//
// REQUEST BODY:
// {
//   "type":      "bug" | "suggestion" | "question" | "general",
//   "priority":  "urgent" | "high" | "normal" | "low",   // optional, defaults to "normal"
//   "subject":   "Short headline",                         // optional, derived if blank
//   "message":   "What did you see / what to change",
//   "page_url":  "https://getlymx.com/biz-dashboard.html",
//   "viewport":  "1920x1080",                              // optional
//   "user_agent":"Mozilla/5.0 ...",                        // optional
//   "screenshot_b64": "data:image/png;base64,iVBOR..."     // optional, ≤ 5 MB
// }
//
// AUTH:
//   - anon (apikey header) — submission is anonymous, user_id stays null
//   - user JWT — submission is attributed to that user
//
// RESPONSE (201):
//   { "id": "uuid", "cluster": "auth", "status": "new" }
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
const errorResponse = (message: string, status = 400) =>
    json({ error: message }, status);

// ----- Cluster rules (server-side, mirrors FEEDBACK-SYSTEM-SPEC.md) ---------
const CLUSTER_RULES: Array<{ pattern: RegExp; cluster: string }> = [
    { pattern: /\/(login|.*-signup)\.html/i, cluster: "auth" },
    { pattern: /\/browse\.html/i, cluster: "browse" },
    { pattern: /\/customer-(dashboard|wallet)\.html/i, cluster: "customer_wallet" },
    { pattern: /\/biz-(dashboard|brew|oakline|menu|staff|analytics|signup)/i, cluster: "business" },
    { pattern: /\/(rep-dashboard|territory-program|partner-)/i, cluster: "partner" },
    { pattern: /\/write-review\.html/i, cluster: "reviews" },
    { pattern: /\/admin-/i, cluster: "admin" },
    { pattern: /\/(biz-integration|pos|biz-pos)/i, cluster: "integrations" },
    { pattern: /\/(privacy|terms|policy|legal)/i, cluster: "legal" },
];
function clusterFor(url: string): string {
    for (const r of CLUSTER_RULES) if (r.pattern.test(url)) return r.cluster;
    return "marketing";
}

// ----- Body shape ----------------------------------------------------------
interface FeedbackBody {
    type: string;
    priority?: string;
    subject?: string;
    message: string;
    original_message?: string | null;     // pre-AI-polish version
    ai_summary?: string | null;           // 1-line summary from polish/categorize
    page_url: string;
    page_title?: string;
    viewport?: string;
    user_agent?: string;
    screenshot_b64?: string;
    screenshot_kind?: string | null;      // 'auto' | 'region' | 'upload'
}
const VALID_TYPES = new Set(["bug", "suggestion", "question", "general"]);
const VALID_PRIORITIES = new Set(["urgent", "high", "normal", "low"]);

// JWT role-claim decoder (per project README pattern)
function getJwtPayload(jwt: string): Record<string, unknown> | null {
    try {
        const parts = jwt.split(".");
        if (parts.length !== 3) return null;
        return JSON.parse(
            atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")),
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
        return errorResponse("Method not allowed", 405);
    }

    let body: FeedbackBody;
    try {
        body = await req.json();
    } catch {
        return errorResponse("Invalid JSON", 400);
    }

    // ----- Validate ---------------------------------------------------------
    if (!body.type || !VALID_TYPES.has(body.type)) {
        return errorResponse(
            "type must be one of: bug, suggestion, question, general",
            400,
        );
    }
    const priority = body.priority && VALID_PRIORITIES.has(body.priority)
        ? body.priority
        : "normal";
    if (!body.message || body.message.trim().length < 10) {
        return errorResponse("message must be at least 10 characters", 400);
    }
    if (!body.page_url || body.page_url.length > 1000) {
        return errorResponse("page_url is required (≤ 1000 chars)", 400);
    }

    // ----- Pull user_id from JWT (if any) -----------------------------------
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.startsWith("Bearer ")
        ? authHeader.slice(7).trim()
        : "";
    let userId: string | null = null;
    let userEmail: string | null = null;
    let userRole: string = "anonymous";
    if (jwt) {
        const payload = getJwtPayload(jwt);
        if (payload && payload.role !== "anon" && typeof payload.sub === "string") {
            userId = payload.sub;
            userEmail = (payload.email as string) || null;
            // We'll resolve the actual role from DB below — user_metadata.role is
            // unreliable (often stale or missing).
            userRole = "authenticated";
        }
    }

    // Service-role client to bypass RLS (we apply our own validation above)
    const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        { auth: { persistSession: false } },
    );

    // ----- Resolve actual user role from DB ---------------------------------
    // Priority: admin > staff > partner > business > customer.
    // Mirror of InvestPro pattern: role lives in the tables, not the JWT.
    if (userId) {
        const ADMIN_UUID = "1405bb50-2c97-48dd-bfa5-31f32320de9b";
        if (userId === ADMIN_UUID) {
            userRole = "admin";
        } else {
            // staff_roles table (if it exists from migration 015)
            try {
                const { data: staff } = await supabase
                    .from("staff_roles").select("user_id").eq("user_id", userId).maybeSingle();
                if (staff) userRole = "staff";
            } catch { /* table may not exist */ }
            // partners table
            if (userRole === "authenticated") {
                const { data: p } = await supabase
                    .from("partners").select("user_id").eq("user_id", userId).maybeSingle();
                if (p) userRole = "partner";
            }
            // businesses table (owner_user_id, not user_id)
            if (userRole === "authenticated") {
                const { data: b } = await supabase
                    .from("businesses").select("owner_user_id").eq("owner_user_id", userId).maybeSingle();
                if (b) userRole = "business";
            }
            // Default for any signed-in user not in partners/businesses
            if (userRole === "authenticated") userRole = "customer";
        }
    }

    // ----- Optional: upload screenshot --------------------------------------
    let screenshotPath: string | null = null;
    if (body.screenshot_b64 && body.screenshot_b64.length > 0) {
        try {
            // Strip "data:image/png;base64," prefix if present
            const dataMatch = body.screenshot_b64.match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/);
            if (!dataMatch) throw new Error("Unsupported image format");
            const mime = dataMatch[1];
            const ext = mime === "image/jpeg" ? "jpg" : mime.split("/")[1];
            const bin = Uint8Array.from(atob(dataMatch[2]), (c) => c.charCodeAt(0));
            if (bin.byteLength > 5 * 1024 * 1024) {
                throw new Error("Screenshot too large (max 5 MB)");
            }
            const filename = `${Date.now()}-${crypto.randomUUID()}.${ext}`;
            const { error: upErr } = await supabase.storage
                .from("feedback-screenshots")
                .upload(filename, bin, { contentType: mime, upsert: false });
            if (upErr) throw upErr;
            screenshotPath = filename;
        } catch (e) {
            console.warn("Screenshot upload failed:", e);
            // Don't fail the whole submission — just drop the screenshot
        }
    }

    // ----- Auto-derive subject if blank -------------------------------------
    let subject = (body.subject || "").trim();
    if (!subject) {
        subject = body.message.trim().split(/\n|\.|\?/)[0].slice(0, 80);
    }

    // ----- Insert -----------------------------------------------------------
    const { data, error } = await supabase
        .from("feedback")
        .insert({
            user_id: userId,
            user_email: userEmail,
            user_role: userRole,
            type: body.type,
            priority,
            subject,
            message: body.message.trim(),
            original_message: body.original_message ?? null,
            ai_summary: body.ai_summary ?? null,
            page_url: body.page_url,
            page_title: body.page_title ?? null,
            cluster: clusterFor(body.page_url),
            user_agent: body.user_agent ?? null,
            viewport: body.viewport ?? null,
            screenshot_path: screenshotPath,
            screenshot_kind: body.screenshot_kind ?? null,
            status: "new",
        })
        .select("id, cluster, status")
        .single();

    if (error) {
        console.error("Feedback insert failed:", error);
        return errorResponse(`Insert failed: ${error.message}`, 500);
    }

    return json(data, 201);
});
