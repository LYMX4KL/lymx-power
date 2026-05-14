// =============================================================================
// LYMX Power — Chat Send Endpoint
// =============================================================================
// POST /functions/v1/chat-send
//
// Server-side chat send: validates the caller is a member of the group,
// extracts @mentions, snapshots the author's display name, fans out mention
// notifications. Mirrors InvestPro's team-chat.js send action.
//
// REQUEST BODY:
//   {
//     "group_id":   "uuid",
//     "body":       "Hey @helen.chen, can you check the broadcast?",
//     "reply_to":   "uuid" | null,           (optional - quote-reply)
//     "attachments": [{ "storage_path": "chat/...", "file_name": "x.png",
//                        "mime_type": "image/png", "size_bytes": 1234 }]
//   }
//
// RESPONSE (200):
//   { "id": "<message_uuid>", "mentions": ["uuid", ...] }
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
const err = (msg: string, status = 400) => json({ error: msg }, status);

function userFromJwt(authHeader: string | null): string | null {
    if (!authHeader) return null;
    const tok = authHeader.replace(/^Bearer\s+/i, "").trim();
    const parts = tok.split(".");
    if (parts.length !== 3) return null;
    try {
        const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
        return payload.sub || null;
    } catch { return null; }
}

// Pull @handles out of body text. A handle matches /@([a-z0-9._-]+)/i — same
// pattern as InvestPro. We resolve them against v_chat_members_directory
// (handle_short = email local-part, OR display_name slug).
function extractHandles(text: string): string[] {
    const matches = text.match(/@[A-Za-z0-9._-]+/g) || [];
    return Array.from(new Set(matches.map(m => m.slice(1).toLowerCase())));
}

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST")    return err("Method not allowed", 405);

    const userId = userFromJwt(req.headers.get("Authorization"));
    if (!userId) return err("Sign in required.", 401);

    let body: any;
    try { body = await req.json(); } catch { return err("Invalid JSON.", 400); }

    const groupId   = String(body?.group_id || "").trim();
    const text      = String(body?.body     || "").trim();
    const replyTo   = body?.reply_to ? String(body.reply_to) : null;
    const attachments = Array.isArray(body?.attachments) ? body.attachments : [];

    if (!groupId) return err("Missing group_id.", 400);
    if (!text)    return err("Message body required.", 400);
    if (text.length > 8000) return err("Message too long (max 8000 chars).", 400);

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SVC_KEY      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase     = createClient(SUPABASE_URL, SVC_KEY);

    // 1) Verify caller is a member of the channel
    const { data: mem, error: memErr } = await supabase
        .from("chat_group_members")
        .select("user_id, role")
        .eq("group_id", groupId)
        .eq("user_id", userId)
        .maybeSingle();
    if (memErr) return err(`Membership lookup failed: ${memErr.message}`, 500);
    if (!mem)   return err("You're not a member of this channel.", 403);

    // 2) Resolve @mentions → user_ids. Pull all members of this channel, match
    //    handle_short (email local-part) OR slugified display_name.
    const handles = extractHandles(text);
    let mentionedUserIds: string[] = [];
    if (handles.length) {
        const { data: dir } = await supabase
            .from("v_chat_members_directory")
            .select("user_id, display_name, handle_short, email")
            .limit(2000);
        if (dir) {
            const slug = (s: string) => (s || "").toLowerCase().replace(/\s+/g, ".").replace(/[^a-z0-9._-]/g, "");
            for (const d of dir as any[]) {
                const ds = slug(d.display_name);
                const hs = (d.handle_short || "").toLowerCase();
                if (handles.includes(hs) || handles.includes(ds)) {
                    mentionedUserIds.push(d.user_id);
                }
            }
        }
        mentionedUserIds = Array.from(new Set(mentionedUserIds));
    }

    // 3) Insert message
    const insertPayload: any = {
        group_id:    groupId,
        sender_id:   userId,
        body:        text,
        reply_to:    replyTo,
        mentions:    mentionedUserIds,
        attachments: attachments.map((a: any) => ({
            storage_path: String(a?.storage_path || ""),
            file_name:    String(a?.file_name    || ""),
            mime_type:    String(a?.mime_type    || ""),
            size_bytes:   Number(a?.size_bytes   || 0),
        })),
    };
    const { data: inserted, error: insErr } = await supabase
        .from("chat_messages")
        .insert(insertPayload)
        .select("id")
        .single();
    if (insErr) return err(`Insert failed: ${insErr.message}`, 500);

    const messageId = inserted!.id;

    // 4) Persist file metadata to chat_attachments
    if (attachments.length) {
        await supabase.from("chat_attachments").insert(
            attachments.map((a: any) => ({
                message_id:   messageId,
                storage_path: String(a?.storage_path || ""),
                file_name:    String(a?.file_name    || ""),
                mime_type:    String(a?.mime_type    || ""),
                size_bytes:   Number(a?.size_bytes   || 0),
                uploaded_by:  userId,
            })),
        );
    }

    // 5) Fan out mention notifications
    if (mentionedUserIds.length) {
        await supabase.from("chat_mention_notifications").insert(
            mentionedUserIds.map(uid => ({
                message_id:     messageId,
                group_id:       groupId,
                mentioned_user: uid,
            })),
        );
    }

    return json({
        id: messageId,
        mentions: mentionedUserIds,
        attachments: attachments.length,
    });
});
