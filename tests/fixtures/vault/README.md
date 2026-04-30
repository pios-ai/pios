# Fixture vault for CI

Minimal Pi vault used by `npm test` (CI doesn't have a real owner vault).

`PIOS_VAULT=tests/fixtures/vault npm test`

p6-smoke-test auto-bootstraps `Pi/State/pi-social.json` + `Pi/State/chitchat-log.json` if missing (look for `ensureFixture` in `test/p6-smoke-test.js`), so this directory only needs the `Pi/State/` skeleton present.
