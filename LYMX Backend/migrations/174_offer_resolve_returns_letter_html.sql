-- =============================================================================
-- 174 — Applicant offer letter: return the letter HTML from the token resolver
-- =============================================================================
-- Ticket #95b4e200: an applicant clicked "Read the full offer letter" on
-- accept-offer.html and got {"statusCode":"404","error":"Bucket not found"}.
--
-- ROOT CAUSE: accept-offer.html built a PUBLIC storage URL
--   <SUPABASE_URL>/storage/v1/object/public/<offer_letter_path>
-- but `personnel-files` is a PRIVATE bucket and offer_letter_path has no bucket
-- prefix (it is "<applicant_uuid>/offer_<id>_<date>.html"), so storage parsed the
-- applicant UUID as the bucket name and 404'd. The applicant is unauthenticated
-- (no session, no admin token), so they can never mint a signed URL client-side —
-- the admin-side fix (signed URL via the admin token) does not apply here.
--
-- FIX: the full letter HTML is already stored on the offers row
-- (offers.offer_letter_html, written by generate-offer-letter). Return it from the
-- token-gated resolver so accept-offer.html can render it directly — no storage,
-- no auth, and it stays scoped to whoever holds the valid accept token.
-- Mirrors fn_offer_resolve_by_token (migration 121); only adds one field.
-- =============================================================================

create or replace function public.fn_offer_resolve_by_token(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_offer record;
    v_app   record;
begin
    if p_token is null then
        return jsonb_build_object('ok', false, 'error', 'no_token');
    end if;

    select * into v_offer
      from public.offers
     where accept_token = p_token
     limit 1;

    if not found then
        return jsonb_build_object('ok', false, 'error', 'token_not_found');
    end if;

    if v_offer.accept_token_expires_at is not null
       and v_offer.accept_token_expires_at < now() then
        return jsonb_build_object('ok', false, 'error', 'token_expired',
            'expired_at', v_offer.accept_token_expires_at);
    end if;

    if v_offer.status <> 'sent' then
        return jsonb_build_object('ok', false, 'error', 'offer_status_not_sent',
            'status', v_offer.status);
    end if;

    select first_name, last_name, email into v_app
      from public.job_applications
     where id = v_offer.application_id;

    return jsonb_build_object(
        'ok', true,
        'offer_id', v_offer.id,
        'title', v_offer.title,
        'target_role', v_offer.target_role,
        'employment_type', v_offer.employment_type,
        'work_mode', v_offer.work_mode,
        'pay_type', v_offer.pay_type,
        'pay_period', v_offer.pay_period,
        'pay_rate_cents', v_offer.pay_rate_cents,
        'sign_on_bonus_cents', v_offer.sign_on_bonus_cents,
        'start_date', v_offer.start_date,
        'location', v_offer.location,
        'custom_notes_md', v_offer.custom_notes_md,
        'offer_letter_path', v_offer.offer_letter_path,
        'offer_letter_html', v_offer.offer_letter_html,   -- #95b4e200: render directly, no storage
        'sent_at', v_offer.sent_at,
        'token_expires_at', v_offer.accept_token_expires_at,
        'candidate_first_name', coalesce(v_app.first_name, ''),
        'candidate_last_name',  coalesce(v_app.last_name,  ''),
        'candidate_email',      coalesce(v_app.email,      '')
    );
end;
$$;

grant execute on function public.fn_offer_resolve_by_token(uuid) to anon, authenticated;
