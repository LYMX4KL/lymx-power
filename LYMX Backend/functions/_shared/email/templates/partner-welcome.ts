// =============================================================================
// LYMX Power — Partner Welcome Email Template
// =============================================================================
// Sent to a new partner the moment their LYMX signup is processed.
//
// Payload includes:
//   1. Welcome + their unique partner code (used to recruit Businesses + Partners)
//   2. Their auto-provisioned company email (firstname.lastname@getlymx.com)
//   3. Send-mail-as walkthrough so they can REPLY from their branded LYMX email
//      — supports BOTH Gmail and Outlook (most personal email clients).
//   4. Earnings overview — 9% direct / 3% G1 / 2% G2 / 1% G3
//   5. Founding 25 reminder if applicable (lifetime fee waiver perk)
//   6. CTA to dashboard + "Reply if you need help" footer
//
// 2026-05-24 (final) — Inbound routing is now handled by the
// `lymx-inbound-forwarder` Cloudflare Email Worker. The previous "Step 0 —
// click the Cloudflare verify link in your inbox" warning has been removed
// because the Worker no longer requires CF destination verification. Partners
// can ignore any Cloudflare verify email they may receive (it's harmless).
//
// IMPORTANT: This is a pure function — no Deno-specific imports — so it can be
// reused across functions and even unit-tested in plain Node if needed.
// =============================================================================

export interface PartnerWelcomeData {
    /** Partner's full name, used for greeting + Send-as Name field */
    fullName: string;
    /** Partner's unique referral code (e.g. "KENNY", "MAYA42") */
    referralCode: string;
    /** Site URL — defaults to https://getlymx.com */
    siteUrl?: string;

    // ---- Company email + SMTP -----------------------------------------------
    /** Their newly-provisioned LYMX email (e.g. "maya.chen@getlymx.com") */
    companyEmail: string;
    /** SMTP host from SES (e.g. "email-smtp.us-east-1.amazonaws.com") */
    smtpHost: string;
    /** SMTP port (587 for TLS) */
    smtpPort?: number;
    /** Per-agent SMTP username (from SES SMTP credentials generation) */
    smtpUsername: string;
    /** Per-agent SMTP password (from SES SMTP credentials generation) */
    smtpPassword: string;

    // ---- Optional perks ------------------------------------------------------
    /** True if this partner is part of the Founding 25 cohort (lifetime fee waiver) */
    foundingTwentyFive?: boolean;
}

