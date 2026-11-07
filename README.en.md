# Carlos Flow — Unified Distribution (Cindy / OpenCode / Cursor / Cline / VS Code / Claude Desktop)

> **Mechanical Gate Framework for AI Coding Agents**: Trace → Dispatch → Verify → Verdict → Audit → Revert  
> **Turn "Trust the Agent" into "Verify the Agent"** — Machine-level scope limits, real command execution, tamper-proof audit chains, controlled bypass, honest dispatch quotas, independent review, snapshot restore.

**Languages:** [中文](README.zh.md) | [English](README.en.md)  
**Version:** 2.5.9 | **License:** MIT | **CI:** passing | **Node.js:** 22+ | **MCP:** 1.29+  
**Package:** `carlos-flow` (single package, replaces `carlos-flow-cindy` & `carlos-flow-opencode`)

---

## 🎯 Why Carlos Flow?

| Pain Point | Traditional AI Coding | Carlos Flow's Mechanical Answer |
|------------|----------------------|--------------------------------|
| **Out-of-scope edits** | "Only edit `src/auth.py`" is a suggestion; Agent rewrites half the repo | `enforceScope()` runs `git diff` against card whitelist at runtime — **out-of-scope blocks dispatch** |
| **Verification theater** | Agent reports "tests passed"; no proof | `runVerifyCommand()` truly `spawn`s `verify.cmd`, captures stdout/stderr/exitCode; **PASS requires verification evidence** |
| **Mutable audit logs** | Plain files — deletable, editable | SHA-256 **chained audit logs** (`prevHash`→`hash`); change one, whole chain breaks |
| **Uncontrolled bypass** | One sentence disables all guards | Bypass requires explicit `confirmed=true` on card; **auto-cleared on every dispatch** |
| **Unlimited retries** | Claim resets counter; infinite dispatches | `dispatch_count` increments only on dispatch; exhaustion blocks both claim and dispatch |
| **Self-certified review** | Same Agent implements and approves | Built-in `auditor` role, independent contract, strict three-tier verdict `PASS/DIRECTION/LOCAL` |
| **No rollback after damage** | Manual `git revert` only | Pre-dispatch auto-snapshot → `flow_revert_plan` generates atomic restore plan |
| **Manual trigger every time** | No shout = no gate; forget = naked run | **Smart Trigger Engine** auto-detects intent, triggers on score, explains what matched |

---

## ⚡ Core Capability Comparison

| Capability | Carlos Flow | Native MCP Server | Prompts / Scripts |
|------------|-------------|-------------------|-------------------|
| **Scope enforcement** | ✅ Runtime `git diff` | ❌ None | ❌ Honor system |
| **Real verification** | ✅ `spawn` + capture; PASS needs proof | ❌ None | ❌ Agent says so |
| **Tamper-proof audit** | ✅ SHA-256 chained hashes | ❌ None | ❌ None |
| **Controlled bypass** | ✅ Explicit `confirmed=true` + auto-clear | ❌ None | ❌ One sentence kills all |
| **Honest dispatch quota** | ✅ Counts only dispatches | ❌ None | ❌ None |
| **Independent review** | ✅ Built-in `auditor` role | ❌ None | ❌ Optional |
| **Snapshot + restore** | ✅ Auto, atomic plan | ❌ None | ❌ Manual `git revert` |
| **Daemon lifecycle** | ✅ Fully auto (Cindy) | ❌ Manual | ❌ Manual |
| **Smart triggering** | ✅ 3-layer scoring + explainable decision | ❌ None | ❌ None |

