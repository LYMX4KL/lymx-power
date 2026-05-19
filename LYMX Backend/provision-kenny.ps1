#requires -Version 5.0
# =============================================================================
# Provision kenny.lin@getlymx.com
# =============================================================================
# Reads the service_role JWT from your clipboard and calls
# partner-provision-email with Kenny's partner_id (hardcoded).
#
# Steps to use:
#   1. Click "Copy" next to "service_role" on the Supabase legacy API keys
#      page (https://supabase.com/dashboard/project/apffootxzfwmtyjlnteo/settings/api-keys/legacy)
#   2. Without doing anything else with your clipboard, run:
#        cd "C:\Users\Kenny\Desktop\Gemini\LYMX Backend"
#        .\provision-kenny.ps1
# =============================================================================

$ErrorActionPreference = "Stop"

$PARTNER_ID = "6c77dcf1-d230-4fef-b6e6-2604785ba1ee"

Write-Host ""
Write-Host "===== Provision kenny.lin@getlymx.com =====" -ForegroundColor Cyan
Write-Host ""

# Read JWT from clipboard
$KEY = (Get-Clipboard).Trim()

# Validate format
if ([string]::IsNullOrWhiteSpace($KEY)) {
    Write-Host "ERROR: clipboard is empty. Click Copy next to service_role on the Supabase API keys page first." -ForegroundColor Red
    Read-Host "Press Enter to close"
    exit 1
}
$parts = $KEY.Split(".")
if ($parts.Length -ne 3) {
    Write-Host "ERROR: clipboard does not contain a JWT (got $($parts.Length) part(s), need exactly 3 separated by dots)." -ForegroundColor Red
    Write-Host "Length: $($KEY.Length) chars" -ForegroundColor Red
    Write-Host "Starts with: $($KEY.Substring(0, [Math]::Min(20, $KEY.Length)))..." -ForegroundColor Red
    Read-Host "Press Enter to close"
    exit 1
}
if ($KEY.Length -lt 100) {
    Write-Host "ERROR: JWT looks too short ($($KEY.Length) chars). Re-copy the service_role key." -ForegroundColor Red
    Read-Host "Press Enter to close"
    exit 1
}

# Decode payload to confirm role
try {
    $payloadB64 = $parts[1].Replace("-", "+").Replace("_", "/")
    while ($payloadB64.Length % 4 -ne 0) { $payloadB64 += "=" }
    $payloadJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($payloadB64))
    $payload = $payloadJson | ConvertFrom-Json
    if ($payload.role -ne "service_role") {
        Write-Host "ERROR: clipboard JWT has role '$($payload.role)', need 'service_role'." -ForegroundColor Red
        Write-Host "(You may have copied the anon key by mistake.)" -ForegroundColor Yellow
        Read-Host "Press Enter to close"
        exit 1
    }
    Write-Host "OK: JWT looks good (role=service_role, length=$($KEY.Length))" -ForegroundColor Green
} catch {
    Write-Host "WARNING: couldn't decode JWT payload, but format looks ok. Trying anyway..." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Calling partner-provision-email for partner_id=$PARTNER_ID ..." -ForegroundColor Yellow
Write-Host ""

$body = @{ partner_id = $PARTNER_ID } | ConvertTo-Json -Compress

try {
    $response = Invoke-RestMethod `
        -Uri "https://apffootxzfwmtyjlnteo.supabase.co/functions/v1/partner-provision-email" `
        -Method POST `
        -Headers @{
            "Authorization" = "Bearer $KEY"
            "Content-Type"  = "application/json"
        } `
        -Body $body `
        -ErrorAction Stop

    Write-Host "===== SUCCESS =====" -ForegroundColor Green
    $response | ConvertTo-Json -Depth 5 | Write-Host
    Write-Host ""
    Write-Host "Check zhongkennylin@gmail.com for a welcome email from LYMX <hello@getlymx.com>." -ForegroundColor Cyan
}
catch {
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
