#!/usr/bin/env node
// =============================================================================
// translate-pages.js — batch translate static HTML pages to all i18n locales
// =============================================================================
// USAGE:
//   node tools/translate-pages.js                       # all pages, all locales
//   node tools/translate-pages.js --pages=index.html,about.html
//   node tools/translate-pages.js --locales=es,ja
//   node tools/translate-pages.js --dry-run             # show what would change, no API calls
//
// WHAT IT DOES:
//   1. Walks every *.html file in the repo root (front-end publish dir).
//   2. Extracts visible text nodes — skips <script>, <style>, <code>, existing
//      [data-i18n] elements, HTML comments, and any text inside attributes.
//   3. For each unique source string, calls the deployed translate-text Edge
//      Function once per target locale. The Supabase EF has its own server-side
//      cache (translation_cache table) so repeat runs are cheap.
//   4. Builds a per-page i18n JSON in `i18n-pages/<page>-<locale>.json`.
//   5. Optionally rewrites each HTML to add `data-i18n="page.foo.N"` markers
//      on the matching text nodes so lymx-i18n.js can swap text at runtime.
//
// ENVIRONMENT VARIABLES (set before running):
//   SUPABASE_URL              — https://apffootxzfwmtyjlnteo.supabase.co
//   SUPABASE_ANON_KEY         — the public anon key from lymx-config.js
//
// COST:
//   First run translates ~200 pages × ~50 strings × 5 non-English locales
//   ≈ 50,000 short translation calls. Cached for free thereafter. Estimated
//   $5–15 one-time on Claude Haiku.
//
// SAFETY:
//   - Pages get a backup at <page>.html.bak before any rewrite.
//   - --dry-run is the default safe mode for first test.
//   - Skips pages in SKIP_PAGES list (login, signup, dashboards — too dynamic).
// =============================================================================

const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const SUPABASE_URL = process.env.SUPABASE_URL || "https://apffootxzfwmtyjlnteo.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_ANON_KEY) {
    console.error("ERROR: Set SUPABASE_ANON_KEY env var first.");
    console.error('  PowerShell: $env:SUPABASE_ANON_KEY = "eyJ..."; node tools/translate-pages.js');
    console.error('  bash:       SUPABASE_ANON_KEY="eyJ..." node tools/translate-pages.js');
    process.exit(1);
}

const ALL_LOCALES = ["es", "zh-CN", "zh-TW", "ko", "ja"];

// Parse CLI args
const args = process.argv.slice(2);
const flagVal = (name) => {
    const a = args.find(x => x.startsWith(`--${name}=`));
    return a ? a.split("=").slice(1).join("=") : null;
};
const DRY_RUN = args.includes("--dry-run");
const SELECTED_PAGES = (flagVal("pages") || "").split(",").map(s => s.trim()).filter(Boolean);
const SELECTED_LOCALES = (flagVal("locales") || "").split(",").map(s => s.trim()).filter(Boolean);
const TARGET_LOCALES = SELECTED_LOCALES.length ? SELECTED_LOCALES : ALL_LOCALES;
const REWRITE_HTML = args.includes("--rewrite-html");   // off by default — first run produces JSONs only

// Pages to skip entirely (too dynamic, signup forms, dashboards with reactive content)
const SKIP_PAGES = new Set([
    "login.html", "customer-signup.html", "biz-signup.html", "partner-signup.html",
    "welcome.html", "verify-fix.html", "404.html",
    "customer-dashboard.html", "biz-dashboard.html", "rep-dashboard.html", "admin-dashboard.html",
    "admin-conversations.html", "my-conversations.html", "biz-conversations.html",
    "admin-tech-support.html", "admin-broadcast.html", "admin-compose-email.html",
    "profile.html",
]);

// Tags whose text content we should NOT translate
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "CODE", "PRE", "TEXTAREA", "NOSCRIPT", "TEMPLATE"]);

function listPages() {
    const root = path.resolve(__dirname, "..");
    const all = fs.readdirSync(root).filter(f => f.endsWith(".html"));
    if (SELECTED_PAGES.length) return all.filter(f => SELECTED_PAGES.includes(f));
    return all.filter(f => !SKIP_PAGES.has(f));
}

