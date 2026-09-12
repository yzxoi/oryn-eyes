# Concise QQ replies with diagnostic references

## Context

The initial acknowledgement repeated workflow explanations and the progress message added noise. Users need one clear receipt, one conclusion, and a reference that connects both to troubleshooting logs.

## Decision

Generate a short random reference in the AstrBot bridge before any screenshot download or service call. Send a concise receipt and append the same reference to every terminal reply. Remove periodic progress replies, while retaining internal progress logs and explicit stop-command responses.

Log the reference-to-job mapping when submission succeeds; pre-submission failures remain traceable through bridge logs alone. This avoids delaying the acknowledgement until a backend ID exists or changing the service API solely for presentation. The reference is not given to the model, added to short-term conversational context, or published to GitHub. It is a diagnostic reference, not an authorization token.

## Validation

Plugin tests advance time beyond the former progress threshold and assert exactly two delivered replies with one reference. They cover backend completion, failure, cancellation, timeout, unavailable backend and image download failure, including log-to-job correlation and AstrBot event stop ordering.
