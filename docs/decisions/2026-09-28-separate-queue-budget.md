# Separate queue waiting from execution

Three QQ requests expired after only 387, 190 and 75 seconds of inference. On the Pi's single
worker, earlier requests took about eleven minutes, and the original 900-second deadline
started at submission. Waiting therefore consumed the later requests' analysis time.

Start the execution budget when a queued task actually begins. Default it to 1800 seconds,
and bound queue waiting independently with ORYN_QUEUE_BUDGET_SECONDS (default 1800). A timer
expires queued jobs even if all workers are busy, releases their pending slot, and returns an
explicit queue-timeout result without running the model. Cancellation clears the queue timer.

The admission response advertises the combined maximum duration. The QQ bridge follows it
with a 60-second delivery allowance. Existing clients that have their own shorter deadline
retain that client limit until upgraded or reconfigured. This does not add permanent memory,
increase Pi concurrency, or reduce the requested max reasoning variant.

Queue tests cover separate start timestamps, expiry while occupied and cancellation. A service
regression moves a queued task's creation time into the past and verifies it still gets a full
execution budget after admission. A targeted prompt also discourages exhaustive research for
feedback intake; missing implementation details belong in the issue's unknowns.
