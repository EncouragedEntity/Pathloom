# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub:
**Security → Report a vulnerability** on [github.com/XxArDy/Pathloom](https://github.com/XxArDy/Pathloom/security/advisories/new).
Do not open a public issue for them.

Include what an attacker can do, the steps to reproduce and the Pathloom version. You should get a first answer within a week.

## What counts

Pathloom is a local app: it reads and writes files in the project folder you open and runs the `pathloom` CLI / MCP server for
AI agents. Things we treat as vulnerabilities include:

- reading or writing files outside the opened project (path traversal through plan files, assets, artifacts or board names);
- running a command or opening a link without the user's confirmation;
- a crafted plan file that crashes the app or corrupts other files;
- the MCP server doing more than its tools describe (for example in `--read-only` mode).

## Supported versions

Only the latest release gets fixes.
