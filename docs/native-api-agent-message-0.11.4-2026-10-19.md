# Native API agent-message wire repair 0.11.4 (2026-10-19)

## Installed 0.11.3 result

The 0.11.3 package was installed and explicitly applied once. Catalog readiness and root/profile isolation passed. After restart, the host created the one authorized API child (`01a152b0-8bd0-78c0-a22b-cf34c1f45fe5`) for task `deepseek_api_minimal_acceptance_0113`, with provider `api-native-b313e8db39e5df95adabdf63`, model `deepseek-flash`, and configured reasoning effort `high`. The task reached the child as a native `agent_message`, but the child returned a generic English prompt and made no tool calls; task execution did not pass. Do not infer that `high` was ineffective from this result.

The child rollout contains one usage record: 187,226 input tokens (3,456 cached), 187 output tokens (including 115 reasoning tokens), 187,413 total. A usage record does not establish the number of HTTP requests. The rollout has a reasoning item, but its contents are not copied here; the user-facing UI did not show thinking. No reasoning text or extra delay is fabricated. The one-time API authorization has been consumed; do not retry without fresh authorization.

## 0.11.4 local correction

The native API gateway was serializing `agent_message` as-is for Responses providers. It now maps that item at the API gateway boundary to the standard Responses form `{"type":"message","role":"user","content":...}`. Content blocks and order are preserved, including multimodal blocks. Other ordinary input items pass through unchanged. An encrypted or malformed `agent_message` fails explicitly instead of being dropped. The official DeepSeek Responses path then applies its existing provider-specific normalization; Chat Completions conversion is unchanged.

Local loopback tests captured the actual outgoing request body and checked text/multimodal content, generic and official DeepSeek paths, unknown input preservation, explicit encrypted-message rejection, response tool/usage mapping, and streaming progress event passthrough. No real API request was made for this correction. It has not yet been installed or tested with a newly authorized real child, so `apiVerified` remains false and task execution remains unverified.

The legacy native DeepSeek gateway, relay, routing, and isolated-config files are unchanged from the prior source baseline. A free gateway-to-mock-upstream regression now confirms that its plain `agent_message` still reaches DeepSeek as one user message with the task text preserved, with no relay use. The repository's 0.10.5 acceptance record includes successful full child interactions, but that version's overall result remained partial; the currently installed 48d runtime was not separately exercised on this legacy path during this correction.

## Updating the active gateway source

An already active API journal pins its staged source bundle. Ordinary active-profile Apply repairs managed profile artifacts but does not replace that source. The existing owned maintenance path is rollback, prepare with the same profile ID and audited plugin root, then activate; it retains the canonical journal through the rollback receipt, re-stages the bundle with its new digest, and updates the owned task/launcher while preserving gateway identity, port, and token. This repair adds no installer or migration behavior. Do not refresh a running source through ordinary routing or active Apply.
