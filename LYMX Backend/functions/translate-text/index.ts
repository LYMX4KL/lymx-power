// =============================================================================
// LYMX Power — Translate Text
// =============================================================================
// POST /functions/v1/translate-text
//
// Translates a string into a target locale, with a server-side cache so the
// same (text, source, target) tuple is never re-translated. Used by:
//   * the per-message Translate button on conversations
//   * the email/SMS sender functions (when pre-translated templates don't exist)
//   * the static-page translation tool (offline batch run)
//
// PROVIDERS (in priority order, first available wins):
//   1. DeepL              — set DEEPL_API_KEY in Supabase secrets. Best quality
//                           for ES + zh-CN + JA. Doesn't support zh-TW (use auto-
//                           conversion from zh-CN) or ko (not yet, as of 2026-05).
//   2. Google Translate   — set GOOGLE_TRANSLATE_API_KEY. Covers all 6 locales.
//   3. Anthropic Claude   — set ANTHROPIC_API_KEY. Best for brand-voice marketing
//                           copy. Most expensive. Used for ko/zh-TW if DeepL is
//                           the only other option, OR explicitly via provider=claude.
//
// REQUEST BODY:
//   {
//     text: string,
//     target_locale: "es"|"zh-CN"|"zh-TW"|"ko"|"ja"|"en",
//     source_locale?: string,     // default "auto"
//     provider?: "deepl"|"google"|"claude",   // override auto-pick
//     context?: string            // optional hint for Claude (e.g. "marketing email")
//   }
//
// RESPONSE (200):
//   {
//     ok: true,
//     translated_text: string,
//     source_locale: string,
//     target_locale: string,
//     provider: string,
//     cached: boolean
//   }
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const err  = (m: string, s = 400) => json({ ok: false, error: m }, s);

const SUPPORTED = ["en", "es", "zh-CN", "zh-TW", "ko", "ja"];

