# frozen_string_literal: true

# flowreel test seam: POST /test/perform_enqueued_jobs
#
# The development stage's server runs RAILS_ENV=test, whose ActiveJob adapter
# is the in-memory :test adapter with no worker: every `deliver_later` and
# `perform_later` just sits in `enqueued_jobs`, so nothing is ever delivered.
# flowreel's HttpSeamMailDriver calls this after each send/reply and before
# each mailbox poll to run what is ready.
#
# Rules:
#   * up to MAX_PASSES passes, each taking the jobs enqueued so far, until a pass
#     finds nothing ready (jobs enqueue more jobs);
#   * ActionMailbox::RoutingJob entries are DISCARDED: the inbound seam routes
#     by hand, so running them would process the same mail twice;
#   * a job scheduled for the future (`set(wait:)`, a retry back-off) stays
#     queued: running it now would fire it early, and a failing retry would
#     loop every pass;
#   * a raising job is recorded in `errors` and the drain carries on.
# The adapter itself is never changed (it stays :test for every other caller).
#
# Security posture (defense in depth):
#   1. Routed only in test/development (config/routes/flowreel_seams.rb).
#   2. Test::E2eSeamGate: 404 unless Rails.env.local? AND the seam flag.
class Test::EnqueuedJobsController < ActionController::API
  include Test::E2eSeamGate

  MAX_PASSES = 10
  DRAIN_LOCK = Mutex.new

  # Returns: 200 { performed: n, discarded: n, deferred: n, deferredJobs: [name], errors: [{job, error}] }
  #          422 { error } when the queue adapter is not the :test adapter (e.g. development)
  def create
    adapter = ActiveJob::Base.queue_adapter
    unless adapter.is_a?(ActiveJob::QueueAdapters::TestAdapter)
      return render json: {error: "queue adapter is #{adapter.class.name}, not :test"}, status: 422
    end

    render json: DRAIN_LOCK.synchronize { drain(adapter.enqueued_jobs) }
  end

  private

  def drain(queue)
    result = {performed: 0, discarded: 0, deferred: 0, deferredJobs: [], errors: []}

    MAX_PASSES.times do
      # slice! takes exactly the entries present now; a job enqueued concurrently is appended
      # after them and left for the next pass (never lost).
      batch = queue.slice!(0, queue.length)
      deferred, ready = batch.partition { |job| scheduled_later?(job) }
      queue.concat(deferred)
      result[:deferred] = deferred.size
      result[:deferredJobs] = deferred.map { |job| job_name(job) }
      break if ready.empty?

      ready.each { |job| perform(job, result) }
    end

    result
  end

  def perform(job, result)
    if routing_job?(job)
      result[:discarded] += 1
      return
    end

    # A worker starts each job from clean CurrentAttributes, not the request's (what the Rails
    # executor does between units of work; the request already runs inside one, so the job's own
    # executor wrap does not).
    ActiveSupport::CurrentAttributes.clear_all
    ActiveJob::Base.execute(job.except(:job, :args, :queue, :priority, :at))
    result[:performed] += 1
  rescue StandardError => error
    result[:errors] << {job: job["job_class"], error: "#{error.class}: #{error.message}"}
  end

  def routing_job?(job)
    defined?(ActionMailbox::RoutingJob) && job[:job] == ActionMailbox::RoutingJob
  end

  # "ActionMailer::MailDeliveryJob(SomeMailer#action)" for a mailer job (its first two
  # serialized arguments are the mailer and action names), else the job class.
  def job_name(job)
    name = job["job_class"].to_s
    mailer, action = job["arguments"]
    return name unless job[:job].is_a?(Class) && job[:job] <= ActionMailer::MailDeliveryJob
    return name unless mailer.is_a?(String) && action.is_a?(String)

    "#{name}(#{mailer}##{action})"
  end

  def scheduled_later?(job)
    job[:at].present? && job[:at].to_f > Time.now.to_f
  end
end