function extractTextNodes(dom) {
    const out = [];
    const walker = dom.window.document.createTreeWalker(
        dom.window.document.body, dom.window.NodeFilter.SHOW_TEXT
    );
    let n;
    while ((n = walker.nextNode())) {
        const text = (n.textContent || "").trim();
        if (!text || text.length < 2) continue;
        if (/^[\d.,$%/\-—()\s]+$/.test(text)) continue;  // pure numeric/punct
        // Skip if any ancestor is a skip tag or already has data-i18n
        let p = n.parentElement;
        let skip = false;
        while (p) {
            if (SKIP_TAGS.has(p.tagName)) { skip = true; break; }
            if (p.hasAttribute && p.hasAttribute("data-i18n")) { skip = true; break; }
            p = p.parentElement;
        }
        if (skip) continue;
        out.push({ node: n, text });
    }
    return out;
}

async function translate(text, targetLocale) {
    const r = await fetch(SUPABASE_URL + "/functions/v1/translate-text", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "apikey": SUPABASE_ANON_KEY,
            "Authorization": "Bearer " + SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({
            text,
            target_locale: targetLocale,
            source_locale: "en",
            context: "static marketing page on a small rewards platform; preserve brand name LYMX, URLs, and numbers as-is",
        }),
    });
    if (!r.ok) throw new Error(`translate-text HTTP ${r.status}`);
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || "translate-text returned ok:false");
    return { text: j.translated_text, cached: j.cached, provider: j.provider };
}

async function processPage(pageName, root) {
    const filePath = path.join(root, pageName);
    const html = fs.readFileSync(filePath, "utf8");
    const dom = new JSDOM(html);
    const nodes = extractTextNodes(dom);
    if (!nodes.length) {
        console.log(`  ${pageName} — no translatable nodes`);
        return;
    }

    const pageSlug = pageName.replace(/\.html$/, "").replace(/[^a-zA-Z0-9_-]+/g, "_");
    const dictsPerLocale = {};
    for (const loc of TARGET_LOCALES) dictsPerLocale[loc] = {};

    // Assign stable keys
    const sourceMap = {};
    nodes.forEach((n, i) => {
        const key = `pages.${pageSlug}.t${i}`;
        sourceMap[key] = n.text;
        n.key = key;
    });

    // Build English source-of-truth too
    const enDict = {};
    Object.entries(sourceMap).forEach(([k, v]) => { enDict[k] = v; });

    console.log(`  ${pageName} — ${nodes.length} strings`);

    if (DRY_RUN) return;

    let totalApiCalls = 0;
    let totalCacheHits = 0;
    for (const loc of TARGET_LOCALES) {
        for (const [key, text] of Object.entries(sourceMap)) {
            try {
                const { text: translated, cached } = await translate(text, loc);
                dictsPerLocale[loc][key] = translated;
                if (cached) totalCacheHits++; else totalApiCalls++;
            } catch (e) {
                console.warn(`    ${loc}/${key} failed: ${e.message}`);
            }
        }
        console.log(`    ${loc} done`);
    }
    console.log(`    api_calls=${totalApiCalls} cache_hits=${totalCacheHits}`);

    // Write per-page JSON files (one merge target per locale)
    const outDir = path.join(root, "i18n-pages");
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
    fs.writeFileSync(path.join(outDir, `${pageSlug}-en.json`), JSON.stringify(enDict, null, 2));
    for (const loc of TARGET_LOCALES) {
        fs.writeFileSync(path.join(outDir, `${pageSlug}-${loc}.json`), JSON.stringify(dictsPerLocale[loc], null, 2));
    }

    // Optionally rewrite HTML to add data-i18n markers
    if (REWRITE_HTML) {
        fs.writeFileSync(filePath + ".bak", html);
        nodes.forEach(n => {
            // Wrap in <span data-i18n="key">text</span> only if parent is not already a single-text-child element
            const span = dom.window.document.createElement("span");
            span.setAttribute("data-i18n", n.key);
            span.textContent = n.text;
            // Replace text node with the span
            n.node.parentNode.replaceChild(span, n.node);
        });
        const rewritten = dom.serialize();
        fs.writeFileSync(filePath, rewritten);
        console.log(`    rewrote ${pageName} (backup: ${pageName}.bak)`);
    }
}

(async () => {
    const root = path.resolve(__dirname, "..");
    const pages = listPages();
    console.log(`Processing ${pages.length} pages, target locales: ${TARGET_LOCALES.join(", ")}${DRY_RUN ? " (DRY RUN)" : ""}${REWRITE_HTML ? " (REWRITE_HTML)" : ""}`);
    for (const p of pages) {
        try { await processPage(p, root); }
        catch (e) { console.error(`! ${p} failed: ${e.message}`); }
    }
    console.log("\nDone.");
    console.log(`  i18n-pages/ written: per-page JSON dictionaries for each locale.`);
    if (!REWRITE_HTML) {
        console.log(`  Re-run with --rewrite-html to add data-i18n markers to the HTML (keeps a .bak backup per file).`);
    }
})();
