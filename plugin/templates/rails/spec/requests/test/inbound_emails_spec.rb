# frozen_string_literal: true

require "rails_helper"

# flowreel test seam: POST /test/inbound_emails. Both 404 paths (flag off; a
# deployed non-production env with the flag on) and the protocol flowreel's
# HttpSeamMailDriver speaks. The mailbox here is a stand-in: the router is
# told to pick it, so the spec does not depend on your routing rules.
#
# TODO(flowreel): add an example per mailbox your flows reach, through your
# real routing (no router stub), asserting the record the mail created.
RSpec.describe "Test::InboundEmails (flowreel inbound-mail seam)", type: :request do
  let(:processed) { [] }

  before do
    seen = processed
    stub_const("FlowreelSeamSpecMailbox", Class.new(ActionMailbox::Base) do
      define_method(:process) do
        seen << mail
        bounced! if mail.subject == "bounce me"
      end
    end)
    allow(ApplicationMailbox.router).to receive(:mailbox_for).and_return(FlowreelSeamSpecMailbox)
  end

  def post_inbound(params = {})
    post "/test/inbound_emails", params: {
      mode: "support_address", to: "help@example.test", from: "requester@example.test",
      subject: "Please quote", body: "Hello", message_id: "<in-1@example.test>"
    }.merge(params), as: :json
  end

  shared_examples "a closed seam" do
    it "404s and stores nothing" do
      expect { post_inbound }.not_to change(ActionMailbox::InboundEmail, :count)
      expect(response).to have_http_status(:not_found)
      expect(processed).to be_empty
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

    it "stores the mail and processes it through the routed mailbox (201)" do
      expect { post_inbound }.to change(ActionMailbox::InboundEmail, :count).by(1)

      expect(response).to have_http_status(:created)
      expect(response.parsed_body).to eq(
        "mailbox" => "FlowreelSeamSpecMailbox", "status" => "delivered", "messageId" => "in-1@example.test"
      )
      mail = processed.sole
      expect([mail.to, mail.from, mail.subject, mail.body.decoded]).to eq(
        [["help@example.test"], ["requester@example.test"], "Please quote", "Hello"]
      )
    end

    it "threads a raw reply by In-Reply-To and References" do
      post_inbound(mode: "raw", subject: "Re: Please quote", message_id: "<in-2@example.test>",
        in_reply_to: "<out-1@example.test>", references: ["<root@example.test>", "<out-1@example.test>"])

      expect(response).to have_http_status(:created)
      mail = processed.sole
      expect(mail.in_reply_to).to eq("out-1@example.test")
      expect(mail.references).to eq(["root@example.test", "out-1@example.test"])
    end

    it "422s not_routed for a support_address mail no mailbox takes" do
      allow(ApplicationMailbox.router).to receive(:mailbox_for).and_return(nil)
      post_inbound
      expect(response).to have_http_status(422)
      expect(response.parsed_body).to eq("outcome" => "not_routed")
      expect(processed).to be_empty
    end

    it "422s with the status when processing bounced the mail" do
      post_inbound(subject: "bounce me")
      expect(response).to have_http_status(422)
      expect(response.parsed_body).to include("mailbox" => "FlowreelSeamSpecMailbox", "status" => "bounced")
    end

    it "422s storage_duplicate for a repeated Message-ID" do
      post_inbound
      post_inbound
      expect(response).to have_http_status(422)
      expect(response.parsed_body).to eq("outcome" => "storage_duplicate")
    end

    it "422s invalid_env under a real queue adapter, before storing anything" do
      # Under a real adapter the RoutingJob that storage enqueues would run too (the drain that
      # discards it works only under :test), so the mailbox would process the mail twice.
      allow(ActiveJob::Base).to receive(:queue_adapter).and_return(ActiveJob::QueueAdapters::InlineAdapter.new)

      expect { post_inbound }.not_to change(ActionMailbox::InboundEmail, :count)
      expect(response).to have_http_status(422)
      expect(response.parsed_body).to include("outcome" => "invalid_env")
      expect(processed).to be_empty
    end

    it "refuses an unknown mode, and a missing to/from, before storing anything" do
      expect { post_inbound(mode: "smtp") }.not_to change(ActionMailbox::InboundEmail, :count)
      expect(response).to have_http_status(422)
      expect(response.parsed_body["outcome"]).to eq("invalid_params")

      post "/test/inbound_emails", params: {mode: "raw", from: "a@example.test"}, as: :json
      expect(response).to have_http_status(:bad_request)
    end

    describe "headers and attachments" do
      def file(content, filename: "note.txt", mime: "text/plain")
        {filename:, base64: Base64.strict_encode64(content), mime:}
      end

      it "sets an allowlisted header and attaches files" do
        post_inbound(headers: {"auto-submitted" => "auto-replied"}, attachments: [file("hello")])
        expect(response).to have_http_status(:created)
        mail = processed.sole
        expect(mail["Auto-Submitted"].value).to eq("auto-replied")
        expect(mail.attachments.map(&:filename)).to eq(["note.txt"])
        expect(mail.attachments.first.decoded).to eq("hello")
        expect(mail.text_part.decoded).to eq("Hello")
      end

      it "refuses a header outside the allowlist or with a line break" do
        [{"X-Evil" => "1"}, {"Precedence" => "bulk\r\nBcc: x@example.test"}].each do |headers|
          expect { post_inbound(headers:) }.not_to change(ActionMailbox::InboundEmail, :count)
          expect(response).to have_http_status(422)
          expect(response.parsed_body["outcome"]).to eq("invalid_params")
        end
      end

      it "refuses too many files, a type outside the allowlist, bad base64 and the malware test signature" do
        # The test signature's distinctive part, assembled here so it is never a literal.
        signature = "prefix #{%w[EICAR -STANDARD -ANTIVIRUS -TEST -FILE].join} suffix"
        cases = [
          Array.new(Test::InboundEmailsController::SEAM_ATTACHMENTS_MAX + 1) { file("x") },
          [file("x", filename: "a.exe", mime: "application/x-msdownload")],
          [{filename: "a.txt", base64: "not base64!", mime: "text/plain"}],
          [file(signature)]
        ]
        cases.each do |attachments|
          expect { post_inbound(attachments:) }.not_to change(ActionMailbox::InboundEmail, :count)
          expect(response).to have_http_status(422)
          expect(response.parsed_body["outcome"]).to eq("invalid_params")
        end
      end
    end
  end
end
