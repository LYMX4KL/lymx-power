// =============================================================================
// LYMX Power — Inbound Email Forwarder (Cloudflare Email Worker)
// =============================================================================
//
// Purpose:
//   Replaces per-partner Cloudflare Email Routing rules. Receives ALL inbound
//   mail to *@getlymx.com via a single Catch-All Email Routing trigger, looks
//   up the partner in Supabase, and re-sends the message to the partner's
//   personal email via Resend.
//
// Why:
//   The previous architecture used Cloudflare Email Routing routing rules
//   pointing to each partner's verified destination address. That gate
//   ("destination must click a verify link from notify.cloudflare.com")
//   broke for ~6 of 7 partners because the verify email lands in Promotions
//   or Spam and partners never see it. We can't bypass it from the CF API
//   (POST /routing/rules returns 404 if destination isn't verified). The
//   Worker pattern routes around the entire problem — partners no longer
//   need to verify their address in Cloudflare; the Worker just sends mail
//   to whatever address is on their `partners.contact_email`.
//
// Flow:
//   1. Mail arrives at <local>@getlymx.com → CF Email Routing catch-all
//   2. CF invokes this Worker with the message
//   3. Worker queries Supabase REST: SELECT * FROM partner_emails WHERE full_email = ?
//   4. If hit: parses MIME, sends via Resend FROM 'forwarder@getlymx.com'
//      with Reply-To: <original sender> so Helen's reply goes to the right place
//   5. If miss: falls back to message.forward(CATCH_ALL_FALLBACK) — Kenny's
//      gmail, which IS a verified destination, so this works as a last resort
//      for unknown addresses (e.g. typo'd local-parts)
//
// Deployment:
//   1. Cloudflare dashboard → Workers & Pages → Create Worker
//      name: lymx-inbound-forwarder
//      paste this file's contents
//   2. Set environment variables (Workers → Settings → Variables):
//      SUPABASE_URL                = https://apffootxzfwmtyjlnteo.supabase.co
//      SUPABASE_SERVICE_ROLE_KEY   = <service role JWT>
//      RESEND_API_KEY              = <Resend API key>
//      CATCH_ALL_FALLBACK          = zhongkennylin@gmail.com
//      FORWARDER_FROM_ADDRESS      = forwarder@getlymx.com
//   3. Email Routing → Routes → Catch-All → Edit → Action: Send to a Worker
//      Worker: lymx-inbound-forwarder
//   4. Delete the per-partner Custom Address rules (dave.bacay, rachel.ann,
//      kenny.lin, smoke.test.partner) — Worker now handles all of them
//
// No more destination-verification dance. No more orphaned partners. Forever.
// =============================================================================

interface Env {
    SUPABASE_URL: string;
    SUPABASE_SERVICE_ROLE_KEY: string;
    RESEND_API_KEY: string;
    CATCH_ALL_FALLBACK: string;        // e.g. "zhongkennylin@gmail.com"
    FORWARDER_FROM_ADDRESS: string;    // e.g. "forwarder@getlymx.com"
}

interface CFEmailMessage {
    readonly from: string;
    readonly to: string;
    readonly headers: Headers;
    readonly raw: ReadableStream<Uint8Array>;
    readonly rawSize: number;
    setReject(reason: string): void;
    forward(rcptTo: string, headers?: Headers): Promise<void>;
}

// -----------------------------------------------------------------------------
// Raw MIME parsing — minimal, dependency-free. Handles 99% of partner replies.
// -----------------------------------------------------------------------------

async function readRaw(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
    }
    let total = 0;
    for (const c of chunks) total += c.byteLength;
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
    // Decode as latin1 first so we don't munge non-UTF-8 bytes during header parsing.
    // Bodies that are UTF-8 will be re-decoded via the right charset when we
    // hit Content-Transfer-Encoding handling below.
    return String.fromCharCode(...buf);
}

function splitHeadersBody(raw: string): { headerBlock: string; body: string } {
    // RFC 5322: headers and body are separated by a single empty line.
    const m = raw.match(/\r?\n\r?\n/);
    if (!m || m.index === undefined) return { headerBlock: raw, body: "" };
    return {
        headerBlock: raw.substring(0, m.index),
        body: raw.substring(m.index + m[0].length),
    };
}

