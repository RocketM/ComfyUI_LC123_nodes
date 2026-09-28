CivitAI 🚩🔪 (LC CivitAI Strip): DISCLAIMER
============================================

What it is for
- LLMs sometimes (and abliterated models especially) describe adults as "child" or as "a young adult in their late teens or early 20s".
- This node removes those words (and the rest of civitai_compliance_remove.txt) from a prompt, so a caption you
  never read does not end up in a post you did not mean to make.

What it is NOT
- It is a word filter, not a safety system. It only removes the exact words and phrases in the list (whole words,
  any capitalization). It cannot see an image, understand a prompt, or catch spelling tricks and new wording.
- It does not make any content allowed. Removing a word from a prompt changes nothing about the image.
- There is no guarantee the list is complete, current, or enough for CivitAI approval. Policies change, and
  moderation and metadata checks still apply.

Your responsibility
- You alone are responsible for what you create and post, and for following CivitAI's Terms of Service and the law.
- The node is OFF when you place it. Switching it on is your choice. (Workflows saved before the switch existed
  load with it ON, so they keep working the way they always did.)
- Read and edit civitai_compliance_remove.txt yourself (one term per line, # starts a comment).

LC123 / lonecatone23. MIT-licensed pack tooling, provided as is, without warranty. Not affiliated with CivitAI.
