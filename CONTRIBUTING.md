# Contributing

Start with [Getting started](docs/guide/getting-started.md) to run the lab, and read [AGENTS.md](AGENTS.md) for the rules that apply to people and coding agents alike.

## What a pull request needs

- One problem per pull request. A second fix or an unrelated cleanup goes in its own PR.
- A conventional commit title in plain language, such as `fix(mes): held coils no longer count as produced`.
- The description follows the [template](.github/pull_request_template.md): the problem, the change, and how you verified it. Say what you could not check.
- Before and after screenshots for any change to a screen. They go in the PR, not in the repository.

## Changes to business cases

Cases in `catalog/` belong to the business. A new case comes from the intake form or a PR labeled `new-case`, and a key user reviews it. To change an expectation in an existing case, link the business decision behind it.

## Changes to the systems under test

The MES and the Level 2 client are part of the lab. When you change their behavior or their screens, run the business cases that use them and update the scenarios that patch them (see [AGENTS.md](AGENTS.md#keep-these-in-sync)).
