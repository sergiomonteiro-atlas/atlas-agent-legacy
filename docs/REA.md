# REA findings — Atlas-Agent 0.1

The official `morluto/rea` source and its `reverse-engineer-anything` skill were read during the ecosystem investigation. The skill distinguishes complete-source architecture inspection from artifact/runtime analysis. This repository uses its question → source evidence → inference → verification ledger; the ecosystem blueprint retains the official CLI analysis of the reference app. Reading source is not evidence of runtime execution.

| Question | Observed source | Atlas synthesis | Remaining boundary |
| --- | --- | --- | --- |
| How are agent tools and model messages coordinated? | `NousResearch/hermes-agent`, commit `60f81635c28e825a233f7bb25ed93a2579d5b547`: `agent/agent_runtime_helpers.py` imports dedicated message sanitation, tool dispatch, retry and cache helpers | Modular provider, tool dispatch and bounded builder loop; separate skeptic closes tasks | No claim to match Hermes scheduling, learning, TUI or sandbox backends |
| What should Soul contain? | `openclaw/openclaw`, commit `1b62c4db9045ae3e353074eacbce4fba61a12d93`: `docs/concepts/soul.md` separates personality/voice from operational instructions | Dynamic `<slug>.soul.md` identity plus specialist Markdown and optional skills | Identity files are trusted operator policy, not a permission sandbox |
| Are keyword and semantic retrieval interchangeable? | `garrytan/gbrain`, commit `747dc24cc17608968aa34cf425129773ced4547b`: README describes keyless keyword retrieval separately from configured embeddings/synthesis; notes cloud text boundaries | Keyless lexical search and explicit real embedding adapter with cosine similarity | No GBrain database or citation/synthesis parity; embeddings are not persisted |
| Does OpenBot imply free Grok access? | `CopilotKit/OpenBot`, commit `6c9d261448140a98406c4de80d02fdec2e25658c`: README describes modular coworker workspace, selectable model infrastructure and AG-UI | New CLI mention router and explicit channel adapter interfaces | OpenBot and Grok Bot are distinct products; no Grok integration or free access is claimed |
| What is the transferable agent catalog contract? | `GoWorld-Digital/agency-agents`: `divisions.json`, `tools.json`, Markdown frontmatter (`name`,`description`,`color`) | Vault graph retains frontmatter and division; runtime resolves specialist by unique slug | Conversion output is owned by `atlas-workforce`, not replicated here |

No upstream runtime source was copied into Atlas-Agent. Names identify architectural inspiration. Tests use explicit queued model responses only inside test fixtures; production providers either call a real configured API or fail.

## Investigation checklist

- [x] Define graph, event and identity boundaries with ecosystem blueprint.
- [x] Inspect upstream source and distinguish observations from design decisions.
- [x] Build runnable local index, CLI, provider, critic loop and authenticated telemetry.
- [x] Add adversarial tests for boundary failures and false critic completion.
- [ ] Verify with real model credentials, embedding account and live Telegram/WhatsApp accounts (not supplied to this implementation).
- [ ] Benchmark large Vault incremental indexing and persistent vectors.
