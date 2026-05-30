-- =============================================================================
-- Migration 135 — per-page feature keys for the remaining admin pages (Phase 2)
-- =============================================================================
-- Fully-granular gating (Kenny 2026-05-30): each non-HR admin page gets its own
-- permission key so access can be delegated per page via Manage Permissions.
-- Pages are gated in the frontend with data-role-required="perm:<key>".
-- default_for_roles = {admin} so only true admins get them automatically; anyone
-- else needs an explicit grant (e.g. Dave = grant-all-except-HR).
-- Idempotent.
-- =============================================================================

insert into public.feature_catalog
    (feature_key, label, description, category, default_for_roles, playbook_slug, page_paths)
values
    ('admin_approvals', 'Approvals', 'Admin page: /admin-approvals.html', 'Network', array['admin'], null, array['/admin-approvals.html']),
    ('admin_bookings', 'All bookings', 'Admin page: /admin-bookings.html', 'Network', array['admin'], null, array['/admin-bookings.html']),
    ('admin_broadcast', 'Broadcast', 'Admin page: /admin-broadcast.html', 'Comms', array['admin'], null, array['/admin-broadcast.html']),
    ('admin_business_applications', 'Business Applications', 'Admin page: /admin-business-applications.html', 'Network', array['admin'], null, array['/admin-business-applications.html']),
    ('admin_business_transfer', 'Transfer business ownership', 'Admin page: /admin-business-transfer.html', 'Network', array['admin'], null, array['/admin-business-transfer.html']),
    ('admin_businesses', 'Businesses', 'Admin page: /admin-businesses.html', 'Network', array['admin'], null, array['/admin-businesses.html']),
    ('admin_chat', 'Team Chat', 'Admin page: /admin-chat.html', 'Comms', array['admin'], null, array['/admin-chat.html']),
    ('admin_compliance', 'Pre-launch compliance', 'Admin page: /admin-compliance.html', 'Admin Ops', array['admin'], null, array['/admin-compliance.html']),
    ('admin_compose_email', 'Compose Email', 'Admin page: /admin-compose-email.html', 'Comms', array['admin'], null, array['/admin-compose-email.html']),
    ('admin_conversations', 'Conversations', 'Admin page: /admin-conversations.html', 'Comms', array['admin'], null, array['/admin-conversations.html']),
    ('admin_customers', 'Customers', 'Admin page: /admin-customers.html', 'Network', array['admin'], null, array['/admin-customers.html']),
    ('admin_dashboard', 'Admin home', 'Admin page: /admin-dashboard.html', 'Admin Ops', array['admin'], null, array['/admin-dashboard.html']),
    ('admin_digest', 'Weekly Digest', 'Admin page: /admin-digest.html', 'Comms', array['admin'], null, array['/admin-digest.html']),
    ('admin_emails', 'Email Events', 'Admin page: /admin-emails.html', 'Comms', array['admin'], null, array['/admin-emails.html']),
    ('admin_event_edit', 'Edit event', 'Admin page: /admin-event-edit.html', 'Network', array['admin'], null, array['/admin-event-edit.html']),
    ('admin_events', 'Events', 'Admin page: /admin-events.html', 'Network', array['admin'], null, array['/admin-events.html']),
    ('admin_fraud_flags', 'Fraud flags', 'Admin page: /admin-fraud-flags.html', 'Network', array['admin'], null, array['/admin-fraud-flags.html']),
    ('admin_health', 'System Health', 'Admin page: /admin-health.html', 'Admin Ops', array['admin'], null, array['/admin-health.html']),
    ('admin_investors', 'Investor pipeline', 'Admin page: /admin-investors.html', 'Network', array['admin'], null, array['/admin-investors.html']),
    ('admin_invite_friends', 'Invite Friends', 'Admin page: /admin-invite-friends.html', 'Network', array['admin'], null, array['/admin-invite-friends.html']),
    ('admin_launch_rsvps', 'Launch RSVPs', 'Admin page: /admin-launch-rsvps.html', 'Network', array['admin'], null, array['/admin-launch-rsvps.html']),
    ('admin_onboarding_calendar', 'Onboarding Calendar', 'Admin page: /admin-onboarding-calendar.html', 'Network', array['admin'], null, array['/admin-onboarding-calendar.html']),
    ('admin_outreach', 'Cold Outreach', 'Admin page: /admin-outreach.html', 'Comms', array['admin'], null, array['/admin-outreach.html']),
    ('admin_partners', 'Partners', 'Admin page: /admin-partners.html', 'Network', array['admin'], null, array['/admin-partners.html']),
    ('admin_playbooks', 'Playbooks', 'Admin page: /admin-playbooks.html', 'Admin Ops', array['admin'], null, array['/admin-playbooks.html']),
    ('admin_promos', 'Promos', 'Admin page: /admin-promos.html', 'Network', array['admin'], null, array['/admin-promos.html']),
    ('admin_reserved_codes', 'Reserved Partner Codes', 'Admin page: /admin-reserved-codes.html', 'Network', array['admin'], null, array['/admin-reserved-codes.html']),
    ('admin_reviews', 'Review Verification', 'Admin page: /admin-reviews.html', 'Network', array['admin'], null, array['/admin-reviews.html']),
    ('admin_runbook', 'Operations runbook', 'Admin page: /admin-runbook.html', 'Admin Ops', array['admin'], null, array['/admin-runbook.html']),
    ('admin_settlements', 'Business Settlements', 'Admin page: /admin-settlements.html', 'Finance', array['admin'], null, array['/admin-settlements.html']),
    ('admin_sms', 'SMS', 'Admin page: /admin-sms.html', 'Comms', array['admin'], null, array['/admin-sms.html']),
    ('admin_tech_support', 'Tech Support', 'Admin page: /admin-tech-support.html', 'Comms', array['admin'], null, array['/admin-tech-support.html']),
    ('admin_tickets', 'Support tickets', 'Admin page: /admin-tickets.html', 'Comms', array['admin'], null, array['/admin-tickets.html']),
    ('admin_verifications', 'Verifications', 'Admin page: /admin-verifications.html', 'Network', array['admin'], null, array['/admin-verifications.html'])
on conflict (feature_key) do update set
    label=excluded.label, description=excluded.description, category=excluded.category,
    page_paths=excluded.page_paths, is_active=true, updated_at=now();

do $s$ declare n int; begin
  select count(*) into n from public.feature_catalog where feature_key like 'admin_%' and is_active;
  raise notice 'Migration 135 OK - % admin_* feature keys active.', n;
end$s$;
-- END migration 135
