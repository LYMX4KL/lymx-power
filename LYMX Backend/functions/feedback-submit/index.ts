// =============================================================================
// LYMX Power — Feedback Submit Endpoint (v2 — 2026-05-15)
// =============================================================================
// POST /functions/v1/feedback-submit
//
// Accepts the Send Feedback modal payload from any page on getlymx.com /
// lymxpower.com. Auto-categorizes by URL pattern. Inserts into public.feedback
// and writes attachments (if any) into the feedback-attachments bucket +
// feedback_attachments table.
//
// REQUEST BODY:
// {
//   "type":            "bug" | "suggestion" | "question" | "general",
//   "priority":        "urgent" | "high" | "normal" | "low",
//   "subject":         "Short headline",
//   "message":         "What did you see / what to change",
//   "page_url":        "...",
//   "page_title":      "...",
//   "viewport":        "1920x1080",
//   "user_agent":      "...",
//   "screenshot_b64":  "data:image/png;base64,iVBO...",   // optional, primary
//   "screenshot_kind": "auto" | "region" | "upload",
//   "attachments": [                                       // NEW v2
//     { "name": "log.txt", "type": "text/plain", "size": 1234,
//       "data_url": "data:text/plain;base64,..." }
//   ]
// }
//
// AUTH:
//   - anon (apikey header)  → submission is anonymous, user_id stays null
//   - user JWT              → submission is attributed to that user (role
//     resolved from DB tables, not from possibly-stale user_metadata)
//
// RESPONSE (201):
//   { "id": "uuid", "cluster": "auth", "status": "new",
//     "attachments_uploaded": 2 }
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

interface FeedbackAttachment {
    name: string;
    type?: string;
    size?: number;
    data_url: string;
}
interface FeedbackBody {
    type: string;
    priority?: string;
    subject?: string;
    message: string;
    original_message?: string | null;
    ai_summary?: string | null;
    page_url: string;
    page_title?: string;
    viewport?: string;
    user_agent?: string;
    screenshot_b64?: string;
    screenshot_kind?: string | null;
    attachments?: FeedbackAttachment[];
}
const VALID_TYPES = new Set(["bug", "suggestion", "question", "general"]);
const VALID_PRIORITIES = new Set(["urgent", "high", "normal", "low"]);
const MAX_ATTACHMENTS = 6;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

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

function safeExtFromMime(mime: string, fallback: string): string {
    const m = mime.toLowerCase();
    if (m === "image/jpeg" || m === "image/jpg") return "jpg";
    if (m === "image/png")  return "png";
    if (m === "image/webp") return "webp";
    if (m === "image/gif")  return "gif";
    if (m === "application/pdf") return "pdf";
    if (m === "text/plain") return "txt";
    if (m === "text/csv")   return "csv";
    return fallback || "bin";
}

function dataUrlToBytes(dataUrl: string): { mime: string; bytes: Uint8Array } | null {
    const m = dataUrl.match(/^data:([\w\-.+\/]+);base64,(.+)$/);
    if (!m) return null;
    const mime = m[1];
    const bin = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
    return { mime, bytes: bin };
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

    if (!body.type || !VALID_TYPES.has(body.type)) {
        return errorResponse("type must be one of: bug, suggestion, question, general", 400);
    }
    const priority = body.priority && VALID_PRIORITIES.has(body.priority) ? body.priority : "normal";
    if (!body.message || body.message.trim().length < 10) {
        return errorResponse("message must be at least 10 characters", 400);
    }
    if (!body.page_url || body.page_url.length > 1000) {
        return errorResponse("page_url is required (≤ 1000 chars)", 400);
    }

    // ----- Pull user_id from JWT (if any) -----------------------------------
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    let userId: string | null = null;
    let userEmail: string | null = null;
    let userRole = "anonymous";
    if (jwt) {
        const payload = getJwtPayload(jwt);
        if (payload && payload.role !== "anon" && typeof payload.sub === "string") {
            userId = payload.sub;
            userEmail = (payload.email as string) || null;
            userRole = "authenticated";
        }
    }

    const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        { auth: { persistSession: false } },
    );

    // Resolve actual role from DB tables (mirror InvestPro pattern)
    if (userId) {
        try {
            const { data: staff } = await supabase
                .from("staff_roles").select("user_id, role").eq("user_id", userId).maybeSingle();
            if (staff) userRole = (staff.role as string) || "staff";
        } catch (e) { console.warn("[feedback-submit] staff_roles lookup failed", e); }
        if (userRole === "authenticated") {
            const { data: p } = await supabase
                .from("partners").select("user_id").eq("user_id", userId).maybeSingle();
            if (p) userRole = "partner";
        }
        if (userRole === "authenticated") {
            const { data: b } = await supabase
                .from("businesses").select("owner_user_id").eq("owner_user_id", userId).maybeSingle();
            if (b) userRole = "business";
        }
        if (userRole === "authenticated") userRole = "customer";
    }

    // ----- Primary screenshot (back-compat) --------------------------------
    let screenshotPath: string | null = null;
    if (body.screenshot_b64 && body.screenshot_b64.length > 0) {
        try {
            const dataMatch = body.screenshot_b64.match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/);
            if (!dataMatch) throw new Error("Unsupported image format");
            const mime = dataMatch[1];
            const ext = safeExtFromMime(mime, "png");
            const bin = Uint8Array.from(atob(dataMatch[2]), (c) => c.charCodeAt(0));
            if (bin.byteLength > MAX_ATTACHMENT_BYTES) throw new Error("Screenshot too large");
            const filename = `${Date.now()}-${crypto.randomUUID()}.${ext}`;
            const { error: upErr } = await supabase.storage
                .from("feedback-screenshots")
                .upload(filename, bin, { contentType: mime, upsert: false });
            if (upErr) throw upErr;
            screenshotPath = filename;
        } catch (e) {
            console.warn("Screenshot upload failed:", e);
        }
    }

    let subject = (body.subject || "").trim();
    if (!subject) {
        subject = body.message.trim().split(/\n|\.|\?/)[0].slice(0, 80);
    }

    // ----- Insert the feedback row -----------------------------------------
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

    // ----- Additional attachments (drag-drop / paste / multi-upload) -------
    let attachmentsUploaded = 0;
    const attList = Array.isArray(body.attachments) ? body.attachments.slice(0, MAX_ATTACHMENTS) : [];
    for (const att of attList) {
        if (!att || !att.data_url || !att.name) continue;
        const parsed = dataUrlToBytes(att.data_url);
        if (!parsed) continue;
        if (parsed.bytes.byteLength > MAX_ATTACHMENT_BYTES) continue;
        const ext = safeExtFromMime(parsed.mime, (att.name.split(".").pop() || "bin"));
        const safeName = att.name.replace(/[^\w.\-]+/g, "_").slice(0, 100);
        const path = `${data.id}/${Date.now()}-${crypto.randomUUID()}-${safeName}`;
        try {
            const { error: upErr } = await supabase.storage
                .from("feedback-attachments")
                .upload(path, parsed.bytes, { contentType: parsed.mime, upsert: false });
            if (upErr) {
                console.warn("Attachment upload failed:", upErr);
                continue;
            }
            await supabase.from("feedback_attachments").insert({
                feedback_id: data.id,
                file_name: safeName,
                mime_type: parsed.mime,
                size_bytes: parsed.bytes.byteLength,
                storage_path: path,
                uploaded_by: userId,
            });
            attachmentsUploaded++;
        } catch (e) {
            console.warn("Attachment write failed:", e);
        }
    }

    return json({ ...data, attachments_uploaded: attachmentsUploaded }, 201);
});
