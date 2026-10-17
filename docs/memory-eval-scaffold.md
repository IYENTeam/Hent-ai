# Memory Evaluation Scaffold

This is the deferred design/evaluation scaffold for the broader ConversationRuntime memory work identified during ULW research. It is not an accepted runtime redesign and must not be implemented piecemeal without a new owner-approved architecture decision.

## Target Service Split

- `ConversationIntakeService`: normalize host events, persist raw events, deduplicate by host message id, and retain source/target thread metadata.
- `ConversationEvaluationService`: build memory windows, run anti-fixation/memory policy, emit auditable signals, and avoid delivery side effects.
- `ConversationDeliveryService`: turn allowed signals into delivery plans, enforce cooldown/budget gates, and commit delivery ledgers.
- `ConversationMemoryStore`: own memory tiers, decay, summarization, and retrieval scoring independent of host adapters.

## Candidate Evaluation Cases

- Repeated assistant self-message burst in one Discord channel should evaluate each assistant message id without channel-key overwrites.
- Cooldown and delivery-ledger behavior should prevent duplicate nudges after one committed plan.
- Cross-thread scope handling should preserve `scopeId`, `sourceThreadId`, and `targetThreadId` in evaluation inputs.
- Privacy and cross-thread risk flags should be carried into policy audits before delivery.
- Memory decay should demote stale repetitions while preserving recent high-risk fixation examples.
- Summaries should be reversible to raw-event ids for audit, not treated as a new source of truth.

## Required Before Implementation

- Golden watcher fixtures with raw events, expected signals, delivery plan, and ledger result.
- A migration or retention decision for existing watcher state.
- Memory-tier eval fixtures: raw window, short-term memory, decayed memory, expected retrieval set, and expected no-reply/nudge decision.
- Explicit privacy rules for cross-thread retrieval and summarization.
- Release-gate inclusion for any new memory behavior before it becomes canonical.