function parseHeaders(headerBlock: string): Record<string, string> {
    // Unfold continuation lines (lines starting with whitespace are part of previous header)
    const unfolded = headerBlock.replace(/\r?\n[\t ]+/g, " ");
    const headers: Record<string, string> = {};
    for (const line of unfolded.split(/\r?\n/)) {
        const i = line.indexOf(":");
        if (i === -1) continue;
        const name = line.substring(0, i).trim().toLowerCase();
        const value = line.substring(i + 1).trim();
        // For duplicate headers (Received:, etc.) keep the first occurrence —
        // that's the safe default for From/Subject/Content-Type which we care about.
        if (headers[name] === undefined) headers[name] = value;
    }
    return headers;
}

function decodeMimeWord(s: string): string {
    // RFC 2047 encoded-word decoder. Handles =?UTF-8?B?...?= and =?UTF-8?Q?...?=
    return s.replace(/=\?([^?]+)\?([QqBb])\?([^?]*)\?=/g, (_full, charset, enc, data) => {
        try {
            if (enc.toLowerCase() === "b") {
                const decoded = atob(data);
                const bytes = new Uint8Array(decoded.length);
                for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
                return new TextDecoder(charset.toLowerCase()).decode(bytes);
            } else {
                const cleaned = data.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_m: string, hex: string) =>
                    String.fromCharCode(parseInt(hex, 16))
                );
                const bytes = new Uint8Array(cleaned.length);
                for (let i = 0; i < cleaned.length; i++) bytes[i] = cleaned.charCodeAt(i);
                return new TextDecoder(charset.toLowerCase()).decode(bytes);
            }
        } catch { return data; }
    });
}

function decodeBody(body: string, encoding: string, charset: string): string {
    const enc = (encoding || "7bit").toLowerCase();
    let bytesStr: string;
    if (enc === "base64") {
        try {
            bytesStr = atob(body.replace(/\s/g, ""));
        } catch { return body; }
    } else if (enc === "quoted-printable") {
        bytesStr = body
            .replace(/=\r?\n/g, "")
            .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
    } else {
        bytesStr = body;
    }
    // Re-decode through TextDecoder using the declared charset
    try {
        const bytes = new Uint8Array(bytesStr.length);
        for (let i = 0; i < bytesStr.length; i++) bytes[i] = bytesStr.charCodeAt(i) & 0xff;
        return new TextDecoder((charset || "utf-8").toLowerCase()).decode(bytes);
    } catch {
        return bytesStr;
    }
}

function extractCharset(contentType: string): string {
    const m = contentType.match(/charset="?([^";\s]+)"?/i);
    return m ? m[1] : "utf-8";
}

function extractBoundary(contentType: string): string | null {
    const m = contentType.match(/boundary="?([^";\s]+)"?/i);
    return m ? m[1] : null;
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractBody(headers: Record<string, string>, body: string): { text?: string; html?: string } {
    const ct = headers["content-type"] || "text/plain; charset=utf-8";
    const cte = headers["content-transfer-encoding"] || "7bit";
    const charset = extractCharset(ct);

    if (ct.toLowerCase().startsWith("multipart/")) {
        const boundary = extractBoundary(ct);
        if (!boundary) return { text: body };
        const parts = body.split(new RegExp("\\r?\\n?--" + escapeRegex(boundary)));
        const out: { text?: string; html?: string } = {};
        for (const partRaw of parts) {
            const part = partRaw.replace(/^\r?\n/, "");
            if (!part.trim() || part.trim() === "--") continue;
            const { headerBlock: ph, body: pb } = splitHeadersBody(part);
            const phs = parseHeaders(ph);
            const pct = (phs["content-type"] || "text/plain").toLowerCase();
            if (pct.startsWith("multipart/")) {
                const inner = extractBody(phs, pb);
                if (inner.text && !out.text) out.text = inner.text;
                if (inner.html && !out.html) out.html = inner.html;
            } else if (pct.startsWith("text/plain") && !out.text) {
                out.text = decodeBody(pb, phs["content-transfer-encoding"] || "", extractCharset(phs["content-type"] || ""));
            } else if (pct.startsWith("text/html") && !out.html) {
                out.html = decodeBody(pb, phs["content-transfer-encoding"] || "", extractCharset(phs["content-type"] || ""));
            }
        }
        return out;
    }

    const decoded = decodeBody(body, cte, charset);
    if (ct.toLowerCase().startsWith("text/html")) return { html: decoded };
    return { text: decoded };
}

