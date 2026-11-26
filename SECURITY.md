# Reporting a vulnerability

This plugin makes automated safety decisions about AI-agent permissions, so
we take security bugs seriously.

Please **do not** file a public issue for a security vulnerability. Instead,
use GitHub's private vulnerability reporting:

- go to **Report a vulnerability** at
  https://github.com/Warc0s/opencode-permission-reviewer/security/advisories/new

or email the maintainer directly if the report contains sensitive details.

Include, when possible:

- a minimal reproduction (command + permission policy that triggers it),
- the affected version (`package.json` → `version`),
- the OpenCode version you run,
- the expected vs. actual safety outcome.

We will acknowledge within a few days and coordinate a fix and disclosure.

## Threat model notes

This plugin is a **defense-in-depth aid**, not a complete sandbox. It reviews
`ask`-classified actions with a second model call and fails safe to manual
review when anything is uncertain. It does not replace OpenCode's own
permission system, your model provider's safety layers, or good OS-level
hygiene. A determinedly adversarial agent may still attempt to mislead the
reviewer; the deterministic emergency brake and the untrusted-evidence prompt
mitigate but cannot fully eliminate that risk.
