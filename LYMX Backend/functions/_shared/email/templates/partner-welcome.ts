// =============================================================================
// LYMX Power — Partner Welcome Email Template
// =============================================================================
// Sent to a new partner the moment their LYMX signup is processed.
//
// Payload includes:
//   1. Welcome + their unique partner code (used to recruit Businesses + Partners)
//   2. Their auto-provisioned company email (firstname.lastname@getlymx.com)
//   3. The one-time Gmail "Send mail as" walkthrough so they can REPLY from
//      that company email — looks professional when prospecting Businesses.
//   4. Earnings overview — 9% direct / 3% G1 / 2% G2 / 1% G3 (per Partner
//      Playbook, all paid in LYMX)
//   5. Founding 25 reminder if applicable (lifetime fee waiver perk)
//   6. CTA to dashboard + "Reply if you need help" footer
//
// ARCHITECTURE NOTE:
//   This template assumes the company-email infrastructure described in
//   shared/COMPANY-EMAIL-ARCHITECTURE.md is in place:
//   - Cloudflare Email Routing handles inbound to *@getlymx.com (free)
//   - Amazon SES handles outbound when partners reply via Gmail SMTP relay
//   - Each partner gets per-agent SMTP credentials so we can revoke on offboard
//
//   The Edge Function that calls this template is responsible for:
//   - Generating the local-part (e.g. firstname.lastname, with .2/.3 on collision)
//   - Creating the Cloudflare route via API
//   - Creating the SES email identity + SMTP credentials
//   - Storing the result in the partners + agent_emails tables
//   - Then calling this template + sending via Resend (or SES itself)
//
// IMPORTANT: This is a pure function — no Deno-specific imports — so it can be
// reused across functions and even unit-tested in plain Node if needed.
// =============================================================================

export interface PartnerWelcomeData {
    /** Partner's full name, used for greeting + Gmail "Send mail as" Name field */
    fullName: string;
    /** Partner's unique referral code (e.g. "KENNY", "MAYA42") */
    referralCode: string;
    /** Site URL — defaults to https://getlymx.com */
    siteUrl?: string;

    // ---- Company email + SMTP (per COMPANY-EMAIL-ARCHITECTURE.md) -----------
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
                    <p style="margin: 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 15px; color: #ffffff; font-weight: 600; line-height: 1.4;">
                      You're in the founding 25. Your $25 sign-up + $12.95/mo partner fees are <strong>permanently waived</strong> — for life, as long as you stay active.
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
  <style>
    body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { -ms-interpolation-mode: bicubic; border: 0; height: auto; line-height: 100%; outline: none; text-decoration: none; }
    body { margin: 0 !important; padding: 0 !important; width: 100% !important; }
    @media screen and (max-width: 600px) {
      .container { width: 100% !important; padding: 16px !important; }
      h1 { font-size: 28px !important; line-height: 1.2 !important; }
      h2 { font-size: 22px !important; }
    }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: #f5f8fc;">
  <div style="display: none; max-height: 0; overflow: hidden; mso-hide: all;">
    Your LYMX partner code is ${data.referralCode}. Your work email ${data.companyEmail} is set up and forwarding here.
  </div>

  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color: #f5f8fc;">
    <tr>
      <td align="center" style="padding: 40px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" class="container" style="max-width: 600px;">

