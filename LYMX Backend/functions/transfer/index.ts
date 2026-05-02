// =============================================================================
// LYMX Power — Transfer Endpoint
// =============================================================================
// POST /functions/v1/transfer
//
// Customer A sends LYMX to Customer B AT THE SAME BUSINESS.
// (LYMX is per-business — you can't move it across merchants.)
//
// Mechanically: two transaction rows, paired via `paired_transaction_id`.
//   - transfer_out: from sender's wallet (negative direction is implied by `type`)
//   - transfer_in:  to receiver's wallet
//
// AUTH: Sender (customer) only. JWT must match the wallet's customer.
//
// REQUEST HEADERS:
//   Authorization: Bearer <user_jwt>
//
// REQUEST BODY (JSON):
// {
//   "from_wallet_id": "uuid",         // sender's wallet
//   "to_phone": "+17025550100",       // OR to_customer_id OR to_wallet_id
//   "to_customer_id": "uuid",
//   "to_wallet_id": "uuid",
//   "lymx_amount": 100,               // positive
//   "note": "Lunch was great!"        // optional, attached to both legs
// }
//
// RESPONSE (201):
// {
//   "from_transaction_id": "uuid",
//   "to_transaction_id":   "uuid",
//   "from_wallet_id":      "uuid",
//   "to_wallet_id":        "uuid",
//   "lymx_amount":         100,
//   "from_new_balance":    900,
//   "to_new_balance":      400
// }
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

// --- CORS + response helpers -----------------------------------------------
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
const errorResponse = (message: string, status = 400) =>
    jsonResponse({ error: message }, status);

interface TransferBody {
    from_wallet_id: string;
    to_phone?: string;
    to_customer_id?: string;
    to_wallet_id?: string;
    lymx_amount: number;
    note?: string;
}

serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }
    if (req.method !== "POST") {
        return errorResponse("Method not allowed", 405);
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
        return errorResponse("Missing Authorization header", 401);
    }

    const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        { auth: { persistSession: false } }
    );

    // Verify the sender's JWT
    const { data: { user }, error: uErr } = await supabase.auth.getUser(
        authHeader.replace("Bearer ", "")
    );
    if (uErr || !user) {
        return errorResponse("Invalid auth token", 401);
    }

    let body: TransferBody;
    try {
        body = await req.json();
    } catch {
        return errorResponse("Invalid JSON", 400);
    }

    if (!body.from_wallet_id) {
        return errorResponse("from_wallet_id is required", 400);
    }
    if (typeof body.lymx_amount !== "number" || body.lymx_amount <= 0) {
        return errorResponse("lymx_amount must be a positive number", 400);
    }
    if (!body.to_phone && !body.to_customer_id && !body.to_wallet_id) {
        return errorResponse(
            "Provide one of: to_phone, to_customer_id, or to_wallet_id",
            400
        );
    }

    const lymxAmount = Math.floor(body.lymx_amount);

    // Step 1: load sender's wallet, verify ownership
    const { data: fromWallet, error: fwErr } = await supabase
        .from("wallets")
        .select("id, business_id, customer_id, balance")
        .eq("id", body.from_wallet_id)
        .maybeSingle();
    if (fwErr || !fromWallet) {
        return errorResponse("Sender wallet not found", 404);
    }
    // Verify the JWT user owns this wallet (i.e. the customer row points to user.id)
    const { data: senderCustomer } = await supabase
        .from("customers")
        .select("id, archived_at")
        .eq("id", fromWallet.customer_id)
        .maybeSingle();
    if (!senderCustomer) {
        return errorResponse("Sender customer record missing", 500);
    }
    const { data: senderUserCheck } = await supabase
        .from("customers")
        .select("id")
        .eq("user_id", user.id)
        .eq("id", fromWallet.customer_id)
        .maybeSingle();
    if (!senderUserCheck) {
        return errorResponse("You do not own this wallet", 403);
    }

    // Step 2: resolve receiver wallet (must be at SAME business)
    let toWallet: { id: string; customer_id: string; balance: number } | null = null;

    if (body.to_wallet_id) {
        const { data } = await supabase
            .from("wallets")
            .select("id, customer_id, business_id, balance")
            .eq("id", body.to_wallet_id)
            .maybeSingle();
        if (!data) return errorResponse("Receiver wallet not found", 404);
        if (data.business_id !== fromWallet.business_id) {
            return errorResponse("Cannot transfer LYMX between businesses", 400);
        }
        toWallet = data;
    } else {
        // Resolve receiver customer first
        let receiverCustomerId: string | null = null;
        if (body.to_customer_id) {
            receiverCustomerId = body.to_customer_id;
        } else if (body.to_phone) {
            const { data } = await supabase
                .from("customers")
                .select("id")
                .eq("phone", body.to_phone)
                .maybeSingle();
            if (!data) return errorResponse(`No customer with phone ${body.to_phone}`, 404);
            receiverCustomerId = data.id;
        }
        if (!receiverCustomerId) {
            return errorResponse("Could not resolve receiver", 400);
        }
        if (receiverCustomerId === fromWallet.customer_id) {
            return errorResponse("Cannot transfer to yourself", 400);
        }

        // Find or create receiver wallet at the SAME business
        const { data: existing } = await supabase
            .from("wallets")
            .select("id, customer_id, balance")
            .eq("customer_id", receiverCustomerId)
            .eq("business_id", fromWallet.business_id)
            .maybeSingle();
        if (existing) {
            toWallet = existing;
        } else {
            // Auto-provision receiver wallet (so a friend who hasn't used this business
            // yet can still receive LYMX)
            const { data: newWallet, error: nwErr } = await supabase
                .from("wallets")
                .insert({
                    customer_id: receiverCustomerId,
                    business_id: fromWallet.business_id,
                })
                .select("id, customer_id, balance")
                .single();
            if (nwErr || !newWallet) {
                return errorResponse(
                    `Receiver wallet provisioning failed: ${nwErr?.message}`,
                    500
                );
            }
            toWallet = newWallet;
        }
    }

    if (toWallet!.id === fromWallet.id) {
        return errorResponse("Cannot transfer to yourself", 400);
    }

    // Step 3: balance check
    const fromBalance = Number(fromWallet.balance);
    if (lymxAmount > fromBalance) {
        return errorResponse(
            `Insufficient balance: requested ${lymxAmount} but balance is ${fromBalance}`,
            400
        );
    }

    // Step 4: insert the OUT transaction first
    const { data: outTx, error: outErr } = await supabase
        .from("transactions")
        .insert({
            type: "transfer_out",
            wallet_id: fromWallet.id,
            business_id: fromWallet.business_id,
            lymx_amount: lymxAmount,
            note: body.note ?? null,
            created_by_user_id: user.id,
        })
        .select("id")
        .single();
    if (outErr || !outTx) {
        return errorResponse(`Out transaction insert failed: ${outErr?.message}`, 500);
    }

    // Step 5: insert the IN transaction, linked to OUT
    const { data: inTx, error: inErr } = await supabase
        .from("transactions")
        .insert({
            type: "transfer_in",
            wallet_id: toWallet!.id,
            business_id: fromWallet.business_id,
            lymx_amount: lymxAmount,
            paired_transaction_id: outTx.id,
            note: body.note ?? null,
            created_by_user_id: user.id,
        })
        .select("id")
        .single();
    if (inErr || !inTx) {
        // Roll back the OUT (no native xact across HTTP, so do this best-effort)
        await supabase.from("transactions").delete().eq("id", outTx.id);
        return errorResponse(`In transaction insert failed: ${inErr?.message}`, 500);
    }

    // Step 6: link OUT back to IN (so each side has the pair reference)
    await supabase
        .from("transactions")
        .update({ paired_transaction_id: inTx.id })
        .eq("id", outTx.id);

    // Step 7: update both wallet balances
    const fromNewBalance = fromBalance - lymxAmount;
    const toNewBalance = Number(toWallet!.balance) + lymxAmount;

    await supabase
        .from("wallets")
        .update({ balance: fromNewBalance })
        .eq("id", fromWallet.id);
    await supabase
        .from("wallets")
        .update({ balance: toNewBalance })
        .eq("id", toWallet!.id);

    return jsonResponse({
        from_transaction_id: outTx.id,
        to_transaction_id: inTx.id,
        from_wallet_id: fromWallet.id,
        to_wallet_id: toWallet!.id,
        lymx_amount: lymxAmount,
        from_new_balance: fromNewBalance,
        to_new_balance: toNewBalance,
    }, 201);
});
