#!/bin/bash
# test-plugin · ingest hook stub
#
# Returns a single dummy event for smoke testing the ingest path.
# Output: single-line JSON per on_ingest contract.

printf '{"events":[{"kind":"test-ingest","summary":"test-plugin ingest stub","msg":"this is a smoke-test event — safe to ignore"}],"summary_for_triage":"test-plugin: 1 stub event"}\n'
