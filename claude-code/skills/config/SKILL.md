---
name: config
description: Set up or change the Swag Scan config (ticket folder, target branch, live view, auto-fix, file size limit) with a few quick questions. Use before the first run, or when asked to change a Swag Scan setting.
allowed-tools: Bash(swag-scan *), AskUserQuestion
---

# Swag Scan config

Save the five Swag Scan settings in `~/.swag-scan/settings.json` (a per-user file, outside any repository) with a few multiple-choice questions. `/swag-scan:run` also works without this setup, on the defaults, so this is for choosing your own. Ask only what is below, in this order, and make nothing up.

## 1. Read what is saved

```sh
swag-scan config show --json
```

Keep `configured` and the current `values`. If `configured` is `true`, this is a change: offer each current value as the first option, labelled "Keep ...". If it is `false`, this is the first setup: the defaults below are the first options, marked "(Recommended)".

## 2. Ask (use AskUserQuestion; the person can always type their own answer through "Other")

First call, four questions:

1. **`ticketSourcePath`** — "Which folder holds your Jira XML ticket exports?" Explain that a ticket `ID-123` is read from `ID-123.xml` in that folder. Options: "Keep <current folder>" (only if one is saved), "No ticket folder for now". Anyone with a folder types its full path through "Other".
2. **`targetBranch`** — "Which branch should your changes be compared against?" Options: "Detect it for me (Recommended)" (saved as `auto`: origin/HEAD, develop, main or master, whichever exists), "main", "develop". Another name goes through "Other". If this is a change and a branch is saved, offer "Keep <current>" first.
3. **`liveDashboard`** — "Open the live view while a scan runs?" Options: "Yes (Recommended)", "No".
4. **`autoFix`** — "Let the Inspector fix low-risk cleanup items for you?" Options: "No, only report them (Recommended)", "Yes, fix clear low-risk items".

Second call, one question (or two):

5. **`maxFileLines`** — "How many lines may a changed file have before it is flagged as too big?" Options: "1000 lines (Recommended)", "500 lines", "2000 lines". A number goes through "Other"; it must be a whole number.

6. **Only if the `targetBranch` answer is a specific branch, not "Detect it for me":** "Use this branch for every repository, or only this one?" Options: "Every repository (Recommended)", "This repository only". Skip it for "Detect it for me".

## 3. Save

Save all five in one command. Put every value in single quotes, because folder paths may hold spaces or backslashes. Use an empty `''` for no ticket folder. For `targetBranch` use `auto` for "Detect it for me", the branch name for "Every repository", and, for "This repository only", the value already saved (`auto` on a first setup) so the other repositories are not changed.

```sh
swag-scan config set ticketSourcePath '<folder>' targetBranch '<branch>' liveDashboard <true|false> autoFix <true|false> maxFileLines <number>
```

For "This repository only", then save the branch for this repository (run it inside the repository):

```sh
swag-scan config set targetBranch '<branch>' --this-repo
```

To remove a repository's own branch again, use `swag-scan config unset targetBranch --this-repo`.

If it prints a one-sentence error, tell the person which answer was not usable, ask that one question again, and save again. A branch that does not exist here is not an error to the config (it may exist in another repository), but `swag-scan doctor` will flag it. If it notes that the ticket folder does not exist yet, pass that note on as is.

## 4. Finish

Show the saved settings as a short list, then give the next step in these words: "You are ready to run Swag Scan! Just type `/swag-scan:run your_ticket_Id`". Add nothing else: no flag list, no extra setup.