function parseEmailAddress(value: string): { name: string; email: string } {
    const m = value.match(/^(.*?)\s*<([^>]+)>\s*$/);
    if (m) {
        return {
            name: decodeMimeWord(m[1].replace(/^["']|["']$/g, "").trim()),
            email: m[2].trim().toLowerCase(),
        };
    }
    return { name: "", email: value.trim().toLowerCase() };
}

// -----------------------------------------------------------------------------
// Main handler
// -----------------------------------------------------------------------------

export default {
    async email(message: CFEmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
        const toAddr = message.to.toLowerCase();
        const reqStart = Date.now();

        // 1) Supabase REST lookup: which partner owns this address?
        let forwardTo: string | null = null;
        let partnerName: string | null = null;
        try {
            const url =
                `${env.SUPABASE_URL}/rest/v1/partner_emails` +
                `?full_email=eq.${encodeURIComponent(toAddr)}` +
                `&status=eq.active` +
                `&select=full_email,partner:partners(contact_email,display_name,legal_name)`;
            const resp = await fetch(url, {
                headers: {
                    "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
                    "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
                    "Accept": "application/json",
                },
            });
            if (resp.ok) {
                const rows = await resp.json() as Array<{
                    full_email: string;
                    partner: { contact_email: string; display_name: string; legal_name: string } | null;
                }>;
                if (rows.length && rows[0].partner?.contact_email) {
                    forwardTo = rows[0].partner.contact_email;
                    partnerName = rows[0].partner.display_name || rows[0].partner.legal_name || null;
                }
            } else {
                console.warn(`[lymx-inbound-forwarder] Supabase REST ${resp.status} for ${toAddr}`);
            }
        } catch (e) {
            console.warn(`[lymx-inbound-forwarder] Supabase lookup threw: ${(e as Error).message}`);
        }

        if (!forwardTo) {
            // Unknown address — fall back to admin inbox (Kenny's gmail = verified CF destination)
            console.log(`[lymx-inbound-forwarder] No partner_emails match for ${toAddr}; CF-forwarding to ${env.CATCH_ALL_FALLBACK}`);
            try {
                await message.forward(env.CATCH_ALL_FALLBACK);
            } catch (e) {
                console.warn(`[lymx-inbound-forwarder] CF .forward() fallback failed: ${(e as Error).message}`);
            }
            return;
        }

        // 2) Parse raw MIME
        const raw = await readRaw(message.raw);
        const { headerBlock, body } = splitHeadersBody(raw);
        const headers = parseHeaders(headerBlock);

        const origFrom = parseEmailAddress(headers["from"] || message.from);
        const origSubject = decodeMimeWord(headers["subject"] || "(no subject)");
        const messageId = headers["message-id"] || "";
        const { text, html } = extractBody(headers, body);

        // 3) Send via Resend
        // From: "<Sender Name> via LYMX <forwarder@getlymx.com>"  — domain matches a Resend-verified domain
        // Reply-To: original sender — so a "Reply" in partner's gmail naturally goes to the right person
        const fromDisplay = (origFrom.name || origFrom.email).replace(/[<>"]/g, "");
        const fromHeader = `${fromDisplay} via LYMX <${env.FORWARDER_FROM_ADDRESS}>`;

        const resendBody: Record<string, unknown> = {
            from: fromHeader,
            to: forwardTo,
            reply_to: origFrom.email,
            subject: origSubject,
            headers: {
                "X-LYMX-Original-To": toAddr,
                "X-LYMX-Original-From": origFrom.email,
                "X-LYMX-Forwarded-By": "lymx-inbound-forwarder/1",
                ...(messageId ? { "X-LYMX-Original-Message-Id": messageId.slice(0, 250) } : {}),
            },
        };
        if (html) resendBody.html = html;
        if (text) resendBody.text = text;
        if (!html && !text) resendBody.text = "(empty body)";

        try {
            const resp = await fetch("https://api.resend.com/emails", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${env.RESEND_API_KEY}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(resendBody),
            });
            if (!resp.ok) {
                const errText = await resp.text();
                console.warn(`[lymx-inbound-forwarder] Resend ${resp.status} forwarding ${toAddr} → ${forwardTo}: ${errText}`);
                // Last-resort: CF-forward to admin so the message isn't lost
                try { await message.forward(env.CATCH_ALL_FALLBACK); } catch { /* swallow */ }
                return;
            }
            const ok = await resp.json() as { id: string };
            const elapsed = Date.now() - reqStart;
            console.log(`[lymx-inbound-forwarder] ${toAddr} → ${forwardTo} (${partnerName ?? "unknown partner"}) via Resend ${ok.id} in ${elapsed}ms`);
        } catch (e) {
            console.warn(`[lymx-inbound-forwarder] Resend send threw: ${(e as Error).message}`);
            try { await message.forward(env.CATCH_ALL_FALLBACK); } catch { /* swallow */ }
        }
    },
};
