# frozen_string_literal: true

# Shared contexts for the flowreel test-seam specs (spec/requests/test/*_spec.rb).
# Require it from spec/rails_helper.rb (or rely on your spec/support autoload):
#
#   Rails.root.glob("spec/support/**/*.rb").sort.each { |f| require f }

# The seam flag set (or cleared) for one example, restored afterwards. The
# request goes to a loopback host, as the development stage's does (the gate
# refuses any other Host; a request spec's default is www.example.com).
RSpec.shared_context "flowreel seam flag" do |value|
  before { host! "127.0.0.1" }

  around do |example|
    flag = Test::E2eSeamGate::FLAG
    previous = ENV[flag]
    value.nil? ? ENV.delete(flag) : ENV[flag] = value
    example.run
  ensure
    ENV[flag] = previous
  end
end

# A deployed non-production environment (staging): neither production? nor
# local?. The gate must key on local?, so the seam stays closed even with the
# flag set.
RSpec.shared_context "flowreel seam on a deployed non-production env" do
  include_context "flowreel seam flag", "true"

  before do
    allow(Rails.env).to receive(:local?).and_return(false)
    expect(Rails.env.production?).to be(false)
  end
end
