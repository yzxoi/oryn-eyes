# Correct unavailable screenshot references before publication

A text-only feedback replay finished inference but failed at publication because the model
invented a screenshot ID. The publisher correctly refused to attach an unavailable image,
but its late rejection bypassed the worker's existing report-correction loop.

Validate screenshot IDs against the actual worker inputs before accepting a report. A mismatch
uses the existing bounded correction attempts in the same Core session and task budget, with
the allowed IDs in the error. The initial prompt also lists those IDs. Keep the publisher's
independent check: correction is not permission to publish missing or invented evidence.

The native Core smoke fixture can emit an invalid screenshot reference after reading source
and fetching evidence. It asserts that Core receives the correction and completes with a
valid result. This fixture is local-only and performs no GitHub writes.
