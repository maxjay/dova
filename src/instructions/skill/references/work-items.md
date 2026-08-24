# Work items

## Reading

`dova view <id>` reads a work item or a PR — it detects which. It
replaces `dova wi view`. Use `dova wi view` only when you specifically
want a work item and the id might collide with a PR id.

```console
$ dova view 4821
#4821 Login redirects to the wrong page after sign-in
User Story · Ready · unassigned

Area:      MyProject\Platform
Iteration: MyProject\Sprint 14

https://dev.azure.com/contoso/MyProject/_workitems?id=4821

Description
Users are sent to /undefined after sign-in.

Acceptance Criteria
- Redirect resolves to /dashboard for a valid token
- Invalid tokens return to /login with an error

Children (2)
┌───────┬──────┬────────────────────────┬────────┐
│ ID    │ Type │ Title                  │ State  │
├───────┼──────┼────────────────────────┼────────┤
│ #4822 │ Task │ Add null guard         │ Active │
└───────┴──────┴────────────────────────┴────────┘
```

The body is whichever fields the item actually carries. A User Story
states its objective in **Acceptance Criteria** and often leaves
Description thin. An Agile Bug puts its detail in **Repro Steps** and
frequently leaves Description empty. Read whichever appears — do not
conclude a ticket is underspecified because Description is short.

Bodies truncate at 800 characters. Pass `--full` for the rest. Never
open the browser for it.

## Searching

`dova wi search <query>` matches free text in the title and builds the
WIQL for you.

```console
$ dova wi search 'overdue reminder' --type 'User Story' --state Ready
$ dova wi search redirect --assigned-to me
$ dova wi search '' --tag security --state Active
```

Filters: `--state`, `--type`, `--assigned-to` (`me` resolves to the
current user), `--tag`. State and type names come from the project's
own process template — `Ready`, `Active`, `New` and `Committed` are all
real in different templates, so use what `dova view` shows on an
existing ticket rather than guessing.

## Filing

```console
$ dova bug 'Null check missing on empty session token' --at src/auth.ts:88 --link
Created Bug #5219
  https://dev.azure.com/contoso/MyProject/_workitems?id=5219
  Area: MyProject\Platform
  Iteration: MyProject\Sprint 14

Branch: fix/4821-login-redirect

Linked work items:
  #4821 [Bug] Login redirects to the wrong page after sign-in (primary)
  #5219 [Bug] Null check missing on empty session token
```

`--at file:line` builds a permalink to that line at the current commit.
`--link` attaches the new id to the current branch, so it rides along on
the same PR.

`dova wi quick <type> <title>` files any other type. `dova wi create`
is the fuller form, with `--assign-to` and `--parent`.

Titles with backticks, `$` or quotes must come through stdin — see
`references/automation.md`.

## Linking a branch

`dova link` records which branch corresponds to which work item. That
linkage is the one thing neither git nor Azure DevOps tracks on its own,
and it is what `dova pr create` reads back to attach tickets.

```console
$ git checkout -b fix/4821-login-redirect   # git's job — dova never creates branches
$ dova link 4821
Branch: fix/4821-login-redirect

Linked work items:
  #4821 [User Story] Login redirects to the wrong page (primary)
```

Several related tickets on one branch: `dova link 4821 5219 5220`. The
first id is primary.

If an id has open children, `dova link <parent>` offers to link the
children instead. Without a terminal it errors and lists the child ids
— pass them directly.

`dova unlink <id>` removes one; `dova unlink --all` clears the branch.
`dova list` shows every branch with a linked ticket.

It lives in that branch's git config, so it needs no server round-trip
and travels with the branch.