> 📋 **Full QA Report**: [docs/QA_REPORT_v2.5.5.md](https://github.com/skyer-now/carlos-flow/blob/main/docs/QA_REPORT_v2.5.5.md) (3rd-party read-only audit, 13/13 mutants caught)  
> 🧬 **Mutation Report**: [docs/MUTATION_REPORT_v2.5.5.md](https://github.com/skyer-now/carlos-flow/blob/main/docs/MUTATION_REPORT_v2.5.5.md)

---

## 🚀 30-Second Quick Start

### 1. Install (Single package, zero conflicts)
```bash
npm install -g carlos-flow
```
> ⚠️ `ETARGET` error? Clear cache: `npm cache clean --force && npm view carlos-flow versions`

### 2. One-Command Init (Pick your platform)
| Platform | Command | Output |
|----------|---------|--------|
| **Cindy** | `carlos-flow init --target cindy` | `~/.cindy/ghosts/carlos-flow.json` |
| **OpenCode** | `carlos-flow init --target opencode` | `~/.config/opencode/plugin/opencode.json` + project `.mcprc` |
| **Cursor / Windsurf** | `carlos-flow init --target cursor` | Project `.cursor/mcp.json` |
| **Cline** | `carlos-flow init --target cline` | Project `.cline/mcp.json` |
| **VS Code (Copilot)** | `carlos-flow init --target vscode` | Project `.vscode/mcp.json` |
| **Claude Desktop** | `carlos-flow init --target claude` | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)<br>`%APPDATA%\Claude\claude_desktop_config.json` (Windows) |

> 💡 **Env vars** (optional, defaults work):  
> `CARLOS_FLOW_HOME=~/.carlos-flow` — state/audit dir (cross-platform)  
> `CARLOS_FLOW_MCP_ROOT=/path/to/carlos-flow` — repo root for source installs

### 3. Restart & Verify
```bash
# CLI verify
node client/carlos.js flow_status '{"sessionId":"probe"}'
# Expect has_card: false = service healthy
```

---

## 🧠 Smart Trigger Engine — "The Workflow Knows When to Show Up"

### 3-Layer Architecture, Explainable Decisions

```
User Input
    ↓
L1: DynamicTriggerManager (Dynamic Limit)
    - Computes current trigger limit: 5 + session_hrs×0.5 + complexity×2 − window_triggers×0.3, cap 15
    - Min 5 min between triggers; more triggers → lower limit (penalty, not reward)
    ↓
L2: TriggerScorer (3-Dimensional Scoring, max 38)
    - Keywords 50: Only workflow terms (workflow/gate/dispatch/audit/task-card…), NOT "implement/add/api"
    - Context 30: Workflow-relevant context
    - Intent 20: User behavior patterns
    ↓
L3: TriggerDecisionEngine (4-Tier Decision)
    - trigger  (≥15 & confidence≥0.8) → Auto-activate
    - review (10~15)                → Suggest manual start
    - ignore  (<10)                 → Silent ignore
    - throttled                     → Return real score, no action
    ↓
Activation (Auto Tier)
    1. flow_add_user_msg     — User utterance stored, becomes quote anchor source
    2. flow_submit_requirement (activation:true) — Submit read_only placeholder card, session enters gate state
    3. activation_pending    — Missing scope/acceptance/verify.cmd blocks claim/dispatch/verdict
    4. Resubmit complete card — Gate opens, normal dispatch
```

### Key Features
- 🎚️ **Dynamic Limit**: Longer session, complex task → higher limit; frequent triggers → tighter limit
- 🛡️ **Non-Intrusive**: 5-min minimum interval; throttled still returns real score & confidence
- 📊 **Transparent Scoring**: Every call returns full `breakdown` (matched keywords / context / intent)
- 🧠 **Feedback Learning**: Majority negative feedback → auto-raises threshold, more conservative
- 🇨🇳 **Chinese Ready**: Built-in Chinese workflow terms; ordinary dev requests **don't false-trigger**

> 📖 **Full Guide**: [TRIGGER_GUIDE.md](TRIGGER_GUIDE.md)

---

## 🏗️ System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      User / Agent                                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  MCP Client (client/carlos.js)                                   │
│  - Smart trigger check (flow_trigger_check)                      │
│  - Auto bridge launch, health check, token auth                  │
└─────────────────────────────────────────────────────────────────┘
                              │ JSON-RPC (stdio)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  MCP Server (src/index.js) — Core Toolset                        │
│  ├── flow_submit_requirement  — Trace / Submit task card         │
│  ├── flow_claim / flow_dispatch — Claim / Dispatch (with snap)  │
│  ├── flow_run_verify          — Real verify.cmd execution        │
│  ├── flow_verdict             — Verdict PASS/DIRECTION/LOCAL     │
│  ├── flow_check_scope         — Scope enforcement                │
│  ├── flow_status / flow_audit — Status query / Audit stream      │
│  ├── flow_bypass              — Controlled bypass                │
│  ├── flow_revert_plan         — Atomic restore plan              │
│  └── flow_trigger_check       — Smart trigger scoring            │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
        ┌──────────┐   ┌──────────┐   ┌──────────┐
        │ State    │   │ Audit    │   │ File     │
        │ (gate-   │   │ (gate-   │   │ (snap-   │
        │  state)  │   │  audit)  │   │  shots)  │
        └──────────┘   └──────────┘   └──────────┘
              │               │               │
              └───────────────┼───────────────┘
                              ▼
                    ┌──────────────────┐
                    │ Trigger Engine   │
                    │ (trigger-state/) │
                    └──────────────────┘
```

---

## 📦 Package Structure (Single Package, Zero Platform Coupling)

```
carlos-flow/
├── client/carlos.js                    # CLI entry (init --target)
├── src/index.js                        # Core MCP Server (stdio, std protocol)
├── src/trigger.js                      # Smart Trigger Engine (3-layer)
├── src/state.js                        # State / Audit / Anchor source (~ expansion)
├── src/card.js / dispatch.js / protocol.js
├── bridge/mcp-bridge.js                # Cindy: daemon + token auth
├── plugins/carlos-flow-trigger.js      # OpenCode: chat.message hook
├── ghost.json                          # Cindy manifest (__ROOT__ placeholder)
├── opencode.json / .template           # OpenCode config (rendered + template)
├── .mcprc.template                     # OpenCode MCP config template
├── trigger-config.usable.json          # Trigger default config (Chinese terms)
├── trigger-config.example.json         # Trigger config example
├── templates/                          # 6 platform init templates
│   ├── cursor/mcp.json
│   ├── cline/mcp.json
│   ├── vscode/mcp.json
│   └── claude/claude_desktop_config.json
└── test/                               # 128 test cases (all passing)
    ├── smoke.js / e2e-carlos.mjs / p0-gates.mjs
    ├── trigger-e2e.mjs / concurrency-e2e.mjs / e2e-acceptance.mjs
    └── mutation-check.mjs
```

---

## 🛠️ Development & Testing

```bash
# Clone source
git clone https://github.com/skyer-now/carlos-flow.git
cd carlos-flow

# Install deps
npm install

# Full test suite (128 cases, all pass)
npm run test:all

# Individual suites
npm run test:e2e        # E2E 61 cases
npm run test:p0         # P0 Gates 22 cases
npm run test:trigger    # Trigger Engine 29 cases
npm run test:concurrency # Concurrency 3 cases (zero leak, zero exploit)
npm run test:acceptance  # Acceptance 13 cases
npm run test:mutation   # Mutation testing (13/13 mutants caught)

# Local pack
npm pack
```

---

## 📚 Documentation

| Document | Description |
|----------|-------------|
| [TRIGGER_GUIDE.md](TRIGGER_GUIDE.md) | Smart Trigger Engine complete guide (config, scoring, activation, feedback learning) |
| [CHANGELOG.md](CHANGELOG.md) | Version history (Keep a Changelog + SemVer) |
| [QA Report](docs/QA_REPORT_v2.5.5.md) | 3rd-party read-only audit (13/13 mutants caught) |
| [Mutation Report](docs/MUTATION_REPORT_v2.5.5.md) | Mutant injection details |

---

## 🔄 Migration Guide (From Legacy Packages)

| Legacy Package | New Command | Notes |
|----------------|-------------|-------|
| `carlos-flow-cindy` | `carlos-flow` / `carlos-flow-cindy` (alias) | Keeps `carlos-flow` generic name, adds alias |
| `carlos-flow-opencode` | `carlos-flow-opencode` (only this) | OpenCode users switch to new command |

```bash
# Uninstall legacy
npm uninstall -g carlos-flow-cindy carlos-flow-opencode

# Install unified
npm install -g carlos-flow

# Re-init
carlos-flow init --target cindy      # or opencode/cursor/cline/vscode/claude
```

> ⚠️ Legacy packages `carlos-flow-cindy` / `carlos-flow-opencode` are **Deprecated**; install warns to migrate to `carlos-flow`.

---

## 🤝 Contributing

PRs welcome! Run `npm run test:all` first — **128/0 must pass**.

---

## 📄 License

MIT © Carlos Flow Contributors

---

## 🔗 Links

- **GitHub**: https://github.com/skyer-now/carlos-flow
- **npm**: https://www.npmjs.com/package/carlos-flow
- **Issues**: https://github.com/skyer-now/carlos-flow/issues
- **Changelog**: [CHANGELOG.md](CHANGELOG.md)