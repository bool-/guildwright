#!/usr/bin/env python3
"""Verify that a workflow_dispatch really came from an approved Discord request.

WHY THIS EXISTS
---------------
Without it, "a human approved this in Discord" is a property of the *bot* only.
Anyone able to dispatch a workflow -- repo write access, a leaked token, another
workflow -- could build any issue they liked, including one they filed
themselves, and the bot's approval card would be irrelevant because nothing on
the GitHub side ever re-checked it.

WHAT IS BOUND (v2)
------------------
The MAC covers eight values joined by ".", the first a literal:

    v2.<request_id>.<approval_id>.<issue_number>.<sha256 of the issue body>
      .<environment_name>.<approval_issued_at>.<repository>

Binding the body hash closes the "get something harmless approved, then rewrite
the issue" attack, because editing the body after approval changes the digest
and invalidates the token.

Binding the ENVIRONMENT NAME closes the billing attack. `environment_name`
selects the GitHub environment whose ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN
pays for the run, and it is a NON-SECRET dispatch input -- Actions masks
`secrets.*` and never masks `inputs.*`, so its value is plainly readable in the
run title, the REST API and this job's own log. Anyone who can dispatch this
workflow can therefore replay an approval token they saw and point it at
somebody else's environment, spending that person's Anthropic credits under an
approval they never gave. Making the environment name part of the signed tuple
is what makes the choice of payer unforgeable rather than merely inconvenient
to guess.

Binding the APPROVAL ID and the ISSUE TIME closes the REPLAY attack, which is
the reason this file is on its second tuple. Every dispatch input is printed in
plaintext, so the token itself could be copied out of a finished run's log and
re-dispatched as-is until the daily cap stopped it: a non-expiring bearer
credential. Now the bot persists one approval id per approval and signs it in,
the workflow's next step consumes that id (a second run carrying it is refused),
and this script refuses a token issued more than APPROVAL_MAX_AGE_SECONDS before
the run was created. A token read out of a log is worth one build, briefly, and
then nothing.

Binding the REPOSITORY closes cross-repository replay for an operator who uses
one key across several repositories. It is `owner/name` exactly as
`$GITHUB_REPOSITORY` renders it; the bot signs the `full_name` GitHub returned
for the repository, not the pair in its `.env`, so a mis-cased `.env` still
verifies. It is last in the tuple because a repository name may contain a dot
and every field before it has a fixed shape, so the serialisation stays
unambiguous.

The literal `v2.` prefix means a token produced by the previous tuple cannot
verify against this script even if a field happened to collide.

CANONICAL FORM
--------------
The body is hashed EXACTLY as the GitHub API returns it, encoded UTF-8. The bot
must therefore hash the body it reads back from the API after creating the
issue -- not the string it sent -- or the two sides will disagree the first time
GitHub normalises anything. `approval_issued_at` and `RUN_CREATED_AT` are both
Unix SECONDS as decimal integers; the shell step validates their shape before
this script runs, and this script fails closed on anything `int()` rejects.

ORDER OF CHECKS
---------------
The MAC is compared FIRST, then the age. An unauthenticated dispatch must learn
nothing from the age branch, so a token that does not verify is refused before
its issue time is even read as a number.

WHERE THE KEY MUST LIVE
-----------------------
APPROVAL_HMAC_KEY must be a REPOSITORY secret, not an environment secret.

This gate runs inside whichever environment `environment_name` selected, and
that is now `user-<discord-id>` for anyone who brought their own Anthropic
credentials. An environment secret is visible only inside its own environment,
so a key stored only in `ai-agent` resolves to the empty string in every
bring-your-own-credentials run -- and this script would then reject every one of
them with a key-length error, for a reason that has nothing to do with the
approval. A repository secret resolves in all of them.

Exits 0 on success, 1 on any failure. On an AGE failure it also writes
`reason=expired` to $GITHUB_OUTPUT (when set), so the run report can tell the
bot "too old" apart from "did not verify". Never prints the key or the body.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import sys

MIN_KEY_BYTES = 32
DEFAULT_MAX_AGE_SECONDS = 900
# How far INTO THE FUTURE an issue time may be before it is refused. Covers ordinary clock skew
# between the bot host and GitHub; a token "issued" well after the run was created is not skew.
FUTURE_SKEW_SECONDS = 300


def body_digest(body: str) -> str:
    """SHA-256 of the issue body, as hex. The canonical form both sides agree on."""
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def expected_token(
    key: bytes,
    request_id: str,
    approval_id: str,
    issue_number: str,
    body_sha: str,
    environment_name: str,
    approval_issued_at: str,
    repository: str,
) -> str:
    """HMAC-SHA256 over the bound tuple, as hex.

    The field order, the `v2.` prefix and the "." separator must match
    `BuildsPort.signApproval` in src/adapters/github/runs.ts exactly. A
    disagreement does not fail at boot -- it fails on every dispatch, while a
    human watches an approval card, and it reads like a tampered issue body
    rather than like a code change. src/adapters/github/runs.test.ts runs THIS
    script against a token produced by that signer, which is the only thing
    that actually keeps the two honest.
    """
    message = (
        f"v2.{request_id}.{approval_id}.{issue_number}.{body_sha}"
        f".{environment_name}.{approval_issued_at}.{repository}"
    )
    return hmac.new(key, message.encode("utf-8"), hashlib.sha256).hexdigest()


def fail(*lines: str) -> None:
    for line in lines:
        print(f"::error::{line}")
    sys.exit(1)


def note_reason(reason: str) -> None:
    """Tell the run report WHY, through the one channel a later step can read."""
    path = os.environ.get("GITHUB_OUTPUT")
    if not path:
        return
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(f"reason={reason}\n")


def main() -> None:
    try:
        key = os.environ["APPROVAL_HMAC_KEY"].encode("utf-8")
        request_id = os.environ["REQUEST_ID"]
        approval_id = os.environ["APPROVAL_ID"]
        issue_number = os.environ["ISSUE_NUMBER"]
        supplied = os.environ["APPROVAL_TOKEN"]
        environment_name = os.environ["ENVIRONMENT_NAME"]
        approval_issued_at = os.environ["APPROVAL_ISSUED_AT"]
        repository = os.environ["REPO"]
        run_created_at_raw = os.environ["RUN_CREATED_AT"]
        issue_path = os.environ["ISSUE_JSON_PATH"]
    except KeyError as exc:
        fail(f"missing required environment variable: {exc.args[0]}")
        return

    if len(key) < MIN_KEY_BYTES:
        fail(
            "the APPROVAL_HMAC_KEY secret is missing or shorter than 32 bytes.",
            "It must be a REPOSITORY secret holding the same value the bot uses.",
            "An environment secret is not enough: this job runs in whichever",
            f"environment was selected ({environment_name}), and an environment",
            "secret set only on 'ai-agent' is empty in every per-user run.",
        )

    try:
        with open(issue_path, encoding="utf-8") as handle:
            issue = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"could not read the fetched issue: {exc}")
        return

    body_sha = body_digest(issue.get("body") or "")
    want = expected_token(
        key,
        request_id,
        approval_id,
        issue_number,
        body_sha,
        environment_name,
        approval_issued_at,
        repository,
    )

    # Constant time: a timing oracle here would leak the key one byte at a time.
    if not hmac.compare_digest(want, supplied):
        fail(
            "approval token does not match this issue.",
            "One of five things is true: this dispatch did not come from an",
            "approved Discord request; the issue body was edited after it was",
            "approved; environment_name was changed after signing, i.e. somebody",
            "tried to redirect the bill to another user's credentials; the token",
            "was minted for a different repository; or approval_id or",
            "approval_issued_at were altered.",
        )

    # The age check runs only once the MAC has verified (see ORDER OF CHECKS).
    try:
        max_age = int(os.environ.get("APPROVAL_MAX_AGE_SECONDS") or DEFAULT_MAX_AGE_SECONDS)
        issued_at = int(approval_issued_at)
        run_created_at = int(run_created_at_raw)
    except ValueError:
        fail("approval_issued_at, RUN_CREATED_AT and APPROVAL_MAX_AGE_SECONDS must be decimal integers")
        return
    if max_age <= 0:
        fail("APPROVAL_MAX_AGE_SECONDS must be a positive number of seconds")

    age = run_created_at - issued_at
    if age < -FUTURE_SKEW_SECONDS:
        note_reason("expired")
        fail(
            f"approval token is from the future ({-age}s after this run was created); check the bot host clock."
        )
    if age > max_age:
        note_reason("expired")
        fail(
            f"approval token was issued {age}s before this run was created; the limit is {max_age}s.",
            "Re-run /request retry in Discord to get a fresh approval.",
        )

    print(
        f"approval {approval_id} verified for issue #{issue_number} in environment {environment_name}"
        f" ({age}s old)"
    )


if __name__ == "__main__":
    main()
