-- Migration 053 — receipt-scan dedupe + 4-hour same-customer same-business cap
-- 2026-05-19
--
-- Tightens the customer-side "I scanned my receipt" path (review-write.html
-- + admin-reviews.html). Two attack vectors closed:
--
--   1. Same paper receipt claimed twice. Two friends share a photo of the
--      same receipt → both submit → both get LYMX.  Now blocked at insert
--      time via unique constraint on (business_id, receipt_phash).
--
--   2. Receipt-recycling within a single shift.  Customer (or collusion)
--      submits multiple "scans" against the same shop within minutes/hours.
--      Now blocked: same recipient_user_id + same business_id within
--      4 hours raises an exception unless an admin overrides.

-- ---------- 1. Columns on lymx_issuances ---------------------------------
alter table public.lymx_issuances
    add column if not exists receipt_phash text;       -- SHA-256 hex of receipt photo bytes
alter table public.lymx_issuances
    add column if not exists receipt_url   text;       -- storage URL of the uploaded photo
alter table public.lymx_issuances
    add column if not exists receipt_ocr_amount_cents int;  -- OCR-extracted amount (validation cross-check)

-- ---------- 1b. Same columns on reviews — early dedupe at submission ----
-- The customer-side flow uploads to reviews.receipt_image_url first; admin
-- approves later and that's when lymx_issuances is created. Dedupe needs to
-- fire at submission time to reject the same paper-receipt photo before it
-- floods the admin queue, AND again at issuance time as defense-in-depth.
alter table public.reviews
    add column if not exists receipt_phash text;
-- reviews uses business_slug (not business_id) per migration 030
create unique index if not exists idx_reviews_receipt_phash_unique
    on public.reviews(business_slug, receipt_phash)
    where receipt_phash is not null;

-- ---------- 2. Unique constraint on (business_id, receipt_phash) ---------
-- Partial: only enforced when phash is present (POS webhooks / manual
-- tablet entries don't have a receipt phash, so they're exempt).
create unique index if not exists idx_issuances_receipt_phash_unique
    on public.lymx_issuances(business_id, receipt_phash)
    where receipt_phash is not null;

-- ---------- 3. Time-window cap trigger -----------------------------------
-- Same recipient + same business + 'manual' reason within 4 hours = blocked.
-- Tuned for receipt-scan path: a real customer doesn't visit + claim 5x in
-- one afternoon at the same shop.  Admin can override by setting
-- transaction_method = 'admin' on insert.

create or replace function public.check_receipt_scan_cap()
returns trigger
language plpgsql
security definer
as $$
declare
    v_recent_count int;
begin
    -- Only check on the receipt-scan code path
    if new.reason <> 'manual' or new.transaction_method = 'admin' then
        return new;
    end if;
    if new.recipient_user_id is null or new.business_id is null then
        return new;
    end if;

    select count(*)
      into v_recent_count
      from public.lymx_issuances
     where recipient_user_id = new.recipient_user_id
       and business_id       = new.business_id
       and reason            = 'manual'
       and created_at        > now() - interval '4 hours';

    if v_recent_count >= 1 then
        raise exception 'RECEIPT-SCAN CAP: this customer already claimed a receipt at this business in the last 4 hours. Admin must override (set transaction_method=admin) if legitimate.'
            using errcode = 'P0001';
    end if;

    return new;
end$$;

drop trigger if exists trg_check_receipt_scan_cap on public.lymx_issuances;
create trigger trg_check_receipt_scan_cap
    before insert on public.lymx_issuances
    for each row execute function public.check_receipt_scan_cap();

-- ---------- 4. OCR amount-mismatch flag (soft) ---------------------------
-- When OCR amount is present and differs by > 5% from transaction_amount_cents,
-- write a soft fraud flag for admin review. Doesn't block the insert; this is
-- a watch-list signal.

create or replace function public.flag_ocr_amount_mismatch()
returns trigger
language plpgsql
security definer
as $$
declare
    v_delta_pct numeric;
begin
    if new.receipt_ocr_amount_cents is null
        or new.transaction_amount_cents is null
        or new.transaction_amount_cents = 0 then
        return new;
    end if;
    v_delta_pct := abs(
        new.receipt_ocr_amount_cents - new.transaction_amount_cents
    )::numeric / new.transaction_amount_cents::numeric * 100;
    if v_delta_pct > 5 then
        insert into public.fraud_flags (
            flag_type, severity, status,
            subject_kind, subject_id,
            business_id, user_id,
            amount_lymx,
            summary, detection_data
        ) values (
            'receipt_amount_mismatch', 'medium', 'open',
            'issuance', new.id,
            new.business_id, new.recipient_user_id,
            new.amount_lymx,
            'Receipt OCR amount ($' || (new.receipt_ocr_amount_cents/100.0)::text
              || ') differs from claimed amount ($'
              || (new.transaction_amount_cents/100.0)::text
              || ') by ' || round(v_delta_pct, 1)::text || '%.',
            jsonb_build_object(
                'issuance_id', new.id,
                'business_id', new.business_id,
                'recipient_user_id', new.recipient_user_id,
                'ocr_amount_cents', new.receipt_ocr_amount_cents,
                'claimed_amount_cents', new.transaction_amount_cents,
                'delta_pct', round(v_delta_pct, 2)
            )
        );
    end if;
    return new;
end$$;

drop trigger if exists trg_flag_ocr_amount_mismatch on public.lymx_issuances;
create trigger trg_flag_ocr_amount_mismatch
    after insert on public.lymx_issuances
    for each row execute function public.flag_ocr_amount_mismatch();

-- ---------- 5. Index for the cap trigger lookup --------------------------
create index if not exists idx_issuances_recipient_business_manual_time
    on public.lymx_issuances(recipient_user_id, business_id, created_at desc)
    where reason = 'manual';

-- ---------- 6. Sanity ----------------------------------------------------
do $$
begin
    if not exists (
        select 1 from information_schema.tables
         where table_schema = 'public'
           and table_name   = 'fraud_flags'
    ) then
        raise exception 'fraud_flags table missing — apply migration 048 first';
    end if;
end$$;
