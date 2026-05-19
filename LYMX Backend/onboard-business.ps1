#requires -Version 5.0
# =============================================================================
# Onboard a new Business onto LYMX
# =============================================================================
# Interactive prompts for the 9 required fields, then calls the
# business-signup Edge Function. Pulls the anon key from lymx-config.js
# automatically so you don't have to paste it.
#
# Usage:
#     Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
#     .\onboard-business.ps1
#
# Run from anywhere — paths are absolute.
# =============================================================================

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "===== LYMX Business Onboarding =====" -ForegroundColor Cyan
Write-Host ""

# --- Pull anon key from lymx-config.js (so we don't have to paste it) -------
$configPath = "C:\Users\Kenny\Desktop\Gemini\LYMX Power\lymx-config.js"
if (-not (Test-Path $configPath)) {
    Write-Host "ERROR: lymx-config.js not found at $configPath" -ForegroundColor Red
    Read-Host "Press Enter to close"
    exit 1
}
$config = Get-Content $configPath -Raw
if ($config -match "SUPABASE_ANON_KEY:\s*'([^']+)'") {
    $ANON = $matches[1]
    if ($ANON -eq 'ANON_KEY_PLACEHOLDER' -or $ANON -eq 'REPLACE_WITH_ANON_KEY' -or $ANON.Length -lt 50) {
        Write-Host "ERROR: lymx-config.js still has the placeholder. Paste the real anon key first." -ForegroundColor Red
        Read-Host "Press Enter to close"
        exit 1
    }
    Write-Host "Anon key loaded from lymx-config.js (length $($ANON.Length))" -ForegroundColor Green
} else {
    Write-Host "ERROR: Couldn't parse SUPABASE_ANON_KEY out of lymx-config.js" -ForegroundColor Red
    Read-Host "Press Enter to close"
    exit 1
}
Write-Host ""

# --- Prompt for each value --------------------------------------------------
Write-Host "Fill in the Business details. Press Enter after each value." -ForegroundColor Yellow
Write-Host ""

$displayName  = Read-Host "Display name (what customers see, e.g. 'Fellora')"
$legalName    = Read-Host "Legal entity name (e.g. 'Fellora LLC')"
$category     = Read-Host "Category (e.g. 'ecommerce', 'real_estate', 'cafe')"
$ownerEmail   = Read-Host "Owner sign-in email (you will sign in to biz-dashboard with this)"

$ownerPassSec = Read-Host "Owner password (10+ chars, will be hidden)" -AsSecureString
$BSTR = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($ownerPassSec)
$ownerPass = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($BSTR)
[System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($BSTR)

if ($ownerPass.Length -lt 10) {
    Write-Host "ERROR: password must be 10+ chars" -ForegroundColor Red
    Read-Host "Press Enter to close"
    exit 1
}

$contactEmail = Read-Host "Customer-facing contact email (e.g. 'hello@thefellora.com')"
$contactPhone = Read-Host "Phone (e.g. '+17025551234'; press Enter to skip)"
$issuanceRate = Read-Host "LYMX issued per `$1 spent (default 5; press Enter to accept)"
if ([string]::IsNullOrWhiteSpace($issuanceRate)) { $issuanceRate = 5 } else { $issuanceRate = [int]$issuanceRate }

Write-Host ""
Write-Host "--- Primary location ---" -ForegroundColor Yellow
$locName  = Read-Host "Location name (e.g. 'HQ' or 'Main Street')"
$street   = Read-Host "Street"
$city     = Read-Host "City"
$state    = Read-Host "State (2-letter)"
$zip      = Read-Host "ZIP"

Write-Host ""
Write-Host "--- Confirm ---" -ForegroundColor Yellow
Write-Host "  Display:  $displayName"
Write-Host "  Legal:    $legalName"
Write-Host "  Category: $category"
Write-Host "  Email:    $ownerEmail"
Write-Host "  Phone:    $contactPhone"
Write-Host "  Rate:     $issuanceRate LYMX per `$1"
Write-Host "  Address:  $street, $city, $state $zip"
$confirm = Read-Host "Looks right? Type 'yes' to submit"
if ($confirm -ne "yes") {
    Write-Host "Cancelled." -ForegroundColor Yellow
    Read-Host "Press Enter to close"
    exit 0
}

# --- Build request body -----------------------------------------------------
$bodyObj = @{
    kind            = "storefront"
    owner_email     = $ownerEmail
    owner_password  = $ownerPass
    legal_name      = $legalName
    display_name    = $displayName
    category        = $category
    contact_email   = $contactEmail
    issuance_rate   = $issuanceRate
    location        = @{
        name   = $locName
        street = $street
        city   = $city
        state  = $state
        zip    = $zip
    }
}
if (-not [string]::IsNullOrWhiteSpace($contactPhone)) {
    $bodyObj.contact_phone = $contactPhone
}
$body = $bodyObj | ConvertTo-Json -Compress -Depth 5

# --- Call the Edge Function -------------------------------------------------
Write-Host ""
Write-Host "Calling business-signup..." -ForegroundColor Yellow
try {
    $response = Invoke-RestMethod `
        -Uri "https://apffootxzfwmtyjlnteo.supabase.co/functions/v1/business-signup" `
        -Method POST `
        -Headers @{
            "Authorization" = "Bearer $ANON"
            "apikey"        = $ANON
            "Content-Type"  = "application/json"
        } `
        -Body $body `
        -ErrorAction Stop

    Write-Host ""
    Write-Host "===== SUCCESS =====" -ForegroundColor Green
    Write-Host ""
    Write-Host "Business created:" -ForegroundColor Green
    Write-Host "  user_id:         $($response.user_id)"
    Write-Host "  business_id:     $($response.business_id)" -ForegroundColor Cyan
    Write-Host "  location_id:     $($response.location_id)"
    Write-Host "  subscription_id: $($response.subscription_id)"
    Write-Host ""
    Write-Host "SAVE THE business_id ABOVE — you'll need it for the cross-app integration (Phase 3 in LAUNCH-READY-RUNBOOK.md)." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Next: open https://getlymx.com/login.html and sign in with $ownerEmail to verify the Business dashboard works." -ForegroundColor Yellow
}
catch {
    Write-Host ""
    Write-Host "===== ERROR =====" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    if ($_.ErrorDetails) {
        Write-Host ""
        Write-Host "Response body:" -ForegroundColor Yellow
        Write-Host $_.ErrorDetails.Message
    }
    elseif ($_.Exception.Response) {
        try {
            $stream = $_.Exception.Response.GetResponseStream()
            $reader = New-Object System.IO.StreamReader($stream)
            $errorBody = $reader.ReadToEnd()
            Write-Host ""
            Write-Host "Response body:" -ForegroundColor Yellow
            Write-Host $errorBody
        } catch {}
    }
}

Write-Host ""
Read-Host "Press Enter to close"
