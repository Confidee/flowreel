# frozen_string_literal: true

require "rails_helper"

# flowreel test seam: POST /test/sign_in_as. Both 404 paths (flag off; a
# deployed non-production env with the flag on), the happy path, a form post
# (login CSRF: 404) and an account that may not sign in (403).
#
# TODO(flowreel): `user` must be an account your real sign-in accepts, built
# the way your other specs build one (a factory, a fixture).
RSpec.describe "Test::Sessions (flowreel sign-in seam)", type: :request do
  let(:email) { "seam-user@example.test" }
  let!(:user) { User.create!(email:) }

  def sign_in_as(address = email) = post("/test/sign_in_as", params: {email: address}, as: :json)

  context "without the seam flag" do
    include_context "flowreel seam flag", nil

    it "404s and sets no session cookie" do
      sign_in_as
      expect(response).to have_http_status(:not_found)
      expect(response.headers["Set-Cookie"]).to be_blank
    end
  end

  context "on a deployed non-production env with the flag set" do
    include_context "flowreel seam on a deployed non-production env"

    it "404s and sets no session cookie" do
      sign_in_as
      expect(response).to have_http_status(:not_found)
      expect(response.headers["Set-Cookie"]).to be_blank
    end
  end

  context "with the seam flag" do
    include_context "flowreel seam flag", "true"

    it "signs the account in: 204 and a session cookie" do
      sign_in_as(email.upcase)
      expect(response).to have_http_status(:no_content)
      expect(response.headers["Set-Cookie"]).to be_present
    end

    it "404s for an unknown account (never creates one)" do
      expect { sign_in_as("nobody@example.test") }.not_to change(User, :count)
      expect(response).to have_http_status(:not_found)
    end

    it "400s without an email" do
      post "/test/sign_in_as", params: {}, as: :json
      expect(response).to have_http_status(:bad_request)
    end

    it "404s for a form-encoded post (a cross-site form) and sets no session cookie" do
      post "/test/sign_in_as", params: {email:}
      expect(response).to have_http_status(:not_found)
      expect(response.headers["Set-Cookie"]).to be_blank
    end

    # TODO(flowreel): replace the stub with an account your real sign-in
    # refuses (locked, inactive, no role), built the way your specs build one.
    it "403s for an account that may not sign in and sets no session cookie" do
      allow_any_instance_of(Test::SessionsController).to receive(:may_sign_in?).and_return(false)
      sign_in_as
      expect(response).to have_http_status(:forbidden)
      expect(response.headers["Set-Cookie"]).to be_blank
    end
  end
end
