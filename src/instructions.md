## Azure DevOps: use `dova`

For Azure DevOps work items, pull requests and pipelines, use `dova` — never `az boards`, `az repos` or `az pipelines`, and never the browser. `dova` takes org, project and repo from the git remote. If it isn't installed, stop and say so.

| Need | Run |
|---|---|
| The current branch: PR, work items, CI, review threads | `dova status` |
| Catch up on a branch or PR (tickets, commits, diff) | `dova summarize [branch\|pr]` (`--files <paths>` for the actual diff) |
| Read a work item or PR | `dova view <id-or-link>` |
| Find work items | `dova wi search <words> [--state … --type … --assignee me]` |
| Start work on a ticket | `git checkout -b <branch>` then `dova link <id>` |
| File a bug / work item | `dova bug '<title>'`, `dova wi create '<title>' --type Task [--parent <id>]` |
| Open the PR | `dova pr create --title '<title>' --body - <<'EOF'` … `EOF` |
| Answer review threads | `dova pr reply <pr> <thread> - --resolve <<'EOF'` … `EOF` |
| Read one whole thread | `dova pr thread <pr> <thread>` |
| Why CI failed | `dova pipeline log` |

Rules:

- **Run `dova link <id>` before `dova pr create`**, or the PR opens with no ticket attached.
- **Never change a work item's state or assignee** with other tools: completing the PR moves its linked work items on.
- **Pipe free text through stdin** (`-` plus a quoted heredoc, `<<'EOF'`): the shell rewrites `$x` and runs `` `cmd` `` in arguments. Single-quote short titles. Length is never a problem; don't shorten bodies.
- **Decide on `--json` before running**, not after: `dova status --json`, `--json a,b` for fields, `--jq <expr>` to filter. Human output is not a stable format.
- **Prefer one command that returns everything** (`status`, `summarize`, `pr view`) over several narrow ones.
- Exit codes: `1` bad input, `2` not found (a normal answer, e.g. no PR yet), `3` not signed in or no access, `4` a request failed. On `3`, show the user the error — it names the command that fixes it, usually `az login`. Never sign in for them.
