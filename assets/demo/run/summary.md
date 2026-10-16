# Confidee demo app loc-20261016-1953-7072: PASS

**Verdict:** PASS. 1 tour feature(s) verified.

| | |
|---|---|
| Target | local |
| Git SHA | unknown |
| Started | 2026-10-16T19:53:06.461Z |
| Finished | 2026-10-16T19:53:18.769Z |
| Video | [tasks-tour-loc-20261016-1953-7072.mp4](tasks-tour-loc-20261016-1953-7072.mp4) (53.1s) |
| Pace | demo (slow factor 1.5) |
| Narration | Ava (Premium) (12 lines, 0 synthesized, 12 cached) |

## Tour features

Tour video: [tasks-tour-loc-20261016-1953-7072.mp4](tasks-tour-loc-20261016-1953-7072.mp4) (53.1s). Areas: [A](tour-a-loc-20261016-1953-7072.mp4).

| Feature | Title | Area | Status | Duration | Video at | Note |
|---|---|---|---|---|---|---|
| A1 | plan-a-task | A | passed | 11.6s | 0:08 |  |

## tour-setup: tour setup (passed, 0.0s)

| Step | Status | Duration | Facts |
|---|---|---|---|
| S1 every persona is signed in as itself | passed | 0.0s |  |

## tour-a: A1 plan-a-task (passed, 11.6s)

| Step | Status | Duration | Facts |
|---|---|---|---|
| A1.1 Maya opens her task list | passed | 2.5s |  |
| A1.2 She adds a task with a due date | passed | 4.5s |  |
| A1.3 The task appears in her open list | passed | 1.8s |  |
| A1.4 She marks it as done | passed | 0.7s |  |
| A1.5 It moves to Completed | passed | 1.8s |  |

## Hop latencies

- none recorded

## Could not check

- nothing

## Evidence

- HTML report: `flowreel-results/loc-20261016-1953-7072/report/index.html`
- tour-setup: tour setup, trace: [test-results/setup-tour-setup-tour-setup/trace.zip](test-results/setup-tour-setup-tour-setup/trace.zip)
- tour-a: A1 plan-a-task, screenshot: [test-results/a1-plan-a-task-A1-plan-a-task-tour-a/test-finished-1.png](test-results/a1-plan-a-task-A1-plan-a-task-tour-a/test-finished-1.png)
- tour-a: A1 plan-a-task, video: [test-results/a1-plan-a-task-A1-plan-a-task-tour-a/video.webm](test-results/a1-plan-a-task-A1-plan-a-task-tour-a/video.webm)
- tour-a: A1 plan-a-task, trace: [test-results/a1-plan-a-task-A1-plan-a-task-tour-a/trace.zip](test-results/a1-plan-a-task-A1-plan-a-task-tour-a/trace.zip)

Open a trace with `npx playwright show-trace <path>`.

## Configuration (redacted)

```json
{
  "target": "local",
  "baseURL": "http://127.0.0.1:3181",
  "module": "tasks-tour",
  "personas": {
    "member": "maya@example.test"
  }
}
```
