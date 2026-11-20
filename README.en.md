# Carlos Flow

[![npm](https://img.shields.io/npm/v/carlos-flow.svg)](https://www.npmjs.com/package/carlos-flow)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen.svg)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-1.29%2B-blue.svg)](https://modelcontextprotocol.io)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![CI](https://img.shields.io/badge/CI-passing-brightgreen.svg)](https://github.com/skyer-now/carlos-flow)

**Languages:** [English Documentation](README.en.md) | [中文说明](README.zh.md)

---

> **Mechanical Safety Gate & Plain-Language Guide for AI Coding Agents**
>
> Turn "blind trust in Agent" into "**verifiable, auditable execution**" with zero learning curve.

---

## 💡 Why Carlos Flow?

When using AI coding assistants (like OpenCode, Claude Code, Cursor, VS Code, or Cindy), you often face:
* **Out-of-Scope Modifications**: You asked to fix a simple bug, but the AI rewrote half of your repository.
* **Verification Theater**: The AI self-reports "all tests passed" without actually running any test command.
* **Complex Errors & Hard Rollbacks**: Mysterious error dumps with no plain explanation on how to revert.

**Carlos Flow is a plug-and-play universal workflow gate and smart guide** that works across all developer platforms.

---

## 🌟 Highlights

### 1. Cross-Platform & Zero Disruptions
* Works out of the box with Cindy, OpenCode, Cursor, Cline, VS Code, and Claude Desktop.
* Pure background assistance without console popups or resident background bloat.

### 2. Mechanical Guardrails (Fail-Closed)
* **Scope Enforcer**: Automatically blocks out-of-scope edits at runtime.
* **Evidence-Driven Testing**: Spawns real test suites (`verify.cmd`); no valid pass proof means no completion.
* **Tamper-Evident Audit Trail**: SHA-256 chained logs (`prevHash` → `hash`).
* **Separation of Duties**: Implementers (`executor`) cannot approve their own work; independent review (`auditor`) is mandatory.

### 3. Smart Plain-Language Guidance
* **Plain Error Explanations**: Converts errors into clear steps: *Why it stopped + What caused it + How to continue*.
* **Semantic Side-Effect Triage**: Distinguishes read-only questions from real mutations to prevent accidental locks.
* **Multi-Turn Context Resolution**: Understands short commands like "Let's do it" by auto-extracting file paths from recent dialogue.
* **One-Click Revert & Cancel**: Instantly reset or restore your workspace back to the initial snapshot.

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
```

### 3. Verify Status
```bash
carlos-flow flow_status '{"sessionId":"test"}'
```

---

## ⚙️ The 6-Step Closed Loop

```
1. Record & Card      2. Claim Entry        3. Snapshot & Dispatch
(Goal & Scope)     →  (Get executor role) → (Auto workspace backup)
                                                   │
                                                   ▼
6. Safe Delivery       5. Dual-Axis Audit    4. Real Verification
(PASS or Revert)   ← (Standards & Spec)   ← (Run tests & grab proof)
```

---

## ❓ FAQ

**Q: Does Carlos Flow slow down my PC or AI?**  
A: No. The core engine is built with lightweight local JavaScript. Each decision takes **less than 2ms**, with zero external network or model token overhead.

**Q: What if I triggered the gate by accident?**  
A: Simply reply with **"Cancel gate"** to release the session immediately, or **"Revert"** to restore your code back to the initial state.

---

## 📚 Documentation

* [Smart Trigger Guide](./TRIGGER_GUIDE.md) — Scoring, side-effect triage, and dual-threshold decisions
* [Migration Guide](./MIGRATION.md) — Upgrading smoothly from older versions
* [Changelog](./CHANGELOG.md) — Detailed version release notes

---

## 📄 License

MIT © Carlos Flow Contributors