async function sha256(text: string): Promise<string> {
    const buf = new TextEncoder().encode(text);
    const hashBuf = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ---- DeepL --------------------------------------------------------------
function deeplLangCode(loc: string): string {
    // DeepL uses uppercase 2-letter codes for most, with EN-US/EN-GB/PT-BR distinctions.
    switch (loc) {
        case "en":    return "EN-US";
        case "es":    return "ES";
        case "zh-CN": return "ZH";        // DeepL's Chinese is Simplified
        case "zh-TW": return "ZH-HANT";   // beta
        case "ja":    return "JA";
        case "ko":    return "KO";
        default:      return "EN-US";
    }
}

async function translateWithDeepL(key: string, text: string, source: string, target: string): Promise<string> {
    const body = new URLSearchParams({
        text,
        target_lang: deeplLangCode(target),
    });
    if (source && source !== "auto") body.append("source_lang", deeplLangCode(source).split("-")[0]);
    const r = await fetch("https://api-free.deepl.com/v2/translate", {
        method: "POST",
        headers: {
            "Authorization": `DeepL-Auth-Key ${key}`,
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
    });
    if (!r.ok) {
        // Try the paid endpoint if free key was rejected
        const r2 = await fetch("https://api.deepl.com/v2/translate", {
            method: "POST",
            headers: { "Authorization": `DeepL-Auth-Key ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
            body: body.toString(),
        });
        if (!r2.ok) throw new Error(`DeepL HTTP ${r.status} / ${r2.status}`);
        const j2 = await r2.json();
        return j2.translations?.[0]?.text || text;
    }
    const j = await r.json();
    return j.translations?.[0]?.text || text;
}

// ---- Google Translate ---------------------------------------------------
async function translateWithGoogle(key: string, text: string, source: string, target: string): Promise<string> {
    const url = `https://translation.googleapis.com/language/translate/v2?key=${key}`;
    const body: Record<string, unknown> = { q: text, target, format: "text" };
    if (source && source !== "auto") body.source = source;
    const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Google HTTP ${r.status}`);
    const j = await r.json();
    return j.data?.translations?.[0]?.translatedText || text;
}

// ---- Anthropic Claude Haiku ---------------------------------------------
async function translateWithClaude(key: string, text: string, source: string, target: string, context?: string): Promise<string> {
    const sourceNote = source && source !== "auto" ? `from ${source}` : "";
    const contextNote = context ? `\nContext: ${context}` : "";
    const targetName = ({
        "en": "English", "es": "Spanish (Español)", "zh-CN": "Simplified Chinese (简体中文)",
        "zh-TW": "Traditional Chinese (繁體中文)", "ko": "Korean (한국어)", "ja": "Japanese (日本語)",
    } as Record<string, string>)[target] || target;
    const prompt = `Translate the following text ${sourceNote} to ${targetName}. Preserve formatting, line breaks, and any placeholder tokens like {{name}} or [link]. Translate ONLY — return just the translated text with no preamble, no explanation, no quotation marks.${contextNote}\n\nText to translate:\n${text}`;
    const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: Math.min(4096, Math.max(512, text.length * 3)),
            messages: [{ role: "user", content: prompt }],
        }),
    });
    if (!r.ok) {
        const errBody = await r.text();
        throw new Error(`Anthropic HTTP ${r.status}: ${errBody.slice(0, 200)}`);
    }
    const j = await r.json();
    const content = j.content?.[0]?.text || text;
    return content.trim();
}

// ---- Picker -------------------------------------------------------------
function pickProvider(target: string, override?: string): { kind: "deepl" | "google" | "claude"; reason: string } | null {
    const DEEPL    = Deno.env.get("DEEPL_API_KEY");
    const GOOGLE   = Deno.env.get("GOOGLE_TRANSLATE_API_KEY");
    const ANTHROPIC = Deno.env.get("ANTHROPIC_API_KEY");
    if (override === "claude" && ANTHROPIC) return { kind: "claude", reason: "explicit" };
    if (override === "google" && GOOGLE)    return { kind: "google", reason: "explicit" };
    if (override === "deepl"  && DEEPL)     return { kind: "deepl",  reason: "explicit" };
    // Auto-pick:
    // DeepL is best for ES + zh-CN + ja. Falls back to Google or Claude for ko/zh-TW.
    if (DEEPL && (target === "es" || target === "zh-CN" || target === "ja" || target === "en")) {
        return { kind: "deepl", reason: "best-quality" };
    }
    if (GOOGLE) return { kind: "google", reason: "covers-all-locales" };
    if (ANTHROPIC) return { kind: "claude", reason: "fallback-claude-haiku" };
    if (DEEPL) return { kind: "deepl", reason: "deepl-only-key" };
    return null;
}

// =========================================================================
serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST") return err("Method not allowed", 405);

    const SB_URL = Deno.env.get("SUPABASE_URL");
    const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!SB_URL || !SB_KEY) return err("Server config missing", 500);
    const supabase = createClient(SB_URL, SB_KEY);

    let body: any;
    try { body = await req.json(); } catch { return err("Invalid JSON", 400); }

    const text = String(body.text || "").trim();
    if (!text) return err("text is required", 400);
    const target = String(body.target_locale || "");
    if (!SUPPORTED.includes(target)) return err(`target_locale must be one of: ${SUPPORTED.join(", ")}`, 400);
    const source = String(body.source_locale || "auto");

    // Same-language passthrough.
    if (source === target) {
        return json({ ok: true, translated_text: text, source_locale: source, target_locale: target, provider: "noop", cached: false });
    }

    // ---- Cache lookup -------------------------------------------------
    const textHash = await sha256(text);
    const { data: cached } = await supabase
        .from("translation_cache")
        .select("translated_text, provider")
        .eq("text_hash", textHash)
        .eq("source_locale", source)
        .eq("target_locale", target)
        .maybeSingle();
    if (cached) {
        // Bump usage stats (best-effort)
        await supabase.from("translation_cache").update({
            last_used_at: new Date().toISOString(),
        }).eq("text_hash", textHash).eq("source_locale", source).eq("target_locale", target);
        return json({
            ok: true,
            translated_text: cached.translated_text,
            source_locale: source,
            target_locale: target,
            provider: cached.provider,
            cached: true,
        });
    }

    // ---- Pick provider + call ----------------------------------------
    const pick = pickProvider(target, body.provider);
    if (!pick) return err("No translation provider configured. Set DEEPL_API_KEY or GOOGLE_TRANSLATE_API_KEY or ANTHROPIC_API_KEY in Supabase secrets.", 500);

    let translated: string;
    try {
        if (pick.kind === "deepl") {
            translated = await translateWithDeepL(Deno.env.get("DEEPL_API_KEY")!, text, source, target);
        } else if (pick.kind === "google") {
            translated = await translateWithGoogle(Deno.env.get("GOOGLE_TRANSLATE_API_KEY")!, text, source, target);
        } else {
            translated = await translateWithClaude(Deno.env.get("ANTHROPIC_API_KEY")!, text, source, target, body.context);
        }
    } catch (e: any) {
        return err(`Translation failed (${pick.kind}): ${e.message || "unknown"}`, 502);
    }

    // ---- Cache write (best-effort) -----------------------------------
    await supabase.from("translation_cache").insert({
        text_hash: textHash,
        source_locale: source,
        target_locale: target,
        source_text: text,
        translated_text: translated,
        provider: pick.kind,
        char_count: text.length,
    });

    return json({
        ok: true,
        translated_text: translated,
        source_locale: source,
        target_locale: target,
        provider: pick.kind,
        cached: false,
    });
});
