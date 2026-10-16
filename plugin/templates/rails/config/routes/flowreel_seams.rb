# frozen_string_literal: true

# flowreel test seams: the route half of the double gate (the controller half
# is Test::E2eSeamGate). Load it from config/routes.rb, inside the
# `Rails.application.routes.draw do … end` block:
#
#   draw(:flowreel_seams)
#
# The routes exist only in the test and development environments: in
# production and on staging a request 404s at the routing layer and never
# reaches a controller. Drop the lines of any seam your flows do not use.
if Rails.env.test? || Rails.env.development?
  post "test/sign_in_as", to: "test/sessions#create"
  get "test/mail_deliveries", to: "test/mail_deliveries#index"
  delete "test/mail_deliveries", to: "test/mail_deliveries#destroy"
  post "test/perform_enqueued_jobs", to: "test/enqueued_jobs#create"
  post "test/inbound_emails", to: "test/inbound_emails#create"
end
