// =============================================================================
// Shared CORS headers for all Edge Functions
// =============================================================================
// Browsers block cross-origin POSTs unless the server says "you're allowed".
// These headers let our website at lymx.netlify.app call the functions.
// =============================================================================

export const corsHeaders = {
    "Access-Control-Allow-Origin": "*", // tighten to "https://lymx.netlify.app" in prod
    "Access-Control-Allow-Headers":
        "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Standard JSON response helper
export function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
        },
    });
}

// Error response helper
export function errorResponse(message: string, status = 400): Response {
    return jsonResponse({ error: message }, status);
}
