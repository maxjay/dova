---
name: dova
description: Azure DevOps work through the `dova` CLI — reading work items, linking branches to tickets, opening and reviewing pull requests, replying to review threads, and diagnosing pipeline failures. Use this whenever a task touches an Azure DevOps work item, pull request, or build, whenever a ticket id or PR id appears, and whenever you would otherwise reach for `az boards` or `az repos`. Do NOT use for GitHub or GitLab repositories.
---

# dova

Azure DevOps from the command line. `dova` wraps `az` and `git`, and
infers org, project and repo from the git remote — commands need no
`--org` or `--project`.

Never call `az boards` or `az repos` directly. `dova` records the
branch-to-ticket link that raw `az` can neither read nor write.

## Commands

| Need | Run |
|---|---|
| Read a ticket or PR | `dova view <id>` |
| A PR's code | `dova summarize <pr-id>` |
| What a file changed | `dova summarize --files <path>` |
| This branch's state | `dova status` |
| A PR's threads | `dova pr view <pr-id>` |
| One thread in full | `dova pr comment show <pr-id> <thread-id>` |
| Catch up on a branch | `dova summarize <branch>` |
| Find tickets | `dova wi search <query>` |
| Why CI failed | `dova pipeline log` |
| Anything else | `dova api <path>` |

`dova <command> --help` lists flags. Add `--full` to `view` when text is
truncated. `summarize`'s `Diff` is a stat — for actual code, pass
`--files <path...>`, not `--full`.

## Read a reference when it applies

| Read | When |
|---|---|
| `references/work-items.md` | Reading, searching, filing or linking work items |
| `references/pull-requests.md` | Creating a PR, reading its code, or answering review threads |
| `references/automation.md` | A command failed, asked a question, or you need to pass free text or parse output |
| `references/pipelines.md` | CI is red |

Do not read them all. Each covers one area in full.

## Never

- **Never** use `dova pr view` for code. Use `dova summarize`.
- **Never** re-read a ticket `summarize` already printed.
- **Never** re-run a command to add `--json`. Choose the format first.
- **Never** run `az boards work-item update`. `dova pr create` passes
  `--transition-work-items`; state changes on completion.
- **Never** create, name or check out a branch with `dova`. Use git,
  then `dova link`.
- **Never** `git checkout` to read a PR. `dova summarize <pr-id>`
  fetches it.
- **Never** re-run a failed pipeline hoping it passes.
