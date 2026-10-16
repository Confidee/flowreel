# frozen_string_literal: true

# flowreel test seam: the mail the app sent, for the development stage.
#
#   GET    /test/mail_deliveries?after=<cursor>
#   DELETE /test/mail_deliveries            (clears the list; a local preflight only)
#
# The test environment's `delivery_method :test` collects every mail in
# ActionMailer::Base.deliveries, an in-process array the Playwright process
# cannot reach; this seam exposes it to flowreel's HttpSeamMailDriver.
#
# Cursor, not clock: deliveries only ever append (until DELETE clears them),
# so each entry carries its 1-based `index`, `?after=<n>` returns the entries
# with index > n, and `cursor` is the highest index (0 when empty), which the
# driver passes as the next `after`.
#
# Security posture (defense in depth):
#   1. Routed only in test/development (config/routes/flowreel_seams.rb).
#   2. Test::E2eSeamGate: 404 unless Rails.env.local? AND the seam flag.
#   3. It returns only what the app itself sent from this process.
class Test::MailDeliveriesController < ActionController::API
  include Test::E2eSeamGate

  MAX_DELIVERIES = 200

  # Returns: 200 { deliveries: [{index, messageId, from[], to[], cc[], replyTo[], subject, text,
  #                              inReplyTo, references[], headers{lower-cased: value}, deliveredAt}],
  #                cursor: <highest index> }
  #          at most the MAX_DELIVERIES most recent entries after the cursor
  def index
    deliveries = ActionMailer::Base.deliveries.dup
    after = params[:after].to_i
    entries = deliveries.each_with_index.filter_map { |mail, i| [mail, i + 1] if i + 1 > after }
    render json: {
      deliveries: entries.last(MAX_DELIVERIES).map { |mail, index| serialize(mail, index) },
      cursor: deliveries.size
    }
  end

  # Returns: 204
  def destroy
    ActionMailer::Base.deliveries.clear
    head :no_content
  end

  private

  # `from` keeps the display name ("Name <a@b>"); the recipient lists are bare addresses, which is
  # what the driver's `to:` matching compares.
  def serialize(mail, index)
    # The :test delivery method never serializes the message, so a mail that did not set its own
    # Message-ID / Date has none yet. Stamp them once (stable on later polls) the way a real SMTP
    # send would, so the driver can thread a reply onto it.
    mail.add_message_id if mail.message_id.blank?
    mail.add_date if mail.date.blank?

    {
      index:,
      messageId: bracketed(mail.message_id),
      from: Array(mail[:from]&.formatted),
      to: Array(mail.to),
      cc: Array(mail.cc),
      replyTo: Array(mail.reply_to),
      subject: utf8(mail.subject),
      text: text_of(mail),
      inReplyTo: Array(mail.in_reply_to).first&.then { |id| bracketed(id) },
      references: Array(mail.references).map { |id| bracketed(id) },
      headers: headers_of(mail),
      deliveredAt: mail.date&.iso8601
    }
  end

  # The text part, else the HTML part reduced to text.
  def text_of(mail)
    part = mail.multipart? ? (mail.text_part || mail.html_part) : mail
    return "" if part.nil?

    body = utf8(part.decoded)
    return body unless part.mime_type == "text/html"

    Nokogiri::HTML5.fragment(body).text.gsub(/[ \t]*\n\s*/, "\n").strip
  end

  # Lower-cased names; a repeated header (Received, …) is joined with ", ".
  def headers_of(mail)
    mail.header.fields.each_with_object({}) do |field, headers|
      name = field.name.to_s.downcase
      value = utf8(field.value)
      headers[name] = headers.key?(name) ? "#{headers[name]}, #{value}" : value
    end
  end

  def bracketed(id)
    return nil if id.blank?

    id.to_s.start_with?("<") ? id.to_s : "<#{id}>"
  end

  def utf8(value)
    value.to_s.dup.force_encoding(Encoding::UTF_8).scrub
  end
end
