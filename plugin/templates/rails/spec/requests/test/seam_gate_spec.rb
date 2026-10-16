# frozen_string_literal: true

require "rails_helper"

# Tripwire: every route under a /test/ segment (the flowreel test seams and any
# seam added later) is served by a controller that includes Test::E2eSeamGate,
# so no seam can ship with only the route half of the double gate. The reverse
# holds too: a gated seam controller is routed only under /test/, so a seam
# moved or added elsewhere cannot slip out of this check.
#
# It walks the main app's routes and the routes of every mounted engine, and
# reads a path with its optional segments removed, so a seam drawn inside a
# scope ("/(:locale)/test/…") or an engine mounted at "/admin" ("/admin/test/…")
# is checked as well.
RSpec.describe "flowreel test seams: the gate covers every /test/ route" do
  # A "test" path segment anywhere in the path.
  seam_path = ->(path) { path.match?(%r{(\A|/)test/}) }

  # The path spec without its optional groups: "/(:locale)/test/x(.:format)"
  # becomes "//test/x".
  plain = lambda do |spec|
    path = spec.to_s
    path = path.gsub(/\([^()]*\)/, "") while path.match?(/\([^()]*\)/)
    path
  end

  # [path, controller class or nil, controller name or nil] for every route,
  # mounted engines included (their routes carry the mount path as a prefix).
  collect = lambda do |route_set, prefix = ""|
    route_set.routes.flat_map do |route|
      path = prefix + plain.call(route.path.spec)
      rack_app = route.app.respond_to?(:app) ? route.app.app : route.app
      if rack_app.respond_to?(:routes) && rack_app.routes.is_a?(ActionDispatch::Routing::RouteSet)
        collect.call(rack_app.routes, path.chomp("/"))
      else
        name = route.defaults[:controller]
        klass = name && "#{name}_controller".camelize.safe_constantize
        [[path, klass, name]]
      end
    end
  end

  let(:routes) { collect.call(Rails.application.routes) }

  it "includes Test::E2eSeamGate in each /test/ route's controller" do
    seams = routes.select { |path, _klass, _name| seam_path.call(path) }
    expect(seams).not_to be_empty

    ungated = seams.filter_map do |path, klass, name|
      if name.nil?
        "#{path} (no controller: a redirect, a mounted app or a dynamic segment)"
      elsif klass.nil?
        "#{path} (controller #{name} not found)"
      elsif !klass.include?(Test::E2eSeamGate)
        path
      end
    end
    expect(ungated).to be_empty, "ungated seams: #{ungated.join(", ")}"
  end

  it "routes every gated seam controller only under /test/" do
    outside = routes.filter_map do |path, klass, _name|
      next if seam_path.call(path)

      path if klass.is_a?(Class) && klass.include?(Test::E2eSeamGate)
    end
    expect(outside).to be_empty, "seams routed outside /test/: #{outside.join(", ")}"
  end
end

# The gate's request checks, which every seam inherits: with the flag on in a
# local environment, a POST without a JSON body (a cross-site form) and a
# request that does not come from this machine by a loopback Host (a
# DNS-rebinding page) both answer 404, like a closed gate.
RSpec.describe "flowreel test seams: the gate refuses cross-site and non-local requests", type: :request do
  include_context "flowreel seam flag", "true"

  it "404s a form-encoded POST and runs nothing" do
    post "/test/perform_enqueued_jobs", params: {x: "1"}
    expect(response).to have_http_status(:not_found)
  end

  it "404s a POST with no body and no content type" do
    post "/test/perform_enqueued_jobs"
    expect(response).to have_http_status(:not_found)
  end

  it "404s a text/plain POST" do
    post "/test/inbound_emails", params: "{}", headers: {"CONTENT_TYPE" => "text/plain"}
    expect(response).to have_http_status(:not_found)
  end

  it "404s a request whose Host is not loopback (DNS rebinding)" do
    host! "rebind.attacker.example"
    get "/test/mail_deliveries"
    expect(response).to have_http_status(:not_found)
  end

  it "404s a request from a non-loopback client address" do
    get "/test/mail_deliveries", env: {"REMOTE_ADDR" => "203.0.113.7"}
    expect(response).to have_http_status(:not_found)
  end

  it "answers a JSON POST and a GET from this machine" do
    post "/test/perform_enqueued_jobs", as: :json
    expect(response).to have_http_status(:ok)
    get "/test/mail_deliveries"
    expect(response).to have_http_status(:ok)
  end
end
