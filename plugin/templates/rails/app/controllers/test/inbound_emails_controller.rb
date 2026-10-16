# frozen_string_literal: true

require "mail"

# flowreel test seam: POST /test/inbound_emails
#
# Delivers an inbound mail to the app's REAL ActionMailbox pipeline (storage,
# the real router, the chosen mailbox), so the development stage can send the
# mail a person would, without DNS or an inbound-mail provider. flowreel's
# HttpSeamMailDriver sends JSON, never raw MIME: the seam builds the message.
#
# Body (JSON):
#   mode         "support_address": a fresh mail to one of the app's inbound
#                addresses (422 not_routed when no mailbox takes it);
#                "raw": any inbound mail, typically a reply to an address taken
#                from a delivered mail's Reply-To.
#   to, from     required
#   subject, body
#   message_id   the client's own, angle brackets included (so it can follow
#                the thread); a fresh one when absent
#   in_reply_to, references (array or space-separated)
#   headers      optional {name => value}: names from SEAM_HEADERS only, values
#                ≤ SEAM_HEADER_VALUE_MAX characters with no line breaks
#   attachments  optional [{filename, base64, mime}]: at most SEAM_ATTACHMENTS_MAX,
#                each ≤ SEAM_ATTACHMENT_BYTES_MAX decoded, mime from
#                SEAM_ATTACHMENT_MIMES; a file carrying the industry anti-malware
#                test signature is refused (built from parts below, so the
#                signature itself is never a literal in your repository)
#
# Returns: 201 {mailbox, status, messageId}: stored and processed
#          422 {outcome, reason} or {mailbox, status, messageId}: not captured
#              (not routed, a storage duplicate, refused extras, a bounced or
#              failed processing); nothing is retried by the client
#          422 {outcome: "invalid_env", reason} when the queue adapter is not the
#              :test adapter (e.g. development): nothing is stored
#          400 when `to` or `from` is missing
#
# The mailbox runs inline here; anything it enqueues (a job, deliver_later)
# runs when the client drains the queue (POST /test/perform_enqueued_jobs),
# which also discards the RoutingJob that storage enqueues. That discard only
# exists under the :test adapter: under a real adapter (async, solid_queue,
# sidekiq) the RoutingJob would run as well and the mailbox would process the
# mail a second time. So this seam refuses, as the drain does, unless the
# adapter is :test.
#
# Security posture (defense in depth):
#   1. Routed only in test/development (config/routes/flowreel_seams.rb).
#   2. Test::E2eSeamGate: 404 unless Rails.env.local? AND the seam flag.
#   3. It skips no check of the inbound pipeline: the mail goes through the
#      same router and mailboxes a real inbound POST would reach.
class Test::InboundEmailsController < ActionController::API
  include Test::E2eSeamGate

  MODES = %w[support_address raw].freeze
  FAILED_STATUSES = %w[bounced failed].freeze

  # TODO(flowreel): narrow these to what your flows need.
  SEAM_HEADERS = %w[Auto-Submitted Precedence X-Auto-Response-Suppress].freeze
  SEAM_HEADER_VALUE_MAX = 200
  SEAM_ATTACHMENTS_MAX = 3
  SEAM_ATTACHMENT_BYTES_MAX = 1.megabyte
  # Base64 of SEAM_ATTACHMENT_BYTES_MAX bytes: 4 characters per 3 bytes, padded.
  SEAM_ATTACHMENT_BASE64_MAX = (SEAM_ATTACHMENT_BYTES_MAX / 3.0).ceil * 4
  SEAM_ATTACHMENT_MIMES = %w[text/plain image/png application/pdf].freeze
  # The distinctive part of the anti-malware test file's text, assembled at load time.
  TEST_SIGNATURE_MARK = %w[EICAR -STANDARD -ANTIVIRUS -TEST -FILE].join.freeze

  # A refused `mode`, `headers` or `attachments` param: 422 before anything is stored.
  class InvalidParams < StandardError; end

  rescue_from InvalidParams do |error|
    render json: {outcome: "invalid_params", reason: error.message}, status: 422
  end

  def create
    adapter = ActiveJob::Base.queue_adapter
    unless adapter.is_a?(ActiveJob::QueueAdapters::TestAdapter)
      return render(json: {outcome: "invalid_env", reason: "queue adapter is #{adapter.class.name}, not :test"}, status: 422)
    end

    mode = params[:mode].to_s
    raise InvalidParams, "mode must be one of #{MODES.join(", ")}" unless MODES.include?(mode)

    inbound = ActionMailbox::InboundEmail.create_and_extract_message_id!(build_mail.to_s)
    return render(json: {outcome: "storage_duplicate"}, status: 422) if inbound.nil?

    mailbox = ApplicationMailbox.router.mailbox_for(inbound)
    if mode == "support_address" && mailbox.nil?
      return render(json: {outcome: "not_routed"}, status: 422)
    end

    route(inbound)
    render_result(inbound.reload, mailbox)
  end

  private

  def build_mail
    to = params.require(:to)
    from = params.require(:from)
    extra_headers = seam_headers
    files = seam_attachments
    text = params[:body].to_s

    mail = Mail.new
    mail.to = to
    mail.from = from
    mail.subject = params[:subject].to_s
    if files.any?
      mail.text_part = Mail::Part.new(content_type: "text/plain; charset=UTF-8", body: text)
      files.each { |file| mail.attachments[file[:filename]] = {mime_type: file[:mime], content: file[:bytes]} }
    else
      mail.body = text
    end
    mail.message_id = params[:message_id].presence || "<flowreel-#{SecureRandom.uuid}@inbound.invalid>"
    mail.in_reply_to = params[:in_reply_to] if params[:in_reply_to].present?
    references = Array(params[:references]).flat_map { |ref| ref.to_s.split }.compact_blank
    mail.references = references.join(" ") if references.any?
    extra_headers.each { |name, value| mail[name] = value }
    mail
  end

  # Processes inline through the real router. A routing or processing error leaves its mark on
  # the inbound email's status (bounced / failed), which the response reports.
  def route(inbound)
    inbound.route
  rescue StandardError => error
    Rails.logger.warn("[Test::InboundEmails] routing raised #{error.class}: #{error.message}")
  end

  # TODO(flowreel): add what your flows need to find the result (for example the id of the record
  # the mail created), read from your own models. Never return another user's data.
  def render_result(inbound, mailbox)
    body = {mailbox: mailbox&.name, status: inbound.status, messageId: inbound.message_id}
    status = FAILED_STATUSES.include?(inbound.status) ? 422 : :created
    render json: body, status:
  end

  def seam_headers
    raw = params[:headers]
    return {} if raw.blank?
    raise InvalidParams, "headers must be an object" unless raw.respond_to?(:to_unsafe_h)

    # Every key is checked against SEAM_HEADERS below, so nothing unlisted reaches the mail.
    raw.to_unsafe_h.to_h do |name, value|
      canonical = SEAM_HEADERS.find { |allowed| allowed.casecmp?(name.to_s) }
      raise InvalidParams, "header #{name.to_s.first(40)} is not allowed (#{SEAM_HEADERS.join(", ")})" if canonical.nil?

      text = value.to_s
      raise InvalidParams, "header #{canonical} has an invalid value" if text.blank? || text.length > SEAM_HEADER_VALUE_MAX || text.match?(/[\r\n]/)

      [canonical, text]
    end
  end

  def seam_attachments
    list = params[:attachments]
    return [] if list.blank?
    raise InvalidParams, "attachments must be a list" unless list.is_a?(Array)
    raise InvalidParams, "at most #{SEAM_ATTACHMENTS_MAX} attachments" if list.size > SEAM_ATTACHMENTS_MAX

    list.map do |raw|
      raise InvalidParams, "an attachment must be an object" unless raw.respond_to?(:permit)

      entry = raw.permit(:filename, :base64, :mime)
      filename = File.basename(entry[:filename].to_s)
      raise InvalidParams, "an attachment needs a filename" if filename.blank? || filename.length > 120

      mime = entry[:mime].presence || "text/plain"
      unless SEAM_ATTACHMENT_MIMES.include?(mime)
        raise InvalidParams, "#{filename}: mime #{mime.to_s.first(60)} is not allowed (#{SEAM_ATTACHMENT_MIMES.join(", ")})"
      end

      encoded = entry[:base64].to_s
      raise InvalidParams, "#{filename} is larger than the limit" if encoded.bytesize > SEAM_ATTACHMENT_BASE64_MAX

      bytes = Base64.strict_decode64(encoded)
      raise InvalidParams, "#{filename} is larger than the limit" if bytes.bytesize > SEAM_ATTACHMENT_BYTES_MAX
      raise InvalidParams, "#{filename} carries a malware test signature" if bytes.b.include?(TEST_SIGNATURE_MARK.b)

      {filename:, mime:, bytes:}
    rescue ArgumentError
      raise InvalidParams, "#{filename} is not valid base64"
    end
  end
end
