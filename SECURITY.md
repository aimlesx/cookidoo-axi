# Security policy

## Supported versions

This project is currently a public-beta candidate. Security fixes are provided
only for the newest published `0.1.0-beta.x` release until a stable support
policy is announced.

## Reporting a vulnerability

Use the canonical repository's private vulnerability-reporting feature. Do not
put credentials, cookies, account data, exploit details, or affected recipe
content in a public issue. If private reporting is not enabled, open a minimal
public issue asking the maintainer to establish a private channel; withhold the
sensitive details until that channel is available.

Include the affected version and macOS architecture, a minimal offline
reproduction, impact, and any suggested remediation. Use synthetic values and
injected storage/transport whenever possible. Never test against another
person's account, publish a recipe or list, delete remote resources, or access
Cookidoo beyond your own authorization while investigating a report.

## Security boundaries

- Market credentials, cookie sessions, and feed credentials are distinct
  macOS Keychain items and must remain account-scoped.
- API and login destinations are fixed allowlists; redirects outside them are
  rejected.
- Mutation outcomes can be ambiguous after a timeout. Do not retry until the
  exact resource is reconciled with the read command returned by the CLI.
- Generated commands must be treated as shell input and are conservatively
  quoted. Avoid copying commands from untrusted or modified output.
- `--debug`, shell history, redirected output, `--data` files, and the original
  environment import file are outside Keychain protection.

For privacy, appliance, recipe, and responsible-use guidance, see the
corresponding section in `README.md`.
