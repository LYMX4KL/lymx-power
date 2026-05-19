// =============================================================================
// LYMX Power — Feedback AI Assist
// =============================================================================
// POST /functions/v1/feedback-ai-assist
//
// AI helper for the Send Feedback widget (lymx-feedback.js v2).
//
// Three modes:
//   mode='polish'     — rewrite rough user notes into a clean report.
//                       Returns { polished, summary }.
//   mode='suggest'    — live "missing info" tips while user types.
//                       Returns { tips: [...] } (max 3, may be empty).
//   mode='categorize' — silent auto-classification at send-time.
//                       Returns { suggested_category, confidence, summary }.
//
// AUTH:
//   - anon (just the apikey header) — allowed. LYMX feedback can be anonymous.
//   - user JWT — also allowed; we just don't currently use it for logic.
//
// COST: ~$0.0003-0.0008 per call with Claude Haiku. Output tokens capped.
//
// ENV required:
//   ANTHROPIC_API_KEY   — set in Supabase Dashboard → Edge Functions → Secrets
//   AI_MODEL            — optional, defaults to "claude-haiku-4-5-20251001"
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const DEFAULT_MODEL = Deno.env.get("AI_MODEL") || "claude-haiku-4-5-20251001";
const ANTHROPIC_VERSION = "2023-06-01";

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

const SYSTEM_POLISH = `You are helping a non-technical user of LYMX (a local-business rewards network in Las Vegas) submit clearer feedback. They have typed rough notes describing something they noticed in the LYMX site or app — could be a bug, a suggestion, a question, or general praise.

Your job: rewrite their note into a clear, structured report the engineering team can act on, WITHOUT inventing facts they didn't say.

Rules:
- Keep their voice. Don't sound like a corporate template.
- If they described a problem: structure as (1) What happened (2) What they expected (3) Steps if known. Skip sections they didn't provide info for.
- If they made a suggestion: clarify the proposed change and the use case.
- If they asked a question: rephrase clearly.
- DO NOT add new claims, technical guesses, or hypotheses the user didn't make. If something is missing, just leave it out — don't invent it.
- Maximum 4 short paragraphs. Use line breaks, not markdown headers.
- Also produce a 1-line summary for the engineering triage dashboard.

Output STRICT JSON only. No markdown, no preamble:
{
  "polished": "rewritten text here",
  "summary": "one-line summary"
}`;

const SYSTEM_SUGGEST = `You are helping a LYMX user file useful feedback. They have started typing a message in the feedback widget. Your job is to look at what they've written so far and suggest UP TO 3 specific pieces of information they should ADD to make the report actionable — only if those things are actually missing.

Examples of useful tips:
- "What did you click right before it broke?"
- "What did you expect to happen instead?"
- "Roughly when did this happen — today, yesterday, last week?"
- "Does this happen every time, or just once?"
- "Which device — phone or computer?"

Be terse. Each tip should be a single sentence under 12 words, starting with a verb or question word. Skip tips that are obvious or already covered. If their message is detailed and clear, return an empty array.

Output STRICT JSON only:
{
  "tips": ["tip 1", "tip 2"]
}`;

const SYSTEM_CATEGORIZE = `You are classifying user feedback submitted in LYMX (local-business rewards network). Given a message, decide the most likely category:

- "bug": something is broken, not working, returning an error, missing data, behaving unexpectedly
- "suggestion": user wants a feature added, changed, or improved
- "question": user is asking how something works, not reporting a problem
- "general": none of the above clearly applies

Also generate a 1-line summary (max 12 words) for the triage dashboard.

Output STRICT JSON only:
{
  "suggested_category": "bug",
  "confidence": 0.85,
  "summary": "Wallet balance shows zero after redemption"
}`;

interface Body {
    mode?: string;
    message?: string;
    page_url?: string;
    page_title?: string;
    category?: string;
    role?: string;
}

serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }
    if (req.method !== "POST") {
        return json({ ok: false, error: "Method not allowed" }, 405);
    }

    const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY");
    if (!ANTHROPIC_KEY) {
        return json({ ok: false, error: "AI not configured. Set ANTHROPIC_API_KEY in Supabase secrets." }, 503);
    }

    let body: Body;
    try {
        body = await req.json();
    } catch {
        return json({ ok: false, error: "Invalid JSON body" }, 400);
    }

    const mode = String(body.mode || "").toLowerCase();
    const message = String(body.message || "").trim();
    if (!["polish", "suggest", "categorize"].includes(mode)) {
        return json({ ok: false, error: "mode must be polish | suggest | categorize" }, 400);
    }
    if (!message) {
        return json({ ok: false, error: "message is required" }, 400);
    }
    if (message.length < 8 && mode !== "polish") {
        return json({
            ok: true,
            mode,
            data: mode === "suggest"
                ? { tips: [] }
                : { suggested_category: null, confidence: 0, summary: "" },
        });
    }

    const systemPrompt = mode === "polish"
        ? SYSTEM_POLISH
        : mode === "suggest"
        ? SYSTEM_SUGGEST
        : SYSTEM_CATEGORIZE;

    const ctxLines: string[] = [];
    if (body.page_url)   ctxLines.push(`Page URL: ${body.page_url}`);
    if (body.page_title) ctxLines.push(`Page title: ${body.page_title}`);
    if (body.category)   ctxLines.push(`User-selected category: ${body.category}`);
    if (body.role)       ctxLines.push(`Submitter role: ${body.role}`);
    const ctx = ctxLines.length ? `Context:\n${ctxLines.join("\n")}\n\n` : "";
    const userTurn = `${ctx}User message:\n"""\n${message}\n"""`;

    const max_tokens = mode === "polish" ? 600 : mode === "suggest" ? 200 : 160;

    try {
        const r = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": ANTHROPIC_KEY,
                "anthropic-version": ANTHROPIC_VERSION,
            },
            body: JSON.stringify({
                model: DEFAULT_MODEL,
                max_tokens,
                system: systemPrompt,
                messages: [{ role: "user", content: userTurn }],
            }),
        });

        if (!r.ok) {
            const errTxt = await r.text();
            console.error("Anthropic error", r.status, errTxt);
            return json({ ok: false, error: `AI service error (${r.status})` }, 502);
        }

        const j = await r.json();
        const raw = j?.content?.[0]?.text || "";
        let parsed: Record<string, unknown> | null = null;
        try {
            parsed = JSON.parse(raw);
        } catch {
            const m = raw.match(/\{[\s\S]*\}/);
            if (m) {
                try { parsed = JSON.parse(m[0]); } catch { /* noop */ }
            }
        }
        if (!parsed) {
            console.error("AI did not return JSON:", raw.slice(0, 400));
            return json({ ok: false, error: "AI returned malformed response" }, 502);
        }

        return json({ ok: true, mode, data: parsed });
    } catch (e) {
        console.error("feedback-ai-assist crash", e);
        return json({ ok: false, error: (e as Error).message }, 500);
    }
});
