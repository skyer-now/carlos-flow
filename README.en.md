# Carlos Flow

[![npm](https://img.shields.io/npm/v/carlos-flow.svg)](https://www.npmjs.com/package/carlos-flow)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen.svg)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-1.29%2B-blue.svg)](https://modelcontextprotocol.io)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![CI](https://img.shields.io/badge/CI-passing-brightgreen.svg)](https://github.com/skyer-now/carlos-flow)

**Languages:** [English Documentation](README.en.md) | [中文说明](README.zh.md)

---

> **The AI Coding Guardian & Safety Guide for Windows**
>
> Turn "blind trust in Agent" into "**verifiable, auditable, high-performance execution**" with zero learning curve.

---

## Operating System Support

Currently, only **Windows** is supported. CI and release workflows use only `windows-latest`; macOS / Linux validation is paused and support is not claimed. Retained generic path and process safety code does not mean those systems have been validated. See [platform support notes](docs/PORTABILITY.md). Developer-tool adapters do not imply real-host acceptance of every combination.

## 💡 Why Carlos Flow?

When using AI coding assistants (like OpenCode, Claude Code, Cursor, VS Code, or Cindy), you often face:
* **Out-of-Scope Modifications**: You asked to fix a simple bug, but the AI rewrote half of your repository.
* **Verification Theater**: The AI self-reports "all tests passed" without actually running any test command.
* **Context Explosions**: Giant test logs flood model context windows, breaking IPC channels and draining tokens.
* **Hanging Long-Running Tasks**: Silent channels during lengthy tests lead clients to kill execution prematurely.
* **Complex Errors & Hard Rollbacks**: Mysterious error dumps with no plain explanation on how to revert.

**Carlos Flow is a workflow gate and smart guide for AI coding on Windows**, providing mechanical guardrails, communication optimizations, and plain-language guidance for existing developer tools.

---

## 🌟 Highlights & New Features in v3.3.2

### 1. Sentiment & Doubt Perception Engine (v3.3.0 ~ v3.3.2)
* **Multi-dimensional Attitude Recognition & Bilingual Alignment**: Captures strong dissatisfaction, negative refutations, consecutive punctuation (???/!!!), and English questioning patterns (`why is it still failing`, `totally wrong`, `did you even test`, etc.).
* **Strict Negation & False-Positive Guard**: Implements `STRICT_NEGATION_PATTERNS` with top silent priority (*"Don't touch the code yet / No need to start workflow"*), ensuring 100% complete silence when the user explicitly requests no changes, while distinguishing code questions from purely conceptual discussions.
* **Dynamic Threshold Adaptation**: Automatically reduces the trigger threshold by 20% in high-doubt contexts to proactively safeguard operations.

### 2. Fail-Closed Scope Enforcement & Boundary Hardening
* **Comprehensive Scope Guard**: `enforceScope` now scans unstaged changes, **staged changes (`git diff --cached`)**, and untracked new files. Completely closes the loophole where AI executing `git add` bypassed gate interception.
* **Strict Fail-Closed on Git Failure**: Git command timeout or non-zero status rejects execution instead of silently defaulting to empty diffs.
* **Snapshot Lifecycle Isolation**: Snapshots now bind `card_ts` task timestamps, preventing previous task files from contaminating revert plans.

### 2. Communication Optimization & Protection
* **P1 Output Protection & Private Artifact Storage**:
  * **4KB UTF-8 Stream Summary**: Truncates large stdout/stderr outputs safely by Unicode codepoints with plain folding markers to protect model context.
  * **Private Storage & Retention**: Full output is saved to private directories (`0700/0600` on POSIX, stripped inherited ACL on Windows) with automatic **30 copies / 7 days** rolling cleanup.
  * **Zero Evidence Tampering**: Fingerprints (`output_hash` and workspace state) are calculated and committed before presentation, preserving 100% evidence integrity.
  * **Graceful Degradation**: Transparently falls back to full output with plain warning if artifact storage fails.
* **P2 MCP Progress Heartbeat Notifications**:
  * **Standard Progress Notifications**: Ingests `params._meta.progressToken` and emits periodic `notifications/progress` during test runs to keep client channels active.
  * **Strict Boundary Safety**: Completely silent without tokens; safely supports numeric token `0`; deterministically clears timers in `finish()`.
* **P3 Composite Transactions (`pipeline_start`)**:
  * **Atomic Pipeline Dispatch**: Sequentially coordinates `submit → claim → dispatch` in one call via `carlos_task(action: "pipeline_start")`.
  * **Stage Short-Circuiting**: Immediately aborts on preceding validation errors without leaving unauthorized states.
  * **Step Snapshots & Recovery Guidance**: Returns structured step receipts and actionable notes on dispatch errors without requiring card resubmission.

### 3. Session Context Auto-Inheritance
* **Seamless Session Tracking**: Automatically adopts host-provided `carlosContext.session_id` when explicit `sessionId` is omitted, eliminating isolated state under `unknown`.

### 4. Advisory Review System (Lightweight Dual-Axis Review)
* **Evidence Axis**: Audits whether searches were actually conducted, sources support claims, and statements match proofs.
* **Feasibility Axis**: Audits plan soundness, technical feasibility, blast radius, and verifiable rollback paths.
* **Lightweight Rule-Based Engine**: Triggers `none` for read-only queries, `single` for troubleshooting, and `dual` for high-risk plans with topic cooldowns and 24h budget limits.

### 5. High-Level Facade Architecture
* **`carlos_task`**: Manages requirements, claims, composite dispatch, and results (`submit`, `claim`, `dispatch`, `start`, `pipeline_start`, `protocol`, `add_user_msg`, `save_result`).
* **`carlos_verify`**: Manages execution, negative control (falsification), and scope checks (`run`, `falsify`, `check_scope`, `trigger_check`, `diff_hunks`).
* **`carlos_review`**: Manages dual-axis audits, verdicts, and advisory reviews (`axes`, `submit`, `guard`, `verdict`, `audit`, `advisory_axes`, `advisory_submit`, `advisory_guard`).
* **`carlos_manage`**: Manages status, cancellation, rollback plans, and storage metrics (`status`, `cancel`, `revert`, `stats`, `bypass`, `mode`).

### 6. Mechanical Guardrails (Fail-Closed)
* **Scope Enforcer**: Automatically blocks out-of-scope edits at runtime.
* **Evidence-Driven Testing**: Spawns real test suites (`verify.cmd`); no valid pass proof means no completion.
* **Tamper-Evident Audit Trail**: SHA-256 chained logs (`prevHash` → `hash`).
* **Separation of Duties**: Implementers (`executor`) cannot approve their own work; independent review (`auditor`) is mandatory.

---

## 🚀 Quick Start

### 1. Global Installation
```bash
npm install -g carlos-flow
```

### 2. Initialize for Your Platform
```bash
carlos-flow init --target cindy     # Cindy
carlos-flow init --target opencode  # OpenCode
carlos-flow init --target cursor    # Cursor / Windsurf
carlos-flow init --target vscode    # VS Code
carlos-flow init --target cline     # Cline / Claude Desktop
carlos-flow init --target workbuddy # Tencent WorkBuddy
carlos-flow init --target codex     # OpenAI Codex CLI
carlos-flow init --target trae      # ByteDance Trae
carlos-flow init --target qoder     # Alibaba Qoder
```

### 3. Verify Server Status
Run in any terminal:
```bash
carlos-flow flow_status '{"sessionId":"test"}'
```
Returning `"ok": true` confirms the gate service is ready.

---

## ⚙️ 6-Step Closed-Loop Workflow

```
  1. Record Requirement     2. Claim Ticket         3. Dispatch & Snapshot
(State Goals & Scope)   →  (Acquire Executor)   →  (Auto Workspace Snapshot)
                                                           │
                                                           ▼
  6. Final Delivery         5. Dual-Axis Audit      4. Real Verification
(PASS / Revert Plan)    ←  (Standards & Spec)   ←  (Spawn Real Test Suite)
```
*(💡 Use `carlos_task(action: "pipeline_start")` to execute steps 1–3 in one call)*

---

## 📚 Documentation

* [Trigger Guide](./TRIGGER_GUIDE.md) —— Intent classification, side-effect triage, and dual-threshold decisions
* [Migration Guide](./MIGRATION.md) —— Smooth upgrade from older architectures
* [Changelog](./CHANGELOG.md) —— Full version history
* [Release Notes](./RELEASE_NOTES.md) —— Latest release highlights and fixes
