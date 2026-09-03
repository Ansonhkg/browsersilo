# Milestone 02: real Brave workers and MCP

This document records the earlier 0.2 vertical slice. BrowserSilo 0.3 has replaced its temporary compatibility architecture. For the current runtime, use the [README](../README.md), [completion matrix](completion-matrix.md), and [security and operations guide](security-and-operations.md).

## What the milestone proved

The 0.2 live harness demonstrated that a real LLM could discover BrowserSilo over MCP, acquire a disposable headed Brave worker, navigate and interact through CDP, take a screenshot, release the lease, and recover the same profile's local storage in a different worker. The run ended without managed containers.

Those proof artifacts remain useful regression evidence, but they are no longer the current security contract.

## What 0.3 replaced

The current implementation removed the `--no-sandbox` compatibility image and host-published random CDP port. It now uses a purpose-built non-root image with Chromium's sandbox enabled, private in-container MCP/CDP transport, per-lease egress networks, a real pre-created pool, durable two-phase lifecycle state, KMS-backed streaming profile and artifact encryption, Domain Capture, WebM/HAR/trace brokerage, quotas, telemetry, and the HeroUI Pro control plane.

Current acceptance extends the original proof to the full 145-tool MCP contract, representative behavior from every safe `agent-browser` feature group, artifact signature inspection, profile recovery after a forced service crash, hostile egress checks, real LLM use, and final orphan auditing.
