# frozen_string_literal: true

require "rails_helper"

# flowreel test seam: GET/DELETE /test/mail_deliveries. Both 404 paths (flag
# off; a deployed non-production env with the flag on) and the protocol
# flowreel's HttpSeamMailDriver reads.
RSpec.describe "Test::MailDeliveries (flowreel delivered-mail seam)", type: :request do
  before do
    stub_const("FlowreelSeamSpecMailer", Class.new(ActionMailer::Base) do
      def note(to:, subject:, text: nil, html: nil, **headers)
        mail(to:, subject:, from: "Agent via Example <support@example.test>", **headers) do |format|
          format.text { render plain: text } if text
          format.html { render html: html.html_safe } if html
        end
      end
    end)
    ActionMailer::Base.deliveries.clear
  end

  after { ActionMailer::Base.deliveries.clear }

  def deliver(**) = FlowreelSeamSpecMailer.note(**).deliver_now

  shared_examples "a closed seam" do
    it "404s both endpoints and clears nothing" do
      deliver(to: "qa@example.test", subject: "kept", text: "x")

      get "/test/mail_deliveries"
      expect(response).to have_http_status(:not_found)

      delete "/test/mail_deliveries"
      expect(response).to have_http_status(:not_found)
      expect(ActionMailer::Base.deliveries.size).to eq(1)
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

    it "returns an empty list and cursor 0 when nothing was delivered" do
      get "/test/mail_deliveries"
      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to eq("deliveries" => [], "cursor" => 0)
    end

    it "serializes a delivered mail (display-name From, bracketed ids, lower-cased headers)" do
      deliver(
        to: "agent@example.test", cc: "watcher@example.test", subject: "[RQ-7] Quote request",
        text: "Thanks for your request.", reply_to: "reply+tok123@reply.example.test",
        message_id: "<out-1@example.test>", in_reply_to: "<in-1@example.test>",
        references: "<root@example.test> <in-1@example.test>"
      )

      get "/test/mail_deliveries"
      entry = response.parsed_body["deliveries"].sole
      expect(entry).to include(
        "index" => 1,
        "messageId" => "<out-1@example.test>",
        "from" => ["Agent via Example <support@example.test>"],
        "to" => ["agent@example.test"],
        "cc" => ["watcher@example.test"],
        "replyTo" => ["reply+tok123@reply.example.test"],
        "subject" => "[RQ-7] Quote request",
        "text" => "Thanks for your request.",
        "inReplyTo" => "<in-1@example.test>",
        "references" => ["<root@example.test>", "<in-1@example.test>"]
      )
      expect(entry["headers"]).to include("subject" => "[RQ-7] Quote request")
      expect(Time.iso8601(entry["deliveredAt"])).to be_within(1.minute).of(Time.current)
      expect(response.parsed_body["cursor"]).to eq(1)
    end

    it "prefers the text part of a multipart mail and strips HTML-only mail to text" do
      deliver(to: "qa@example.test", subject: "multi", text: "Plain body", html: "<p>Html body</p>")
      deliver(to: "qa@example.test", subject: "html", html: "<p>Hello <b>there</b></p><p>Ref 1</p>")

      get "/test/mail_deliveries"
      texts = response.parsed_body["deliveries"].to_h { |d| [d["subject"], d["text"]] }
      expect(texts["multi"]).to eq("Plain body")
      expect(texts["html"]).to include("Hello there").and include("Ref 1")
      expect(texts["html"]).not_to include("<")
    end

    it "returns only entries after the cursor, and the new cursor" do
      deliver(to: "qa@example.test", subject: "first", text: "1")
      deliver(to: "qa@example.test", subject: "second", text: "2")

      get "/test/mail_deliveries", params: {after: 1}
      expect(response.parsed_body["deliveries"].map { |d| [d["index"], d["subject"]] }).to eq([[2, "second"]])
      expect(response.parsed_body["cursor"]).to eq(2)

      get "/test/mail_deliveries", params: {after: 2}
      expect(response.parsed_body).to eq("deliveries" => [], "cursor" => 2)
    end

    it "caps the response at the most recent MAX_DELIVERIES entries" do
      stub_const("Test::MailDeliveriesController::MAX_DELIVERIES", 2)
      3.times { |i| deliver(to: "qa@example.test", subject: "m#{i}", text: "x") }

      get "/test/mail_deliveries"
      expect(response.parsed_body["deliveries"].map { |d| d["index"] }).to eq([2, 3])
    end

    it "stamps a stable Message-ID on a mail delivered without one" do
      ActionMailer::Base.deliveries << Mail.new(to: "qa@example.test", from: "a@example.test", subject: "bare", body: "x")

      get "/test/mail_deliveries"
      first = response.parsed_body["deliveries"].sole["messageId"]
      get "/test/mail_deliveries"
      expect(first).to match(/\A<.+>\z/)
      expect(response.parsed_body["deliveries"].sole["messageId"]).to eq(first)
    end

    it "DELETE clears the deliveries and resets the cursor" do
      deliver(to: "qa@example.test", subject: "gone", text: "x")

      delete "/test/mail_deliveries"
      expect(response).to have_http_status(:no_content)
      expect(ActionMailer::Base.deliveries).to be_empty

      get "/test/mail_deliveries"
      expect(response.parsed_body).to eq("deliveries" => [], "cursor" => 0)
    end
  end
end
