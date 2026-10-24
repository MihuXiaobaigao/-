# Design System: 便读 Biandu

## 1. Visual Theme & Atmosphere

A quiet, local-first research desk for long-form reading on a tablet. The interface should feel composed rather than decorative: warm paper surfaces, crisp ink, one restrained pine accent, and generous separation between the reading text and the tools that act on it. Density is balanced (5/10), structural variance is moderate (6/10), and motion is restrained (3/10) because users may remain in the reader for hours. The interface is asymmetric: a stable navigation rail or bottom navigation frames a focused document column, while optional context appears in a dedicated side panel rather than floating over the text.

The product is a working reading instrument, not a marketing landing page. Every visible element must correspond to a real reading, annotation, translation, dictionary, board, AI, graph, or storage task. Avoid ornamental statistics, invented metrics, and decorative dashboard cards.

## 2. Color Palette & Roles

- **Warm Canvas** (#F3F1EB) — application background and inactive workspace.
- **Paper Surface** (#FFFEFA) — primary reading paper, sheets, and modal surfaces.
- **Soft Surface** (#FAF8F2) — secondary controls, tool docks, and quiet grouped sections.
- **Ink** (#1B2421) — primary text and active navigation; never use pure black.
- **Muted Ink** (#64706B) — metadata, secondary descriptions, and inactive icons.
- **Hairline** (rgba(27, 36, 33, 0.12)) — one-pixel dividers; prefer dividers to card-on-card elevation.
- **Pine Accent** (#2F5E52) — the only accent color; primary actions, current page, selection anchors, focus rings, and graph focus.
- **Pine Wash** (#E5EFEB) — selected navigation, tags, and low-emphasis accent surfaces.
- **Paper Shadow** (rgba(39, 48, 43, 0.08)) — diffuse shadow for the reading sheet and temporary popovers only.
- **Warning Clay** (#A64B3C) — semantic warning or destructive state only; never decorative.

Keep the entire product on this one neutral temperature. Do not introduce blue-gray, purple, neon, glassmorphism, gradients, or multi-color status decoration.

## 3. Typography Rules

- **UI Display:** Outfit with Noto Sans SC fallback. Use 600 weight, tight tracking, controlled scale. Chinese headings must remain compact and calm.
- **UI Body:** Outfit with Noto Sans SC fallback. Minimum 15px on tablets; 16px for form inputs; relaxed 1.55–1.7 line height.
- **Reading Content:** Literata for English and Noto Serif SC for Chinese. Reading typography is the only serif area. Default 19px with 1.78 line height and a 62–68 character measure.
- **Mono:** JetBrains Mono with platform monospace fallback. Use only for page numbers, durations, API endpoints, and technical metadata.
- **Banned:** Inter, Times New Roman, Georgia, Garamond, Palatino, generic browser-default UI fonts, oversized display headings, gradient text, and all-caps slogans.

Typography hierarchy should come from size, weight, and ink contrast. Navigation labels are 14–15px. Page titles are 28–36px in wide layouts and 24–28px in portrait. Reading headings scale with the user’s chosen reading size rather than the application scale.

## 4. Component Stylings

- **Primary Buttons:** Pine fill, Paper Surface text, 12px radius, 48px minimum height. Active state translates down 1px and compresses shadow; no glow.
- **Secondary Buttons:** Paper Surface fill, Hairline border, Ink text. Use icon plus Chinese label when an unfamiliar action needs recognition. Minimum touch target 44x44px.
- **Quiet Icon Controls:** 44px square, 10px radius, transparent until hover or press, then Soft Surface. Never use unlabeled icon-only controls for destructive or AI actions.
- **Reading Toolbar:** Two horizontal bands at most. First band contains navigation, book identity, page, reading settings, selection AI, and knowledge AI. Second band appears only when text is selected and sits below the document, never on top of text.
- **Selection Tray:** Soft Surface bar with clear labels: 解释选段, 翻译, 文字笔记, 新建画板, 询问知识库. Separate visual weight for AI selection versus knowledge AI.
- **Word Card:** Inline paper panel below the selected paragraph. Show word, phonetic, part of speech, Chinese meaning, occurrence count, current sentence, and only the most recent other context. The card must not cover nearby text.
- **Reader Sheet:** Paper Surface, 18–24px radius on detached framing, maximum readable width. In focus mode, remove the page container edge and let the reading column occupy the center.
- **Cards:** Use sparingly. Library book entries may use low-contrast paper cards; dense knowledge and settings pages should use section dividers and negative space. No uniform three-column feature-card rows.
- **Inputs:** Label above field, helper text below, no floating labels. Search fields use a leading search icon. Focus ring uses Pine Accent at 2px and must not shift layout.
- **Loading:** Skeleton lines matching the final text, card, or graph shape. No circular spinners.
- **Empty States:** A quiet paper composition with one clear next action, such as 导入 PDF or 配置模型. Never show empty metric cards.
- **Errors:** Inline, plain-language, and actionable. Keep the original content on screen whenever recovery is possible.

## 5. Layout Principles

- **Wide Landscape (1024–1366px):** 216px navigation rail + fluid main workspace + optional 300–340px context panel. Navigation remains visible. Context panels can collapse to a 48px vertical handle.
- **Portrait and Compact Tablet (< 900px):** bottom navigation with 7 items maximum; hide secondary labels where necessary but keep icons distinct. All multi-column content collapses to one column. Drawers become full-height sheets with a visible close control.
- **Orientation:** landscape and portrait follow the device automatically. Never expose a manual orientation switch; the top status strip carries only the current date and time.
- **Reading Measure:** Center the reading column at 660–760px in wide mode and 86–92% width in portrait. Avoid edge-to-edge long lines.
- **Grid:** Use CSS Grid for shells and asymmetric splits. No percentage-position hacks. Main content max-width 1440px.
- **Spacing:** 8px base rhythm. Main page gutters 28–40px landscape and 18–24px portrait. Separate major zones with 32–48px of space, not nested cards.
- **Safe Areas:** Respect iOS and Android safe-area insets. Full-height shells use `min-height: 100dvh`.
- **No Horizontal Scroll:** The board and graph may have an internally pannable infinite canvas, but the application shell must never overflow horizontally.
- **Touch:** All controls at least 44x44px. Pen users need visible active tool state, pressure-aware strokes, and palm-rejection-safe canvas regions.

## 6. Motion & Interaction

- Use 180–240ms spring-like easing for panel entry and page-level state changes. Reading text itself must never animate while the page is scrolling or translating.
- Animate only transform and opacity. Avoid animating top, left, width, height, blur, or box-shadow.
- Selected words transition to Pine Wash rather than a bright highlighter. Handwriting and drawing strokes render immediately and save in the background.
- Lists stagger by no more than 30ms per item and only on first mount. Re-renders during reading must not replay entrance motion.
- Respect reduced-motion settings. Every interactive control needs a visible pressed state even with motion disabled.

## 7. Screen Architecture

### Library

The library is a book-only shelf. Keep one quiet motto line above the collection and list every local book with cover, title, author, and progress. Use the PDF's real first page as its cover; when that page cannot be rendered yet, show a neutral PDF placeholder rather than invented cover art. Show note and annotation counts as the reading-progress summary, with page position secondary. Clicking a book opens a focused book overview with no navigation rail; that overview shows this book's progress, today's reading time in whole minutes, note and annotation counts, and one 继续阅读 action. Do not repeat statistics, reading tools, or review modules on the shelf.

### Reader

Reached only from a book's 继续阅读 action, never exposed as a separate navigation item. All reading tools, including selection AI, translation, notes, and reading settings, live here rather than on the library or book overview. Keep the reading sheet dominant. Wide mode uses a 216px rail and a compact top command bar. Portrait mode uses a two-row header plus bottom navigation. User-selected text reveals a below-text action tray. Reading settings open as a side sheet, not a centered modal. AI selection and knowledge-base AI are visually distinct.

Foreign-language preparation is explicit and sequential: use the embedded PDF text or OCR for scanned pages as version one, proofread every block into version two while preserving block boundaries and visual regions, then translate version two on the first 译 click and cache each completed page. Insert translations beneath sentences as pages arrive; toggling translation off restores version two. Never spend model calls automatically on reader entry. During work, blur the whole page and show one spinner with a short status; do not use a progress bar. On failure, show a transient plain-language toast naming the cause without echoing the provider payload, and do not leave a fixed error panel.

### Selection AI and Dictionary

Selection AI opens as a context panel with the exact selected quote pinned at the top and a plain conversation below. Dictionary uses a compact word card below the text; the full dictionary page is a searchable two-pane workspace in wide mode and list-to-detail navigation in portrait.

### Annotation Board

An infinite dotted canvas occupies most of the screen. A single compact tool dock contains pen, highlighter, eraser, lasso, text, image, connector, undo, redo, and fit. The board context and recognized handwriting live in a collapsible side inspector. Never cover the canvas center with floating cards.

### Knowledge Base Q&A

The search prompt is the visual anchor. Results show a concise synthesis followed by numbered evidence claims. Each claim has source type, book or note title, page, and a 打开原文 action. A side evidence panel in wide mode becomes a bottom sheet in portrait. Distinguish local-only evidence results from AI-synthesized answers without suggesting unsupported certainty.

### Knowledge Graph

The graph is the dominant workspace, with filters in one row and a detail inspector that opens only when a node is selected. Use one accent family with different node shapes or ring styles for source type; avoid rainbow nodes. Provide fit, zoom, search, and a readable selected-node detail panel with linked evidence.

### Dictionary

Headword, phonetic, part of speech, Chinese definition, count, first source, and all sentence contexts are visible. A primary 开始背诵 action leads to a focused review sheet. Search and filters stay compact. Long definitions use readable line length, not a dense card grid.

### Settings and Model Profiles

Keep the settings page model-first: two visible sections, model profiles and per-feature role bindings. Model profiles are compact rows; the editor appears only when the user chooses 编辑 or 添加模型. Each function row pairs a label and hint with one selector limited to configured models of the same type. Put storage, knowledge processing, semantic index, source cleanup, backup, and restore behind one collapsed 数据与备份 disclosure so the default settings view stays focused. API keys are masked and remain device-local. Avoid decorative cards; use section dividers.

## 8. Responsive Stitch Generation Instructions

Generate every core screen twice when possible: a 1366x1024 landscape tablet composition and a 768x1024 portrait tablet composition. Both variants must preserve the same component language and hierarchy rather than looking like separate products.

Landscape screens must use the persistent left navigation rail. Portrait screens must use the compact bottom navigation. The reader, knowledge answer, graph detail, board inspector, and word card must all have explicit portrait placements. Do not simply scale down the landscape UI.

Use realistic Chinese interface copy and authentic English reading excerpts. Use placeholder values only where the product would normally obtain user data. Do not fabricate statistics, processing times, or accuracy percentages.

## 9. Anti-Patterns (Banned)

- No emojis in the product interface.
- No Inter, Times New Roman, Georgia, Garamond, Palatino, or generic serif dashboard text.
- No pure black (#000000), purple, neon, cyan glow, gradient text, glass blur, or decorative glow shadows.
- No overlapping text, popovers that hide the selected paragraph, or floating tool clusters in the reading column.
- No equal three-column card rows or nested card-on-card surfaces.
- No invented metrics, percentages, reading streaks, response times, or knowledge counts.
- No marketing slogans or AI copywriting clichés.
- No generic fake people, fake book covers that pretend to be real, or fabricated source citations.
- No tiny touch targets, icon-only destructive actions, or horizontal page overflow.
- No sudden full-screen rerenders during reading, drawing, or typing.
