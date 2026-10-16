# frozen_string_literal: true

require "rails_helper"

# flowreel test seam: POST /test/perform_enqueued_jobs. Both 404 paths (flag
# off; a deployed non-production env with the flag on) and the drain rules.
RSpec.describe "Test::EnqueuedJobs (flowreel job-drain seam)", type: :request do
  let(:queue) { ActiveJob::Base.queue_adapter.enqueued_jobs }

  before do
    stub_const("FlowreelSeamSpecMailer", Class.new(ActionMailer::Base) do
      def note(to:, subject:)
        mail(to:, subject:, from: "bot@example.test") { |format| format.text { render plain: "drained" } }
      end
    end)
    queue.clear
    ActionMailer::Base.deliveries.clear
  end

  after do
    queue.clear
    ActionMailer::Base.deliveries.clear
  end

  def drain = post("/test/perform_enqueued_jobs", as: :json)

  shared_examples "a closed seam" do
    it "404s and runs nothing" do
      FlowreelSeamSpecMailer.note(to: "qa@example.test", subject: "queued").deliver_later

      drain
      expect(response).to have_http_status(:not_found)
      expect(queue.size).to eq(1)
      expect(ActionMailer::Base.deliveries).to be_empty
    end
  end

  context "without the seam flag" do
    include_context "flowreel seam flag", nil
    it_behaves_like "a closed seam"
  end

  context "on a deployed non-production env with the flag set" do
    include_context "flowreel seam on a deployed non-production env"
    it_behaves_like "a closed seam"
  end

  context "with the seam flag" do
    include_context "flowreel seam flag", "true"

    it "delivers a queued mail" do
      FlowreelSeamSpecMailer.note(to: "qa@example.test", subject: "queued").deliver_later

      drain
      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to eq(
        "performed" => 1, "discarded" => 0, "deferred" => 0, "deferredJobs" => [], "errors" => []
      )
      expect(ActionMailer::Base.deliveries.map(&:subject)).to eq(["queued"])
      expect(queue).to be_empty
    end

    it "runs jobs enqueued by drained jobs (multi-pass)" do
      stub_const("FlowreelSeamChainJob", Class.new(ActiveJob::Base) do
        def perform = FlowreelSeamSpecMailer.note(to: "qa@example.test", subject: "chained").deliver_later
      end)
      FlowreelSeamChainJob.perform_later

      drain
      expect(response.parsed_body["performed"]).to eq(2)
      expect(ActionMailer::Base.deliveries.map(&:subject)).to eq(["chained"])
    end

    it "leaves a future-scheduled job queued and reports it as deferred" do
      FlowreelSeamSpecMailer.note(to: "qa@example.test", subject: "later").deliver_later(wait: 1.hour)

      drain
      expect(response.parsed_body).to include(
        "performed" => 0, "deferred" => 1, "deferredJobs" => ["ActionMailer::MailDeliveryJob(FlowreelSeamSpecMailer#note)"]
      )
      expect(ActionMailer::Base.deliveries).to be_empty
      expect(queue.size).to eq(1)
    end

    it "records a raising job and carries on with the rest" do
      stub_const("FlowreelSeamBoomJob", Class.new(ActiveJob::Base) { def perform = raise("boom") })
      FlowreelSeamBoomJob.perform_later
      FlowreelSeamSpecMailer.note(to: "qa@example.test", subject: "survivor").deliver_later

      drain
      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["errors"]).to eq([{"job" => "FlowreelSeamBoomJob", "error" => "RuntimeError: boom"}])
      expect(ActionMailer::Base.deliveries.map(&:subject)).to eq(["survivor"])
    end

    it "discards ActionMailbox::RoutingJob (the inbound seam routes by hand)", if: defined?(ActionMailbox) do
      raw = Mail.new(to: "in@example.test", from: "e2e@example.test", subject: "Routed?", body: "x").to_s
      inbound = ActionMailbox::InboundEmail.create_and_extract_message_id!(raw)
      expect(queue.map { |job| job[:job] }).to include(ActionMailbox::RoutingJob)

      drain
      expect(response.parsed_body).to include("performed" => 0, "discarded" => 1, "errors" => [])
      expect(inbound.reload.status).to eq("pending")
    end

    it "422s when the queue adapter is not the :test adapter (never swaps it)" do
      allow(ActiveJob::Base).to receive(:queue_adapter).and_return(ActiveJob::QueueAdapters::InlineAdapter.new)

      drain
      expect(response).to have_http_status(422)
      expect(response.parsed_body["error"]).to include("InlineAdapter")
    end
  end
end
