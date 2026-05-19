#requires -Version 5.0
# =============================================================================
# Partner email provision smoke test
# =============================================================================
# Prompts for the Supabase service role key + a partner id, then calls the
# partner-provision-email Edge Function and prints the response.
# =============================================================================

$SUPABASE_URL = "https://apffootxzfwmtyjlnteo.supabase.co"

Write-Host ""
Write-Host "===== LYMX partner-provision-email smoke test =====" -ForegroundColor Cyan
Write-Host ""

# Prompt for service role key (hidden input)
$secureKey = Read-Host "Paste your Supabase service_role key (input will be hidden)" -AsSecureString
$BSTR = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
$SERVICE_KEY = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($BSTR)
[System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($BSTR)

if ([string]::IsNullOrWhiteSpace($SERVICE_KEY)) {
    Write-Host "No service key entered. Exiting." -ForegroundColor Red
    Read-Host "Press Enter to close"
    exit 1
}

# Prompt for partner ID
$PARTNER_ID = Read-Host "Paste the partner_id from the SQL insert (UUID)"

if ([string]::IsNullOrWhiteSpace($PARTNER_ID)) {
    Write-Host "No partner_id entered. Exiting." -ForegroundColor Red
    Read-Host "Press Enter to close"
    exit 1
}

Write-Host ""
Write-Host "Calling partner-provision-email for partner_id=$PARTNER_ID ..." -ForegroundColor Yellow
Write-Host ""

# Build request body
$body = @{ partner_id = $PARTNER_ID } | ConvertTo-Json -Compress

# Make the call
try {
    $response = Invoke-RestMethod `
        -Uri "$SUPABASE_URL/functions/v1/partner-provision-email" `
        -Method POST `
        -Headers @{
            "Authorization" = "Bearer $SERVICE_KEY"
            "Content-Type"  = "application/json"
        } `
        -Body $body `
        -ErrorAction Stop

    Write-Host "===== SUCCESS =====" -ForegroundColor Green
    $response | ConvertTo-Json -Depth 5 | Write-Host
    Write-Host ""
    Write-Host "Now check zhongkennylin+smoketest@gmail.com for the welcome email." -ForegroundColor Cyan
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
