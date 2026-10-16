# frozen_string_literal: true

# The controller half of the flowreel test seams' double gate. The route half
# is config/routes/flowreel_seams.rb, drawn only in the test and development
# environments.
#
# Every action answers 404 (the same shape as a missing route, so nothing can
# probe whether a seam exists) unless ALL of these hold:
#
#   1. the process runs in a local environment (`Rails.env.local?`: development
#      or test). Keyed on local?, never on `!Rails.env.production?`: a deployed
#      staging environment is not production, so a "not production" check would
#      reduce to the flag alone there;
#   2. ENV[FLAG] is exactly "true". Set it ONLY in the development stage's web
#      server (the `webServer.env` of e2e/flowreel/playwright.config.ts) and in
#      CI. `bin/dev`, `bin/rails server` and `bin/rspec` never set it;
#   3. the request comes from this machine and names it: `request.local?` (the
#      client address is loopback) and a loopback Host (LOOPBACK_HOSTS). The
#      development stage runs the app in the test environment, where Rails'
#      host authorization is off, so without this a DNS-rebinding page could
#      reach the seams through the developer's browser (read delivered mail
#      and its reply tokens, or sign in as a seeded account);
#   4. a POST carries a JSON body (`application/json`). A cross-site page can
#      send a form-encoded, multipart or text/plain POST (or one with no body)
#      without a CORS preflight; a JSON body needs one, which the app never
#      grants. So no page the developer opens while the flag is on can inject
#      inbound mail, drain the job queue or sign the browser in. PUT, PATCH
#      and DELETE always need a preflight cross-site, and GET is read-only
#      (and covered by check 3).
#
# Prepended, so it answers before any other callback touches the session.
#
# TODO(flowreel): rename FLAG if your app already has a test-seam flag, and
# keep it in step with the web server's env in your Playwright config.
module Test::E2eSeamGate
  extend ActiveSupport::Concern

  FLAG = "FLOWREEL_TEST_SEAMS"
  # request.host keeps the brackets of an IPv6 literal on some Rails versions.
  LOOPBACK_HOSTS = %w[localhost 127.0.0.1 ::1 [::1]].freeze

  included do
    prepend_before_action { head :not_found unless e2e_seam_enabled? }
  end

  private

  def e2e_seam_enabled?
    Rails.env.local? && ENV[Test::E2eSeamGate::FLAG] == "true" &&
      e2e_seam_local_request? && e2e_seam_body_allowed?
  end

  def e2e_seam_local_request?
    request.local? && LOOPBACK_HOSTS.include?(request.host)
  end

  def e2e_seam_body_allowed?
    !request.post? || request.media_type == "application/json"
  end
end
