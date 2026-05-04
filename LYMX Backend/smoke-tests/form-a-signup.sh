#!/usr/bin/env bash
# =============================================================================
# Form A signup smoke test — Mode 1 (storefront) + Mode 3 (self-employed)
# Run AFTER:
#   1. migration 006_intake_forms.sql has been applied to Supabase
#   2. business-signup Edge Function has been redeployed with the new code
# =============================================================================
#
# Usage:
#   export SUPABASE_URL="https://apffootxzfwmtyjlnteo.supabase.co"
#   export SUPABASE_ANON_KEY="ey..."          # find in dashboard → API
#   bash smoke-tests/form-a-signup.sh
#
# Exits non-zero if either request returns non-2xx.
# =============================================================================

set -euo pipefail

: "${SUPABASE_URL:?Set SUPABASE_URL}"
: "${SUPABASE_ANON_KEY:?Set SUPABASE_ANON_KEY}"

ENDPOINT="$SUPABASE_URL/functions/v1/business-signup"
STAMP=$(date +%s)

# Random-ish unique emails so retries don't collide on auth.users.email
EMAIL_SF="smoketest-sf-${STAMP}@smoketest.dev"
EMAIL_SE="smoketest-se-${STAMP}@smoketest.dev"

hr(){ printf '\n%s\n' "────────────────────────────────────────────────────────"; }

# ---------------------------------------------------------------------------
# Test 1 — Mode 1 storefront
# ---------------------------------------------------------------------------
hr
echo "TEST 1: Mode 1 — storefront signup ($EMAIL_SF)"

REQ_SF=$(cat <<JSON
{
  "kind": "storefront",
  "owner_email": "$EMAIL_SF",
  "owner_password": "smokepass1234!",
  "legal_name":   "Smoke Cafe LLC",
  "display_name": "Smoke Cafe",
  "category":     "Cafe / coffee",
  "contact_email": "hello-${STAMP}@smokecafe.test",
  "contact_phone": "+17025550101",
  "issuance_rate": 5,
  "location": {
    "name":   "Main",
    "street": "123 Smoke Ln",
    "city":   "Las Vegas",
    "state":  "NV",
    "zip":    "89101"
  }
}
JSON
)

RES_SF=$(curl -sS -w "\n%{http_code}" -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -d "$REQ_SF")

STATUS_SF=$(echo "$RES_SF" | tail -n1)
BODY_SF=$(echo "$RES_SF" | sed '$d')
echo "Status: $STATUS_SF"
echo "Body:   $BODY_SF"

if [[ "$STATUS_SF" != "201" ]]; then
  echo "❌ Mode 1 expected 201, got $STATUS_SF"
  exit 1
fi
echo "✅ Mode 1 storefront OK"

# ---------------------------------------------------------------------------
# Test 2 — Mode 3 self-employed
# ---------------------------------------------------------------------------
hr
echo "TEST 2: Mode 3 — self-employed signup ($EMAIL_SE)"

REQ_SE=$(cat <<JSON
{
  "kind": "self_employed",
  "owner_email": "$EMAIL_SE",
  "owner_password": "smokepass1234!",
  "legal_name":   "Jane Smoke Consulting LLC",
  "display_name": "Jane Smoke",
  "category":     "Consulting",
  "contact_email": "hello-${STAMP}@janesmoke.test",
  "contact_phone": "+17025550202",
  "service_area": "Clark County, NV",
  "services": [
    { "service_name": "60-min consult", "price_usd": 150, "lymx_per_booking": 1500 },
    { "service_name": "Project audit",  "price_usd": 500, "lymx_per_booking": 5000 },
    { "service_name": "Quarterly review", "price_usd": 250, "lymx_per_booking": 2500 }
  ]
}
JSON
)

RES_SE=$(curl -sS -w "\n%{http_code}" -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -d "$REQ_SE")

STATUS_SE=$(echo "$RES_SE" | tail -n1)
BODY_SE=$(echo "$RES_SE" | sed '$d')
echo "Status: $STATUS_SE"
echo "Body:   $BODY_SE"

if [[ "$STATUS_SE" != "201" ]]; then
  echo "❌ Mode 3 expected 201, got $STATUS_SE"
  exit 1
fi

# Verify service_ids array has 3 entries
N_SVCS=$(echo "$BODY_SE" | grep -oE '"service_ids":\[[^]]*\]' | grep -oE '[0-9a-f-]{36}' | wc -l | tr -d ' ')
if [[ "$N_SVCS" != "3" ]]; then
  echo "❌ Expected 3 service_ids in response, got $N_SVCS"
  exit 1
fi
echo "✅ Mode 3 self-employed OK (3 services created)"

# ---------------------------------------------------------------------------
# Test 3 — bad payload (missing services for self_employed) should 400
# ---------------------------------------------------------------------------
hr
echo "TEST 3: bad payload — self_employed with no services should 400"

RES_BAD=$(curl -sS -w "\n%{http_code}" -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -d '{
    "kind": "self_employed",
    "owner_email": "should-not-create-'"$STAMP"'@smoketest.dev",
    "owner_password": "smokepass1234!",
    "legal_name": "Empty Co",
    "display_name": "Empty",
    "contact_email": "x@x.test",
    "services": []
  }')

STATUS_BAD=$(echo "$RES_BAD" | tail -n1)
echo "Status: $STATUS_BAD (expected 400)"
if [[ "$STATUS_BAD" != "400" ]]; then
  echo "❌ Expected 400 for empty services, got $STATUS_BAD"
  exit 1
fi
echo "✅ Bad-payload validation OK"

hr
echo "🎉 All 3 Form A smoke tests passed."
echo
echo "Cleanup later: these created auth users + businesses with email"
echo "  *@smoketest.dev — same pattern as Phase 1/2 leftovers."
