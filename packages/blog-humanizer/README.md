# Blog humanizer

Dependency-free CommonJS module for Korean blog editing; Node.js 18+. Copy this entire directory or install it as a local package. Do not copy only SKILL.md. Rules are shared by the module and Codex skill, with no global installation required by the app.

```js
const {humanize} = require('@blogauto/blog-humanizer');
const result = await humanize({article, title, category, tone, protectedTerms:[]}, {
  complete: async (prompt, {signal}) => myModelReturningJson(prompt, signal),
  cacheDir: '/my-app/job-id/humanizer-cache', // optional; isolate per job/user
  signal
});
// result.article, result.changes [{id,before,after}], result.cached, result.version
// Send result.article and result.changes to your existing factual reviewer.
```

One model completion per new input; no internal model retries or research. Unchanged text is a valid result. Changes are applied by block ID, not substring replacement. Title and metadata are not editable. `[SECTION - ...]`, `[IMAGE INSERT - n]` and the `[SECTION - 참고자료]` tail are immutable. Plain blog text also works. List prefixes, numeric tokens, double-quoted text, URLs and caller-supplied protected terms are checked mechanically. These checks do not prove semantic equivalence: the caller must review conditions, negation, names and claims before publication.

Invalid output throws HUMANIZER_INVALID_RESULT without changing the input or caching the bad result. Model errors propagate. The app should preserve the draft and stop only this stage, never restart topic research. Cache keys include rules, version, article and context. Cache files contain private drafts; use the caller's local job lifecycle and do not share between users. No score, statistical report or percentage-based rejection is generated.

After a reviewer requests correction, pass its feedback as `input.revisionInstructions`. This creates a new cache context and tells the editor not to undo the Writer's repair. Even unchanged input requires a fresh completion when review constraints change; rejected edits are not reused. Cache hits on an already edited output retain the original before/after evidence for the final reviewer.

The final reviewer returns `humanizerDecisions: [{id, action: 'keep' | 'restore'}]` for every changed block. Call `applyReview(result.article, result.changes, decisions)` to obtain the final article. The module only applies the reviewer's choices; it does not classify meaning or replace topic-specific phrases. Missing, duplicate or stale decisions fail before publication. The reviewer must judge factuality of the article after its chosen restorations, including any errors already present in the original. A restoration alone does not require a Writer or Humanizer rerun.

The Codex skill can be installed by copying this whole directory to a supported skill location. When used standalone, SKILL.md produces prose; when invoked by the app, the module supplies a strict edit JSON contract. No Electron, account, browser or publishing dependencies.
