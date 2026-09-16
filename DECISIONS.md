# Decisions

Assumptions, tradeoffs, deliberate omissions and next steps. The README covers *what* was built and
how to run it; this covers *why*, and what I chose not to do.

## Time box

**Roughly one working day**, taken in two passes: a core pass covering the brief's required outcome
and all six non-negotiables, then an extensions pass covering four of the six optional creative
directions. The brief invites any time box and says explicitly that more time earns no points, so
the goal was a coherent slice with evidence behind it rather than breadth.

## Assumptions

| # | Assumption | Why, and what it would cost to be wrong |
| --- | --- | --- |
| 1 | A **company is the tenant boundary**, and a user may belong to more than one. | The guide states it. It is why every store method is company-scoped *by signature* rather than by convention — there is no API that returns a row without being told who is asking. |
| 2 | The **server is authoritative** for business facts; the device is authoritative for user intent. | When they disagree about whether a record exists, the server wins. When they disagree about what the user meant — a late OCR read versus a human correction — the human wins. This split is why provenance is tracked per field rather than per record. |
| 3 | A **transaction holds at most one receipt.** | Without it, "two receipts matched to the same transaction" has no defined answer. A real system might allow split receipts against one transaction; that would change the data model, not just the guard. |
| 4 | `transaction_date` is a **calendar date with no timezone**; `occurred_at` is an absolute instant. | These are different kinds of value. Conflating them is how a 1 January receipt becomes 31 December for a user in UTC-5. They are separate types and are never silently converted. |
| 5 | Money is **integer minor units plus an ISO-4217 code**, always together. | An amount without a currency is not a value, it is a number. The exponent is a property of the currency, not the amount — which is why JPY has no decimals and BHD has three. |
| 6 | An **idempotency key identifies one logical submission**, not one request. | It is stable across retries and rotates only when the *substance* of the submission changes. Getting this backwards in either direction is a real bug: never rotating discards the user's correction silently; always rotating creates duplicates. |
| 7 | Reviewers run on a **simulator with no developer account**, and no backend to configure. | Everything is in-process and seeded. There is no base URL, no key, and no hosted service to go down during a review. |

## Tradeoffs

**An in-process fake server, not a real API.** The brief and the guide both accept a reproducible
local fake, and a deterministic one is more discussable than a flaky hosted demo. The cost is real
and stated in the README: this proves the client's response to each *class* of server outcome, and
proves nothing about TLS, latency, or a real HTTP stack. The seam is deliberate — `SyncEngine`
consumes an interface, so a real HTTP adapter would slot in without touching the engine, the
idempotency logic, or the company guard.

**Local notifications, not remote push.** Remote push needs a push service, a token registry and a
reachable server. What is implemented demonstrates permission timing, deep-link validation, collapse
keys and lock-screen privacy. What it cannot demonstrate is the case that matters most in
production — a completion arriving while the app is dead — which is exactly why a
reconciliation-on-launch pass is on the next-steps list rather than claimed as done.

**Real barcode formats rather than a fake decoder.** GS1-128 Application Identifiers and
base64/TLV fiscal-invoice QR are public, fully specified and deterministic, so they are testable to
the same standard as a fake while being genuinely correct. The cost is a larger surface to get
right — notably that a payload's declared decimal count can disagree with the currency's own
exponent, which the decoder refuses rather than silently scaling.

**SQLite over a key/value store.** The offline queue needs an indexed `(company, state)` query on
every wake-up and atomic partial updates. A blob store gives neither.

**A thin UI over thick pure logic.** Screens are deliberately dumb; the interesting rules live in
pure modules that take their clock and randomness as parameters. That is what makes 1041 tests fast
and deterministic, and it is why there are few component tests — the logic a component test would
cover has been moved somewhere it can be tested properly.

**Foreground-only uploads.** Honest weak point. Idempotency makes an interrupted upload safe, but
not *good*.

## Deliberate omissions

- **Web review console** — the one creative direction not taken. It is mostly new UI rather than new
  behaviour, and the local/remote distinction is already visible from the device side.
- **Resumable / chunked upload and pre-signed URLs** — the production shape is described in the
  README's "file transfer versus business-record creation"; implementing it against a fake would
  demonstrate the plumbing, not the risk.
- **True OS background transfer** — `URLSession` background sessions and `WorkManager` are genuinely
  different models and would change the state machine, not decorate it. See next steps.
- **Conflict handling across two devices** — needs a server that can express a conflict.
- **Detox / E2E** — the highest-value path is named below.
- **Telemetry, crash reporting, staged builds** — operationally important, not informative here.
- **Image purge on sign-out** — tokens are destroyed on logout; receipt images are not. A production
  build should purge them, and it is a small change I ran out of box for.

## Next steps, in order

1. **Real background upload**, because it is the only gap that changes the state machine rather than
   decorating it. A transfer that outlives the process makes reconciliation-on-launch mandatory.
2. **A `GET /receipts?since=` reconciliation endpoint**, so a client that missed responses can
   resynchronise instead of retrying blind. This is also what makes the lost-response path
   self-healing rather than merely safe.
3. **Detox coverage of offline → switch company → back**, the sequence most likely to regress and
   the one whose failure would be a data-isolation bug rather than a cosmetic one.
4. **Compound the two confidence axes** — a badly-read receipt can currently produce a confident
   match from bad fields. Low OCR confidence *and* a weak match should force review together; that
   belongs in a layer owning both signals.
5. **Purge receipt images on sign-out**, and revisit certificate pinning and a jailbreak/root posture.

## What I would leave alone

The domain layer. Money, dates, the state machine and the provenance ladder are small, pure, and
carry the invariants the brief actually cares about. Every defect found late in this build was in
the layers *around* them — a form stamping the wrong provenance, a session that never validated its
own expiry, a crop rect clamping out of bounds. That is the shape I would want it to keep.
