# Decisions

Assumptions, tradeoffs, deliberate omissions and next steps. The README covers *what* was built and
how to run it; this covers *why*, and what I chose not to do.

## Time box

**Roughly one working day**, taken in two passes: a core pass covering the brief's required outcome
and all six non-negotiables, then an extensions pass covering five of the six optional creative
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
pure modules that take their clock and randomness as parameters. That is what makes 1057 tests fast
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

## Adding real extraction: the options

The brief did not require a real OCR provider, and the deterministic fake is what makes every
failure path triggerable on demand. If it were to become real, the important thing is that **this is
two problems, not one**, and most of the difficulty is in the second.

**1. Text recognition** — pixels to lines of text. Solved, on-device, free, fast.
**2. Receipt understanding** — turning `MARKET BASKET … TOTAL 29.49 … 1/31/26` into a vendor, a
total and a date. This is the hard half: every chain formats differently, totals sit next to
subtotals and tendered amounts, and dates appear in several formats on the same paper.

### On-device text recognition

All of these use Apple Vision on iOS and Google ML Kit on Android, run offline, cost nothing per
scan, and keep the image on the device. All of them require a development build — none work in Expo
Go — and ML Kit pushes the iOS deployment target to 16.0.

| Option | Notes |
| --- | --- |
| [`expo-text-extractor`](https://github.com/pchalupa/expo-text-extractor) | Expo module, SDK 52+, config plugin. Closest fit to this project |
| [`expo-mlkit-ocr`](https://www.npmjs.com/package/expo-mlkit-ocr) | ML Kit Text Recognition v2, both platforms |
| [`react-native-nitro-ocr`](https://github.com/jonathanpalma/react-native-nitro-ocr/) | Bundles the models rather than fetching them from Play Services, so it still works offline and on devices without GMS — which matters for a brief whose premise is poor connectivity |
| [`react-native-vision-camera-mlkit`](https://github.com/pedrol2b/react-native-vision-camera-mlkit) and similar frame-processor plugins | Real-time recognition in the viewfinder. Only worth it for live capture; overkill for a still photo |

### Cloud, and receipt-specific services

These solve both problems at once, returning structured fields rather than raw text.

| Option | Notes |
| --- | --- |
| AWS Textract `AnalyzeExpense` | Reported around 93% field-level accuracy; expense-shaped output |
| Google Document AI expense parser | Comparable field accuracy |
| [Veryfi](https://www.veryfi.com/receipt-ocr-api/), Mindee, Taggun | Receipt-specialised, many fields, line items |

### What I would actually do, and why

**On-device first.** Three reasons, in order of weight for this product:

1. **It matches the premise.** The whole brief is an employee with unreliable connectivity. An
   extraction step that requires a network call contradicts the scenario it is meant to serve, and
   would leave the queue holding receipts that cannot even be read until the user is back online.
2. **Receipts are financial documents.** Shipping them to a third party is a data-processing
   decision with compliance weight, not a library choice. It needs an answer about retention and
   sub-processors before it needs an API key.
3. **Cost and latency.** Per-document pricing on a high-volume expense app adds up, and on-device
   recognition is effectively instant.

**Then my own parser**, structurally similar to the GS1 decoder already in `src/domain/barcode.ts`:
pure, deterministic, unit-testable against fixture text. Totals are found by keyword proximity
rather than position; the vendor is usually the largest text in the top block; dates are matched
against a small set of formats. Confidence falls out of how many of those agree.

**A cloud fallback only for low confidence** — the small fraction the on-device path cannot read
well — if the privacy question above has been answered.

### It drops into the existing seam

`extractFromReceipt` is already a pure function behind the same port as everything else, so real
extraction is a signature change from `(storageKey: string)` to `(bytes: Uint8Array)` and a new
adapter. Nothing in the state machine, the provenance ladder or the sync engine would move — the
provenance ladder in particular already answers the question real OCR creates, which is what happens
when a late reading disagrees with a human. That was the point of building it before the extraction
was real.

## What I would leave alone

The domain layer. Money, dates, the state machine and the provenance ladder are small, pure, and
carry the invariants the brief actually cares about. Every defect found late in this build was in
the layers *around* them — a form stamping the wrong provenance, a session that never validated its
own expiry, a crop rect clamping out of bounds. That is the shape I would want it to keep.
