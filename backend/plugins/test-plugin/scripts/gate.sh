#!/bin/bash
# test-plugin · gate hook stub
#
# Normally returns fire:false so it does not trigger real triage runs.
# To test the fire path, export PIOS_TEST_PLUGIN_FIRE=true before calling.
#
# Output: single-line JSON per on_gate contract.

if [ "${PIOS_TEST_PLUGIN_FIRE:-false}" = "true" ]; then
  printf '{"fire":true,"kind":"test-event","payload":{"msg":"test-plugin gate fired"},"since_state":{"last_test_fire":"%s"}}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
else
  printf '{"fire":false}\n'
fi
