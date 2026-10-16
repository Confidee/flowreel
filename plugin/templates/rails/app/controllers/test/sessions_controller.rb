# frozen_string_literal: true

# flowreel test seam: POST /test/sign_in_as {email}
#
# Signs an EXISTING, seeded account in without the password form, so the
# development stage never feeds the real sign-in's lockout counter. Staging
# never uses it: the route does not exist there.
#
# Security posture (defense in depth):
#   1. Routed only in test/development (config/routes/flowreel_seams.rb).
#   2. Test::E2eSeamGate: 404 unless Rails.env.local? AND the seam flag.
#   3. It never creates users or grants roles, and it refuses an account that
#      may not sign in (403). It rotates the session like a real sign-in.
#   4. It answers only a JSON body (the gate refuses any other POST). It
#      skips forgery protection (Playwright has no CSRF token), so without
#      that any page the developer opens while the flag is on could post a
#      cross-site HTML form to it and sign that browser in as a seeded admin
#      (login CSRF). A cross-site form can send only form-encoded, multipart
#      or text/plain bodies; a JSON body needs a CORS preflight, which this
#      app never grants.
#
# Returns: 204 No Content + the session cookie on success
#          404 when the gate is closed (including a body that is not JSON or a
#              request that is not from this machine), or no account has
#              that email
#          403 when the account may not sign in
#          400 when `email` is missing
#
# TODO(flowreel): three app-specific spots, all marked below: the auth
# callback to skip, how an account is found, and how a session starts. It
# inherits ApplicationController because starting a session needs your app's
# own session helpers.
class Test::SessionsController < ApplicationController
  include Test::E2eSeamGate

  # TODO(flowreel): skip your app's authentication callback for this action.
  # `raise: false` makes each line a no-op where that callback does not exist.
  skip_before_action :require_authentication, raise: false # Rails 8 authentication generator
  skip_before_action :authenticate_user!, raise: false # Devise
  skip_forgery_protection

  def create
    email = params.require(:email).to_s.strip.downcase
    user = seam_user(email)
    return head :not_found if user.nil?
    return head :forbidden unless may_sign_in?(user)

    establish_session(user)
    head :no_content
  end

  private

  # TODO(flowreel): your account model and its email column. Case-insensitive.
  def seam_user(email)
    User.where("LOWER(email) = ?", email).order(:id).first
  end

  # TODO(flowreel): the same checks your real sign-in makes (locked, inactive,
  # no role in this context, …). Never skip a check the real flow makes.
  def may_sign_in?(user)
    !user.respond_to?(:active_for_authentication?) || user.active_for_authentication?
  end

  # TODO(flowreel): start a session exactly as your real sign-in does.
  def establish_session(user)
    if respond_to?(:start_new_session_for, true) # Rails 8 authentication generator
      start_new_session_for(user)
    elsif respond_to?(:sign_in, true) # Devise / Warden
      sign_in(user)
    else
      reset_session # rotate, like a real sign-in (session fixation)
      session[:user_id] = user.id
    end
  end
end