export function partnerWelcomeEmail(data: PartnerWelcomeData) {
    const siteUrl = data.siteUrl || "https://getlymx.com";
    const referralLink = `${siteUrl}/?ref=${data.referralCode}`;
    const dashboardLink = `${siteUrl}/rep-dashboard.html`;
    const firstName = data.fullName.split(" ")[0] || data.fullName;
    const port = data.smtpPort || 587;

    const subject =
        `${firstName}, welcome to LYMX — your partner code is ${data.referralCode}` +
        ` and your work email is ready`;

    // ----- Founding 25 banner (only if this partner is in the cohort) --------
    const foundingBanner = data.foundingTwentyFive
        ? `
          <tr>
            <td style="padding: 0 0 24px 0;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background: linear-gradient(90deg, #0a84ff, #13a26b); border-radius: 12px;">
                <tr>
                  <td style="padding: 18px 24px;">
                    <p style="margin: 0 0 4px 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 12px; color: rgba(255,255,255,0.85); text-transform: uppercase; letter-spacing: 1.5px; font-weight: 700;">
                      Founding 25 Cohort
                    </p>
                    <p style="margin: 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 16px; color: #ffffff; line-height: 1.4;">
                      Your $25 sign-up &amp; $12.95/mo partner fees are <strong>permanently waived</strong> — for life, as long as you stay active.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>`
        : "";

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${subject}</title>
</head>
<body style="margin:0; padding:0; background-color:#f6f8fb; font-family:-apple-system,BlinkMacSystemFont,sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color: #f6f8fb;">
    <tr>
      <td align="center" style="padding: 32px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="640" style="max-width: 640px; width: 100%; background-color: #ffffff; border-radius: 16px; padding: 36px 32px; box-shadow: 0 2px 12px rgba(15, 23, 42, 0.06);">

          ${foundingBanner}

          <!-- Greeting -->
          <tr>
            <td style="padding: 0 0 20px 0;">
              <h1 style="margin: 0 0 8px 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 28px; color: #0f172a; font-weight: 800; letter-spacing: -0.5px;">
                Welcome to LYMX, ${firstName}.
              </h1>
              <p style="margin: 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 15px; color: #475569; line-height: 1.6;">
                You're now part of the team building the best loyalty rewards network in Las Vegas. Two things are ready for you right now: your partner code (for recruiting Businesses + Partners), and your branded work email (so you look the part when you're prospecting).
              </p>
            </td>
          </tr>

          <!-- Referral code -->
          <tr>
            <td style="padding: 0 0 24px 0;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td style="background-color: #f0f7ff; border: 1px dashed #7cb3ff; border-radius: 12px; padding: 24px; text-align: center;">
                    <p style="margin: 0 0 8px 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 12.5px; color: #0050c7; text-transform: uppercase; letter-spacing: 1.2px; font-weight: 700;">
                      Your partner code
                    </p>
                    <p style="margin: 0 0 8px 0; font-family: 'SF Mono', 'Menlo', 'Courier New', monospace; font-size: 32px; color: #0a84ff; font-weight: 700; letter-spacing: 2px;">
                      ${data.referralCode}
                    </p>
                    <p style="margin: 12px 0 0 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 14px; color: #1e293b; word-break: break-all;">
                      <a href="${referralLink}" style="color: #0a84ff; text-decoration: underline;">${referralLink}</a>
                    </p>
                  </td>
                </tr>
              </table>

              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin: 32px 0 0 0;">
                <tr>
                  <td align="center">
                    <a href="${dashboardLink}" style="background: linear-gradient(135deg, #0a84ff, #0050c7); color: #ffffff; display: inline-block; padding: 14px 32px; border-radius: 999px; text-decoration: none; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-weight: 600; font-size: 16px; box-shadow: 0 4px 12px rgba(10, 132, 255, 0.25);">
                      Open your dashboard &rarr;
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Company email setup -->
          <tr>
            <td style="padding: 32px 0 0 0;">
              <h2 style="margin: 0 0 8px 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 24px; color: #0f172a; font-weight: 800; letter-spacing: -0.3px;">
                Your work email is ready
              </h2>
              <p style="margin: 0 0 20px 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 15px; color: #475569; line-height: 1.6;">
                We provisioned <strong style="color: #0a84ff;">${data.companyEmail}</strong> for you. Anything sent to that address forwards straight to this inbox &mdash; nothing for you to install. To <em>send</em> from your branded LYMX address (instead of your personal email), follow the one-time setup below in <strong>either Gmail or Outlook</strong>.
              </p>

              <!-- Shared SMTP credentials block -->
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom: 18px;">
                <tr>
                  <td style="background-color: #f0f7ff; border: 1px solid #cfe3ff; border-radius: 12px; padding: 20px;">
                    <p style="margin: 0 0 12px 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 13px; color: #0050c7; text-transform: uppercase; letter-spacing: 1.2px; font-weight: 700;">
                      Your SMTP credentials (paste into Gmail or Outlook below)
                    </p>
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color: #ffffff; border-radius: 8px; padding: 16px;">
                      <tr><td style="padding: 4px 0;"><table role="presentation" width="100%"><tr>
                        <td style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 13px; color: #64748b; width: 130px;">SMTP Server</td>
                        <td style="font-family: 'SF Mono', 'Menlo', 'Courier New', monospace; font-size: 13px; color: #0f172a;">${data.smtpHost}</td>
                      </tr></table></td></tr>
                      <tr><td style="padding: 4px 0;"><table role="presentation" width="100%"><tr>
                        <td style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 13px; color: #64748b; width: 130px;">Port</td>
                        <td style="font-family: 'SF Mono', 'Menlo', 'Courier New', monospace; font-size: 13px; color: #0f172a;">${port}</td>
                      </tr></table></td></tr>
                      <tr><td style="padding: 4px 0;"><table role="presentation" width="100%"><tr>
                        <td style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 13px; color: #64748b; width: 130px;">Username</td>
                        <td style="font-family: 'SF Mono', 'Menlo', 'Courier New', monospace; font-size: 13px; color: #0f172a; word-break: break-all;">${data.smtpUsername}</td>
                      </tr></table></td></tr>
                      <tr><td style="padding: 4px 0;"><table role="presentation" width="100%"><tr>
                        <td style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 13px; color: #64748b; width: 130px;">Password</td>
                        <td style="font-family: 'SF Mono', 'Menlo', 'Courier New', monospace; font-size: 13px; color: #0f172a; word-break: break-all;">${data.smtpPassword}</td>
                      </tr></table></td></tr>
                      <tr><td style="padding: 4px 0;"><table role="presentation" width="100%"><tr>
                        <td style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 13px; color: #64748b; width: 130px;">Connection</td>
                        <td style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 13px; color: #0f172a;">TLS</td>
                      </tr></table></td></tr>
                    </table>
                    <p style="margin: 14px 0 0 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 13px; color: #0050c7; line-height: 1.6;">
                      During setup, Gmail/Outlook will email <strong>${data.companyEmail}</strong> a verification code. It forwards back to this inbox &mdash; you&rsquo;ll see it in seconds.
                    </p>
                  </td>
                </tr>
              </table>

              <!-- Gmail setup -->
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom: 16px;">
                <tr>
                  <td style="background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px 24px;">
                    <p style="margin: 0 0 12px 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 13px; color: #0a84ff; text-transform: uppercase; letter-spacing: 1.2px; font-weight: 700;">
                      Option A &mdash; Gmail (5 minutes)
                    </p>
                    <ol style="margin: 0; padding-left: 22px; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 14px; color: #1e293b; line-height: 1.7;">
                      <li>Gmail (desktop browser, not mobile) &rarr; gear icon &rarr; <strong>&ldquo;See all settings&rdquo;</strong></li>
                      <li>Click the <strong>&ldquo;Accounts and Import&rdquo;</strong> tab</li>
                      <li>In <strong>&ldquo;Send mail as&rdquo;</strong>, click <strong>&ldquo;Add another email address&rdquo;</strong></li>
                      <li>Name: <strong>${data.fullName}</strong> &nbsp;|&nbsp; Email: <strong>${data.companyEmail}</strong></li>
                      <li><em>Uncheck</em> &ldquo;Treat as an alias&rdquo; &mdash; important; keeps replies professional</li>
                      <li>Click Next, then paste the SMTP details from the credentials block above</li>
                      <li>Gmail sends a verification code to <strong>${data.companyEmail}</strong> &mdash; it arrives here in seconds. Paste it &mdash; done.</li>
                    </ol>
                  </td>
                </tr>
              </table>

              <!-- Outlook setup -->
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td style="background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px 24px;">
                    <p style="margin: 0 0 12px 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 13px; color: #0078d4; text-transform: uppercase; letter-spacing: 1.2px; font-weight: 700;">
                      Option B &mdash; Outlook (5 minutes)
                    </p>
                    <p style="margin: 0 0 10px 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 13px; color: #64748b; line-height: 1.5;">
                      Menu names differ across Outlook.com, new Outlook desktop, and Outlook 365 &mdash; SMTP fields are the same.
                    </p>
                    <ol style="margin: 0; padding-left: 22px; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 14px; color: #1e293b; line-height: 1.7;">
                      <li>Outlook &rarr; <strong>Settings</strong> (gear) &rarr; <strong>&ldquo;Mail&rdquo;</strong> &rarr; <strong>&ldquo;Sync email&rdquo;</strong> (or <strong>&ldquo;Connected accounts&rdquo;</strong> in older versions)</li>
                      <li>Click <strong>&ldquo;Other email accounts&rdquo;</strong> &rarr; <strong>&ldquo;Connect&rdquo;</strong> (or <strong>&ldquo;Add a connected account&rdquo;</strong>)</li>
                      <li>Display name: <strong>${data.fullName}</strong> &nbsp;|&nbsp; Email: <strong>${data.companyEmail}</strong></li>
                      <li>Pick <strong>POP</strong> or <strong>IMAP</strong> setup &mdash; we only use the SMTP (outbound) half, so it doesn&rsquo;t matter which</li>
                      <li>Paste SMTP server, port 587, username, password, TLS from the credentials block above</li>
                      <li>Save. Outlook emails a code to <strong>${data.companyEmail}</strong> &mdash; arrives here in seconds. Confirm.</li>
                      <li>Compose a new mail &mdash; <strong>${data.companyEmail}</strong> appears in the From dropdown.</li>
                    </ol>
                    <p style="margin: 12px 0 0 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 12.5px; color: #64748b; line-height: 1.5;">
                      Can&rsquo;t find the menu? Search Outlook settings for &ldquo;SMTP&rdquo; or &ldquo;Send from another email address&rdquo;.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- How you earn -->
          <tr>
            <td style="padding: 32px 0 0 0;">
              <h2 style="margin: 0 0 8px 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 24px; color: #0f172a; font-weight: 800; letter-spacing: -0.3px;">How you earn</h2>
              <p style="margin: 0 0 20px 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 14px; color: #64748b; line-height: 1.6;">
                Every Business you (and your downline Partners) recruit pays a monthly LYMX subscription. You earn a percentage of that revenue, paid in LYMX, every month it stays active.
              </p>
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td style="background-color: #ffffff; border-radius: 12px; padding: 20px 24px; box-shadow: 0 1px 3px rgba(15, 23, 42, 0.04);">
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                      <tr><td style="padding: 12px 0; border-bottom: 1px solid #e2e8f0;"><table width="100%"><tr><td style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 15px; color: #1e293b;"><strong>Direct</strong> &nbsp;<span style="color:#64748b; font-weight:400;">Businesses you personally recruit</span></td><td align="right" style="font-family: 'SF Mono', monospace; font-size: 18px; color: #0a84ff; font-weight: 700;">9%</td></tr></table></td></tr>
                      <tr><td style="padding: 12px 0; border-bottom: 1px solid #e2e8f0;"><table width="100%"><tr><td style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 15px; color: #1e293b;"><strong>G1</strong> &nbsp;<span style="color:#64748b; font-weight:400;">Recruited by your direct Partners</span></td><td align="right" style="font-family: 'SF Mono', monospace; font-size: 18px; color: #13a26b; font-weight: 700;">3%</td></tr></table></td></tr>
                      <tr><td style="padding: 12px 0; border-bottom: 1px solid #e2e8f0;"><table width="100%"><tr><td style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 15px; color: #1e293b;"><strong>G2</strong> &nbsp;<span style="color:#64748b; font-weight:400;">Two layers down</span></td><td align="right" style="font-family: 'SF Mono', monospace; font-size: 18px; color: #13a26b; font-weight: 700;">2%</td></tr></table></td></tr>
                      <tr><td style="padding: 12px 0;"><table width="100%"><tr><td style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 15px; color: #1e293b;"><strong>G3</strong> &nbsp;<span style="color:#64748b; font-weight:400;">Three layers down</span></td><td align="right" style="font-family: 'SF Mono', monospace; font-size: 18px; color: #13a26b; font-weight: 700;">1%</td></tr></table></td></tr>
                    </table>
                  </td>
                </tr>
              </table>
              <p style="margin: 16px 0 0 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 13px; color: #64748b; line-height: 1.5;">
                Plus: $500 cash bonus on every Business you sign up directly, paid via ACH. Tier perks (Gold +1%, Platinum +2%) unlock as your tree grows.
              </p>
            </td>
          </tr>

          <!-- Help -->
          <tr>
            <td style="padding: 32px 0 0 0;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 12px;">
                <tr>
                  <td style="padding: 24px;">
                    <p style="margin: 0 0 8px 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 18px; color: #064e3b; font-weight: 700;">Questions? Just reply.</p>
                    <p style="margin: 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 14px; color: #065f46; line-height: 1.5;">
                      We read every email. If anything in your dashboard, your payout, or your work-email setup isn't working the way you expect, tell us &mdash; we'll sort it.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 32px 0 0 0; text-align: center;">
              <p style="margin: 0 0 8px 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 13px; color: #94a3b8;">LYMX &mdash; the loyalty rewards network for local businesses.</p>
              <p style="margin: 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 12px; color: #94a3b8;">&copy; ${new Date().getFullYear()} 123Partners.net LLC<br>3601 W. Sahara Ave, Suite 201, Las Vegas, NV</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    const text =
        `Welcome to LYMX, ${firstName}.\n\n` +
        (data.foundingTwentyFive
            ? `*** FOUNDING 25 COHORT ***\nYou're in the founding 25. Your $25 sign-up + $12.95/mo partner fees are PERMANENTLY waived — for life, as long as you stay active.\n\n`
            : "") +
        `You're now part of the team building the best loyalty rewards network in Las Vegas. Two things are ready: your partner code for recruiting, and your branded work email.\n\n` +
        `YOUR PARTNER CODE: ${data.referralCode}\n` +
        `YOUR REFERRAL LINK: ${referralLink}\n\n` +
        `Open your dashboard: ${dashboardLink}\n\n` +
        `─────────────────────────────────────\n` +
        `YOUR WORK EMAIL IS READY\n` +
        `─────────────────────────────────────\n\n` +
        `We provisioned ${data.companyEmail} for you. Anything sent there forwards straight to this inbox — nothing for you to install.\n\n` +
        `To SEND from your branded LYMX address (instead of your personal email), follow the one-time Send-as setup in EITHER Gmail OR Outlook:\n\n` +
        `SMTP CREDENTIALS (used by both Gmail and Outlook):\n` +
        `   SMTP Server: ${data.smtpHost}\n` +
        `   Port:        ${port}\n` +
        `   Username:    ${data.smtpUsername}\n` +
        `   Password:    ${data.smtpPassword}\n` +
        `   Connection:  TLS\n\n` +
        `OPTION A — GMAIL (5 minutes, desktop browser only):\n` +
        `1. Gmail → gear icon → "See all settings"\n` +
        `2. "Accounts and Import" tab\n` +
        `3. Under "Send mail as", click "Add another email address"\n` +
        `4. Name: ${data.fullName}\n   Email: ${data.companyEmail}\n` +
        `5. UNCHECK "Treat as an alias" (important)\n` +
        `6. Click Next, paste the SMTP details above\n` +
        `7. Gmail emails ${data.companyEmail} a verification code (arrives here in seconds). Paste it. Done.\n\n` +
        `OPTION B — OUTLOOK (5 minutes, web or desktop):\n` +
        `Menu names differ across Outlook versions, but the SMTP fields are identical.\n` +
        `1. Outlook → Settings (gear) → "Mail" → "Sync email" (or "Connected accounts")\n` +
        `2. Click "Other email accounts" → "Connect" (or "Add a connected account")\n` +
        `3. Display name: ${data.fullName}\n   Email: ${data.companyEmail}\n` +
        `4. Pick POP or IMAP (doesn't matter — we only use the SMTP/outbound half)\n` +
        `5. Paste SMTP server, port 587, username, password, TLS from above\n` +
        `6. Save. Outlook emails ${data.companyEmail} a verification code (arrives here in seconds). Confirm.\n` +
        `7. Compose a new mail — ${data.companyEmail} appears in the From dropdown.\n` +
        `(Can't find the menu? Search Outlook settings for "SMTP" or "Send from another email address".)\n\n` +
        `HOW YOU EARN\n` +
        `Every Business you (and your downline) recruit pays a monthly LYMX subscription. You earn a % of that revenue in LYMX, every month it stays active.\n\n` +
        `  Direct (you personally recruit) ........ 9%\n` +
        `  G1 (your Partners' recruits) ........... 3%\n` +
        `  G2 (two layers down) ................... 2%\n` +
        `  G3 (three layers down) ................. 1%\n\n` +
        `Plus $500 cash bonus on every Business you sign up directly (paid ACH). Tier perks (Gold +1%, Platinum +2%) unlock as your tree grows.\n\n` +
        `Questions? Just reply to this email. We read every one.\n\n` +
        `—\nLYMX — the loyalty rewards network for local businesses.\n© ${new Date().getFullYear()} 123Partners.net LLC\n3601 W. Sahara Ave, Suite 201, Las Vegas, NV`;

    return { subject, html, text };
}
