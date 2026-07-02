# CMDesign ↔ web token reconciliation — 2026-07-02 (Parity WS5)

Mapping of `CertMateUnified/Sources/Views/Components/CertMateDesign.swift` (`enum CMDesign`,
the iOS design source of truth) onto `web/src/app/globals.css` `@theme` +
`web/src/lib/design-tokens.ts`.

**Method (parent WS5 item 1 + plan bullet "map from tokens live views actually
reference"):** for every CMDesign duplicate/superseded token pair, the winner was chosen
by grepping live call sites in `CertMateUnified/Sources` — counts recorded in the notes
column. Verification selectors are what the post-change computed-style spot-check ran
against (Playwright `page.evaluate(getComputedStyle)` / DevTools).

Spacing **keys** are unchanged per the user-confirmed 2026-07-02 decision (KEEP t-shirt
keys + the static `max-w-*` override block at `globals.css:92-147`). No spacing **values**
changed either (web named spacing utilities have zero call sites; the web t-shirt scale is
one step offset from iOS's naming — see the Spacing section notes).

## Colors

| CMDesign token (source line) | Current web token / value | New web token / value | Verification selector | Notes |
|---|---|---|---|---|
| `Colors.brandBlue` = #0066FF (:105) | `--color-brand-blue: #0066ff` | unchanged | `getComputedStyle(document.documentElement).getPropertyValue('--color-brand-blue')` | Already exact. |
| `Colors.brandBlueSoft` = rgb(0.2,0.522,1.0) → #3385FF (:107) | `--color-brand-blue-soft: #3b82f6` | `#3385ff` | same, `--color-brand-blue-soft` | Web had Tailwind blue-500 approximation. |
| `Colors.brandGreen` = #00CC66 (:114) | `--color-brand-green: #00cc66` | unchanged | `--color-brand-green` | Already exact. |
| `Colors.brandGreenSoft` = rgb(0.2,0.867,0.533) → #33DD88 (:116) | `--color-brand-green-soft: #22c55e` | `#33dd88` | `--color-brand-green-soft` | Web had Tailwind green-500 approximation. |
| `Colors.brandBlueDeep` (:109) / `brandGreenDeep` (:118) | — | NOT ported | — | Zero live call sites outside gradient defs; add on demand. |
| `Colors.Green.vibrant` #00E676 (:150) | — (hex hardcoded in section-accents.ts only) | `--color-green-vibrant: #00e676` | `--color-green-vibrant` | New token; primary-action scale. |
| `Colors.Green.standard` #00C853 (:152) | — | `--color-green-standard: #00c853` | `--color-green-standard` | New. |
| `Colors.Green.muted` #00A844 (:154) | — | `--color-green-muted: #00a844` | `--color-green-muted` | New. |
| `Colors.Green.subtle`/`glow` (:156-158) | — | NOT ported as tokens | — | Opacity variants of `vibrant`; expressed at use sites via `color-mix(... 8%/20%)`. |
| `Colors.Blue.vibrant` #2979FF (:166) | — (hex in section-accents.ts) | `--color-blue-vibrant: #2979ff` | `--color-blue-vibrant` | New. |
| `Colors.Blue.standard` #448AFF (:168) | — | `--color-blue-standard: #448aff` | `--color-blue-standard` | New. |
| `Colors.Blue.muted` #1565C0 (:170) | — | `--color-blue-muted: #1565c0` | `--color-blue-muted` | New. |
| `Colors.Elevation.L0` #0A0A0F (:136) | `--color-surface-0: #0a0a0f` | unchanged | `getComputedStyle(document.body).backgroundColor` | Ladder already matched exactly. |
| `Colors.Elevation.L1` #141419 (:138) | `--color-surface-1: #141419` | unchanged | `--color-surface-1` | Match. |
| `Colors.Elevation.L2` #1C1C24 (:140) | `--color-surface-2: #1c1c24` | unchanged | `--color-surface-2` | Match. |
| `Colors.Elevation.L3` #24242E (:142) | `--color-surface-3: #24242e` | unchanged | `--color-surface-3` | Match. |
| — | `--color-surface-4: #2d2d38` | unchanged | — | Web-extra pressed-state step; iOS ladder stops at L3. Deliberate divergence (kept). |
| `Colors.TextColors.primary` #FFFFFF (:198) | `--color-text-primary: #f5f5f7` | `#ffffff` | `getComputedStyle(document.querySelector('h2')).color` | Web had Apple systemGray6-ish off-white. |
| `Colors.TextColors.secondary` #B0B0C0 (:200) | `--color-text-secondary: #a0a0aa` | `#b0b0c0` | `--color-text-secondary` | |
| `Colors.TextColors.tertiary` #6B6B80 (:202) | `--color-text-tertiary: #6e6e78` | `#6b6b80` | `--color-text-tertiary` | |
| `Colors.TextColors.inverse` #0A0A0F (:204) | — | `--color-text-inverse: #0a0a0f` | `--color-text-inverse` | New; text on filled green/blue buttons. |
| — | `--color-text-disabled: #48484f` | unchanged | — | Web-extra (iOS reuses tertiary/neutral for disabled). Kept. |
| `Colors.Status.valid` #00E676 (:182) | `--color-status-done: #30d158` | `#00e676` | `--color-status-done` | Web key `done` ↔ iOS `valid`; keys kept, value moved off Apple system green. |
| `Colors.Status.expiring` #FFB300 (:184) | `--color-status-processing: #ff9f0a` | `#ffb300` | `--color-status-processing` | Key `processing` ↔ iOS `expiring` (amber). |
| `Colors.Status.expired` #FF5252 (:186) | `--color-status-failed: #ff453a` | `#ff5252` | `--color-status-failed` | |
| `Colors.Status.info` #2979FF (:188) | — | covered by `--color-blue-vibrant` | — | Same value; no duplicate token added. |
| `Colors.Status.neutral` #6B6B80 (:190) | `--color-status-pending: #6e6e78` | `#6b6b80` | `--color-status-pending` | |
| `Colors.statusLimitation` = system purple (:82) | `--color-status-limitation: #bf5af2` | unchanged | — | #BF5AF2 IS Apple system purple (dark) — already faithful. |
| Recording states (`recordingActive/Idle/...` :71-75, system colors) | `--color-rec-*` (Apple dark system values) | unchanged | — | iOS uses bare `Color.red/.green/.orange` → dark-mode system values #FF453A/#30D158/#FF9F0A; web tokens already ARE those values. |
| `Colors.Transcript.keywordDark` = system blue (:98) | `--color-transcript-keyword: #3b82f6` | `#0a84ff` | `--color-transcript-keyword` | iOS `Color.blue` dark = #0A84FF; web had Tailwind blue. |
| `Colors.Transcript.valueDark` = system green (:99) | `--color-transcript-value-*` (mixes of #30d158) | unchanged | — | #30D158 is the correct dark system green. |
| Severity c1/c2/c3/fi/ok | `--color-severity-*` | unchanged | — | Mirror iOS status colors already (system dark values). |
| `Colors.SectionAccent.*` (:210-225) | `SECTION_ACCENTS` in `section-accents.ts` | unchanged | `SECTION_ACCENTS.client.stripe` | Already ported verbatim (WS0-verified). |

## Radii

Generic web scale (`--radius-sm/md/lg/xl` = 6/10/14/20) is KEPT for its 258 existing call
sites; iOS component radii are added as **semantic tokens** and the shared components are
switched to them (values below follow the live-call-site winners, not the superseded
duplicates).

| CMDesign token (source line) | Current web | New web token / value | Verification selector | Notes |
|---|---|---|---|---|
| `CornerRadius.inputRedesign` = 12 (:475) | fields use `--radius-md` (10) | `--radius-input: 12px` | `getComputedStyle(input field wrapper).borderRadius` | LIVE input radius: CMFloatingTextField/CMUnitTextField/CMFloatingPicker (102 call sites) all use 12. `CornerRadius.input=10` belongs to `cmTextFieldStyle` (12 call sites) — SKIPPED as the minority recipe; recorded here. |
| `CornerRadius.button` = 14 (:463) | buttons use `--radius-lg` (14) | `--radius-button: 14px` | button el `borderRadius` | Value identical; semantic alias so future card-radius changes don't drag buttons. |
| `CornerRadius.card` = 18 (:461) | `Card` uses `--radius-lg` (14) | `--radius-card: 18px` | `.cm-card` / Card `borderRadius` | 59 call sites incl. `cmCardStyle()` (53 view usages). |
| `CornerRadius.cardRedesign` = 16 (:477) | `SectionCard` uses `--radius-lg` (14) | `--radius-section-card: 16px` | SectionCard `borderRadius` | CMSectionCard (40 call sites) + `cmElevatedCard` use 16 — section cards are 16, generic cards 18. Both mapped; neither skipped. |
| `CornerRadius.heroCard` = 22 (:462) | `HeroHeader` uses `--radius-xl` (20) | `--radius-hero: 22px` | HeroHeader `borderRadius` | |
| `CornerRadius.ctaPill` = 26 (:469) | — | `--radius-cta-pill: 26px` | — | Token added for CTA pills; no current web pill consumer hardcodes 26. |
| `CornerRadius.badge` = 6 (:473) | `--radius-sm: 6px` | unchanged | — | Already equal. |
| `CornerRadius.small/medium/large/pill` (:456-459) | — | NOT ported | — | Generic iOS scale duplicated by the semantic tokens above; skipped to avoid a parallel scale. |

## Spacing

| CMDesign token (source line) | Current web | New web | Verification selector | Notes |
|---|---|---|---|---|
| `Spacing.xxs..xxxxl` (:436-444) | `--spacing-xs..3xl` = 2/4/8/16/24/32/48 | unchanged | — | Web t-shirt keys are one step offset from iOS names (web `xs`=2 ↔ iOS `xxs`; web has no 12 or 20 step). KEYS AND VALUES KEPT — user-confirmed decision 2026-07-02; zero call sites use the named utilities, so a value change buys nothing and a key rename risks the `max-w-*` incident. Offset documented here as the deliberate divergence. |
| `Spacing.cardPadding` = 20 (:447) | `Card` pads `p-4 md:p-6` (16/24) | `Card` pads `p-5` (20px) | Card `padding` | LIVE winner (22 call sites; `cmCardStyle()` pads 20). Component-level change, not a token. |
| `Dimensions.cardPadding` = 16 (:511) | `SectionCard` pads 16 (mobile) / 20 (md) | `SectionCard` pads `p-4` (16px) at all widths | SectionCard `padding` | The single live use of `Dimensions.cardPadding` is CMSectionCard's content padding — so section cards pad 16 while generic cards pad 20. The web md:p-5 upsize was a web-extra; removed for parity. |
| `Spacing.sectionGap` = 28 (:448) | page stacks use `gap-4`/`gap-6` (16/24) | unchanged this wave | — | SKIPPED: 23 iOS call sites are dashboard-layout scoped; retro-fitting every page stack is a layout change beyond token reconciliation. Recorded as an open delta on the ledger row (`crosscutting/cmdesign-token-deltas` notes). |
| `Dimensions.sectionGap` = 24 (:515) | — | — | — | Superseded duplicate, 0 call sites. SKIPPED. |

## Heights

Height tokens in `@theme` had zero utility consumers (components hardcode Tailwind
heights); values updated to iOS and the shared field controls switched onto them.

| CMDesign token (source line) | Current web | New web | Verification selector | Notes |
|---|---|---|---|---|
| `Heights.inputField` = 52 (:487) | `--h-input: 44px`; field controls hardcode `h-14` (56px) | `--h-input: 52px`; field controls `min-h-[var(--h-input)]` | field wrapper `minHeight` | iOS floating fields are 52pt min. |
| `Heights.buttonMedium` = 44 (:491) | `--h-button: 44px` | unchanged | — | Match. |
| `Heights.buttonLarge` = 52 (:493) | — | `--h-button-lg: 52px` | — | New token. |
| `Heights.listRow` = 72 (:485) | — | `--h-list-row: 72px` | — | New token. |
| `Heights.tabBar` = 49 (:497) | `--h-tabbar: 48px` | `49px` | — | iOS standard tab bar height. |
| `Heights.touchTarget` = 44 (:501) | `--h-touch-target: 44px` | unchanged | — | Match. |

## Typography

| CMDesign token (source line) | Current web | New web | Verification selector | Notes |
|---|---|---|---|---|
| SF Pro Rounded scale (`Typography` :9-58) | `--font-rounded` stack | unchanged | `getComputedStyle(document.body).fontFamily` | ui-rounded stack already in place. |
| `Typography.dataValue`/`monoData` (:17/:35) | `--font-mono` + `live-field.tsx` mono path | unchanged | live-field value `fontFamily` | Live iOS mono usage (LiveFillView values, grid data) already mirrored on web. |
| Floating-field label (CMFloatingTextField.swift:70, 12px medium, sentence case, secondary → Green.vibrant focused) | field labels: 11px medium UPPERCASE tertiary | 12px medium sentence-case secondary, green when focused | field `<label>` computed `fontSize`/`textTransform` | iOS-canon floated-label state. `Typography.formLabel` (13-semibold) + `cmFormLabel()` (uppercase recipe): `cmFormLabel` has ZERO live call sites and `formLabel` appears only on LoginView — SKIPPED as the field-control pattern; the uppercase-13-semibold style is NOT what live iOS job forms render. |
| Field value text (`Typography.bodyRegular` = 17pt) | inputs `text-[15px] font-medium` | `text-[17px] font-normal` | input computed `fontSize` | Also fixes the iOS-Safari zoom-on-focus trigger (<16px inputs). iOS value weight is regular. |

## Component recipes verified by measured spot-check (post-change)

- `.cm-card` (glass card): background layers L1 + blue 3% + white-gradient glass; 1px
  directional gradient border; radius `--radius-card`; shadow soft. ↔ `cmCardStyle()`
  (CertMateDesign.swift:636-668).
- SectionCard: bg L1 + `color-mix(blue-vibrant 8%)`, inset 3px accent gradient bar
  (accent → 40%, vertical inset 8px, left inset 4px, radius 1.5px), gradient border
  accent 20%→8%, radius `--radius-section-card`, padding 16. ↔ CMSectionCard.swift:48-108.
- Tab-rail underline: 3px, `linear-gradient(90deg, brand-blue, brand-green)`, radius
  1.5px, blue glow shadow, slides between tabs. ↔ JobDetailView.swift:300-307 +
  `Gradients.tabIndicator` (:332-336).
- Recording pulsing ring: pre-existing `.cm-rec-ring` — unchanged (already ported).
- Focus glow on fields: border → Green.vibrant + 12px green glow @20%.
  ↔ CMFloatingTextField.swift:49-53 + `Dimensions.focusGlowRadius` (:533).