          <!-- Logo -->
          <tr>
            <td align="left" style="padding: 0 0 24px 0;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="background: linear-gradient(135deg, #0a84ff, #13a26b); width: 36px; height: 36px; border-radius: 8px; text-align: center; vertical-align: middle;">
                    <span style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; color: #ffffff; font-size: 18px; font-weight: 800; line-height: 36px; letter-spacing: 0.5px;">LX</span>
                  </td>
                  <td style="padding-left: 10px; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 22px; font-weight: 700; color: #0f172a; letter-spacing: -0.3px;">
                    LYMX
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          ${foundingBanner}

          <!-- Hero card -->
          <tr>
            <td style="background-color: #ffffff; border-radius: 16px; padding: 40px; box-shadow: 0 1px 3px rgba(15, 23, 42, 0.04);">
              <p style="margin: 0 0 12px 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 12.5px; color: #0050c7; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; background: rgba(10, 132, 255, 0.08); display: inline-block; padding: 6px 12px; border-radius: 999px;">
                You're in
              </p>
              <h1 style="margin: 16px 0 16px 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 36px; line-height: 1.15; color: #0f172a; font-weight: 800; letter-spacing: -0.6px;">
                Welcome to LYMX,<br>${firstName}.
              </h1>
              <p style="margin: 0 0 28px 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 17px; line-height: 1.6; color: #475569;">
                You're now part of the team building the best loyalty rewards network in Las Vegas. Two things are ready for you below: <strong>your partner code</strong> for recruiting, and <strong>your branded work email</strong> so you look the part when you're prospecting.
              </p>

              <!-- Referral code box -->
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

              <!-- CTA -->
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin: 32px 0 0 0;">
                <tr>
                  <td align="center">
                    <a href="${dashboardLink}" style="background: linear-gradient(135deg, #0a84ff, #0050c7); color: #ffffff; display: inline-block; padding: 14px 32px; border-radius: 999px; text-decoration: none; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-weight: 600; font-size: 16px; box-shadow: 0 4px 12px rgba(10, 132, 255, 0.25);">
                      Open your dashboard →
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
                We provisioned <strong style="color: #0a84ff;">${data.companyEmail}</strong> for you. Anything sent there forwards
                straight to this inbox — nothing for you to install. To <em>reply</em> from your branded
                LYMX address (instead of your personal Gmail), follow the one-time setup below.
              </p>

              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td style="background-color: #f0f7ff; border: 1px solid #cfe3ff; border-radius: 12px; padding: 24px;">
                    <p style="margin: 0 0 12px 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 13px; color: #0050c7; text-transform: uppercase; letter-spacing: 1.2px; font-weight: 700;">
                      In Gmail (5 minutes, one time)
                    </p>
                    <ol style="margin: 0 0 16px 0; padding-left: 22px; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 14px; color: #1e293b; line-height: 1.7;">
                      <li>Gmail → Settings (gear icon) → "See all settings"</li>
                      <li>Click the <strong>"Accounts and Import"</strong> tab</li>
                      <li>In <strong>"Send mail as"</strong>, click <strong>"Add another email address"</strong></li>
                      <li>Name: <strong>${data.fullName}</strong> &nbsp;|&nbsp; Email: <strong>${data.companyEmail}</strong></li>
                      <li><em>Uncheck</em> "Treat as an alias" — important; keeps replies professional</li>
                      <li>Click Next, then enter the SMTP details below</li>
                    </ol>

                    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color: #ffffff; border-radius: 8px; padding: 16px;">
                      <tr>
                        <td style="padding: 4px 0;">
                          <table role="presentation" width="100%"><tr>
                            <td style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 13px; color: #64748b; width: 130px;">SMTP Server</td>
                            <td style="font-family: 'SF Mono', 'Menlo', 'Courier New', monospace; font-size: 13px; color: #0f172a;">${data.smtpHost}</td>
                          </tr></table>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 4px 0;">
                          <table role="presentation" width="100%"><tr>
                            <td style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 13px; color: #64748b; width: 130px;">Port</td>
                            <td style="font-family: 'SF Mono', 'Menlo', 'Courier New', monospace; font-size: 13px; color: #0f172a;">${port}</td>
                          </tr></table>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 4px 0;">
                          <table role="presentation" width="100%"><tr>
                            <td style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 13px; color: #64748b; width: 130px;">Username</td>
                            <td style="font-family: 'SF Mono', 'Menlo', 'Courier New', monospace; font-size: 13px; color: #0f172a; word-break: break-all;">${data.smtpUsername}</td>
                          </tr></table>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 4px 0;">
                          <table role="presentation" width="100%"><tr>
                            <td style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 13px; color: #64748b; width: 130px;">Password</td>
                            <td style="font-family: 'SF Mono', 'Menlo', 'Courier New', monospace; font-size: 13px; color: #0f172a; word-break: break-all;">${data.smtpPassword}</td>
                          </tr></table>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 4px 0;">
                          <table role="presentation" width="100%"><tr>
                            <td style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 13px; color: #64748b; width: 130px;">Connection</td>
                            <td style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 13px; color: #0f172a;">TLS (Gmail handles this automatically)</td>
                          </tr></table>
                        </td>
                      </tr>
                    </table>

                    <p style="margin: 16px 0 0 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 13px; color: #0050c7; line-height: 1.6;">
                      Gmail will email <strong>${data.companyEmail}</strong> a verification code. Since that
                      address forwards back to this inbox, you'll get the code in seconds. Paste it into Gmail —
                      done. From now on, when you compose a message you can pick ${data.companyEmail} in the
                      From dropdown.
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
                      We read every email. If anything in your dashboard, your payout, or your work-email setup isn't working the way you expect, tell us — we'll sort it.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 32px 0 0 0; text-align: center;">
              <p style="margin: 0 0 8px 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 13px; color: #94a3b8;">LYMX — the loyalty rewards network for local businesses.</p>
              <p style="margin: 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 12px; color: #94a3b8;">© ${new Date().getFullYear()} 123Partners.net LLC<br>3601 W. Sahara Ave, Suite 201, Las Vegas, NV</p>
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
        `You're now part of the team building the best loyalty rewards network in Las Vegas. Two things are ready for you: your partner code for recruiting, and your branded work email so you look the part when you're prospecting.\n\n` +
        `YOUR PARTNER CODE: ${data.referralCode}\n` +
        `YOUR REFERRAL LINK: ${referralLink}\n\n` +
        `Open your dashboard: ${dashboardLink}\n\n` +
        `─────────────────────────────────────\n` +
        `YOUR WORK EMAIL IS READY\n` +
        `─────────────────────────────────────\n\n` +
        `We provisioned ${data.companyEmail} for you. Anything sent there forwards straight to this inbox — nothing for you to install.\n\n` +
        `To REPLY from your branded LYMX address (instead of your personal Gmail), follow the one-time setup:\n\n` +
        `IN GMAIL (5 minutes, one time):\n` +
        `1. Gmail → Settings (gear icon) → "See all settings"\n` +
        `2. Click the "Accounts and Import" tab\n` +
        `3. In "Send mail as", click "Add another email address"\n` +
        `4. Name: ${data.fullName}\n   Email: ${data.companyEmail}\n` +
        `5. UNCHECK "Treat as an alias" — important\n` +
        `6. Click Next, then enter:\n\n` +
        `   SMTP Server: ${data.smtpHost}\n` +
        `   Port:        ${port}\n` +
        `   Username:    ${data.smtpUsername}\n` +
        `   Password:    ${data.smtpPassword}\n` +
        `   Connection:  TLS\n\n` +
        `7. Gmail emails ${data.companyEmail} a verification code (which forwards here in seconds). Paste it in Gmail. Done.\n\n` +
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
