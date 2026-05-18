# Selector And Fingerprint Maintenance Guide

## When To Update

Update selector packs or fingerprints when canaries report selector mismatch, page fingerprint mismatch, form schema drift, confirmation ambiguity, or provider UI changes observed during dry-run/replay.

## Required Steps

1. Reproduce the failure with replay artifacts where possible.
2. Add or update fixture HTML/metadata that captures the changed page state.
3. Version the selector pack and page fingerprint together.
4. Run dry-run boundary tests and canary tests for the affected provider.
5. Confirm no flow can submit, send, or confirm while in replay.
6. Record the change in provider playbook notes or release evidence if it affects rollout.

## Rollback

If updated selectors fail in production-like canary, disable the provider or downgrade it to `read_only`, restore the previous selector pack, and keep the failed artifact for analysis.
