# Public legal corpus

These six files are the public-facing compliance documents served from
`/legal/<slug>` on certmate.uk. They are **copies**; the source of truth
lives at `.planning/compliance/` at the monorepo root.

| Public file | Source of truth |
| --- | --- |
| `privacy-policy.md` | `.planning/compliance/privacy-policy.md` |
| `cookie-policy.md` | `.planning/compliance/cookie-policy.md` |
| `sub-processors.md` | `.planning/compliance/sub-processors.md` |
| `acceptable-use-policy.md` | `.planning/compliance/acceptable-use-policy.md` |
| `beta-tester-agreement.md` | `.planning/compliance/beta-tester-agreement.md` |
| `door-script.md` | `.planning/compliance/door-script.md` |

Every claim in these docs ultimately traces back to
`.planning/compliance/facts.md`. **Always update `facts.md` first**, then
propagate downstream into the relevant doc here, in the same commit.

If you edit a public file directly, you've created drift — fix it by
editing the source and copying back over the top.

This README is **not** routed: `app/legal/[doc]/page.tsx` only serves
files whose slug appears in its `DOCS` allowlist.
