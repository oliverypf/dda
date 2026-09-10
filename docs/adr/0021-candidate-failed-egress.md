# Candidate invocation failure accounting

Candidate selection must not determine whether an outbound invocation is audited.
Draft outcomes are recorded before checking selection success. Continuous verifier
invocations report one bounded completion fact for each attempted provider call,
including FAILED or CANCELLED outcomes and latency. Facts contain prompt digests,
candidate identities and fixed failure codes, never raw errors, prompts or outputs.
Successful probability samples remain separate evidence; failed calls cannot
manufacture scores. Unknown provider billing remains unknown, never inferred zero.
