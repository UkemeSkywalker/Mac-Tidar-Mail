---
name: Mac Tidar Mail
colors:
  surface: '#f9faf1'
  surface-dim: '#d9dbd2'
  surface-bright: '#f9faf1'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f3f4ec'
  surface-container: '#edefe6'
  surface-container-high: '#e7e9e0'
  surface-container-highest: '#e2e3db'
  on-surface: '#191c17'
  on-surface-variant: '#3f4943'
  inverse-surface: '#2e312c'
  inverse-on-surface: '#f0f2e9'
  outline: '#6f7973'
  outline-variant: '#bfc9c1'
  surface-tint: '#206a4d'
  primary: '#005237'
  on-primary: '#ffffff'
  primary-container: '#216b4d'
  on-primary-container: '#a0e9c3'
  inverse-primary: '#8dd5b1'
  secondary: '#046c48'
  on-secondary: '#ffffff'
  secondary-container: '#9bf2c4'
  on-secondary-container: '#0f714c'
  tertiary: '#464845'
  on-tertiary: '#ffffff'
  tertiary-container: '#5e5f5c'
  on-tertiary-container: '#d9d9d5'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#a9f2cc'
  primary-fixed-dim: '#8dd5b1'
  on-primary-fixed: '#002114'
  on-primary-fixed-variant: '#005237'
  secondary-fixed: '#9ef4c6'
  secondary-fixed-dim: '#82d8ab'
  on-secondary-fixed: '#002113'
  on-secondary-fixed-variant: '#005235'
  tertiary-fixed: '#e2e3df'
  tertiary-fixed-dim: '#c6c7c3'
  on-tertiary-fixed: '#1a1c1a'
  on-tertiary-fixed-variant: '#454745'
  background: '#f9faf1'
  on-background: '#191c17'
  surface-variant: '#e2e3db'
typography:
  display:
    fontFamily: Geist
    fontSize: 32px
    fontWeight: '600'
    lineHeight: 40px
    letterSpacing: -0.025em
  headline-lg:
    fontFamily: Geist
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
    letterSpacing: -0.02em
  headline-lg-mobile:
    fontFamily: Geist
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
    letterSpacing: -0.015em
  headline-md:
    fontFamily: Geist
    fontSize: 18px
    fontWeight: '500'
    lineHeight: 24px
    letterSpacing: -0.015em
  headline-sm:
    fontFamily: Geist
    fontSize: 15px
    fontWeight: '500'
    lineHeight: 20px
    letterSpacing: -0.01em
  body-lg:
    fontFamily: Inter
    fontSize: 15px
    fontWeight: '400'
    lineHeight: 24px
    letterSpacing: -0.005em
  body-md:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 20px
    letterSpacing: 0em
  body-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
    letterSpacing: 0.005em
  label-md:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
    letterSpacing: 0.01em
  label-sm:
    fontFamily: Inter
    fontSize: 11px
    fontWeight: '500'
    lineHeight: 14px
    letterSpacing: 0.02em
  code-shortcut:
    fontFamily: Geist
    fontSize: 11px
    fontWeight: '500'
    lineHeight: 12px
    letterSpacing: 0.05em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  gutter: 0.75rem
  gutter-md: 1rem
  gutter-lg: 1.5rem
  margin: 1rem
  margin-md: 1.5rem
  margin-lg: 2rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 0.75rem
  space-lg: 1.25rem
  space-xl: 2rem
---

## Brand & Style

This design system expresses a focused, ultra-responsive email productivity environment calibrated for executives, engineers, and power users who view their inbox as an operational command center. It bridges the kinetic precision of high-velocity issue trackers with the typographical grace of editorial publishing suites. 

### Design Movements & Aesthetics
- **Minimalist Kinetic Precision:** Surface ornamentation is stripped down to maximize cognitive bandwidth. Visual interest originates entirely from rhythmic typographic contrast, strict grid alignment, and micro-delight transitions.
- **Surface Elevation Hierarchy:** Interfaces do not rely on aggressive drop shadows. Instead, depth is structured through subtle surface tonal steps and structural micro-borders, creating an architectural workspace suited for high-density workflows.
- **Keyboard-First Utility:** The tactile feedback patterns evoke vintage mechanical clarity mixed with modern desktop ergonomics: tight element hit targets, explicit shortcut cueing, and instantaneous visual state responses.

## Colors

The palette leverages calibrated neutral slates and dark forest undertones to preserve visual endurance over long sessions, accented by a disciplined deep green and vibrant mint spectrum.

### Theme Modes & Structure
- **Light Mode Canvas:** Foundation sits on pure `#ffffff` with structural sidebars and navigation panels shifting to subtle wash. Divider rules and boundaries strictly utilize consistent stroke width.
- **Dark Mode Canvas:** Base workspace transitions to deep dark neutral (`#161914`), while floating overlays, context panes, and thread rows sit on tailored elevated surfaces. Perimeter separation lines rely uniformly on structural outlines.
- **Accent Cadence:**
  - **Forest Green (`#216B4D`):** Primary action buttons, keyboard focus rings, active thread selections, and unread marker indicators.
  - **Mint (`#8CE2B5`):** Secondary containers, vivid highlights, and supportive UI blocks.
  - **Light Neutral Wash (`#F8F8F4`):** Tertiary surfaces, badges, and background containers.

## Typography

The typographic architecture balances technical rigor with high-density scannability. Geist provides crisp geometric authority for display headers, operational metrics, and shortcut badges, while Inter delivers flawless optical legibility across multi-paragraph email threads and data lists.

### Implementation Guidelines
- **Tabular Figures:** All metadata listings (timestamps, thread counters, unread figures) must enforce `font-variant-numeric: tabular-nums` to maintain vertical alignment down dense lists.
- **Optical Hierarchy:** Thread subjects utilize `headline-sm` with a weight of `500` for unread states, dropping to `body-md` at weight `400` once marked read.
- **Keyboard Badging:** Keyboard shortcut glyphs employ `code-shortcut` set entirely in uppercase with increased tracking to ensure legibility when housed inside compact modifier badges.

## Layout & Spacing

This design system uses an adjustable 3-pane responsive desktop grid that condenses systematically to 2-pane on tablet and a single-stack master-detail layout on mobile.

### Grid Anatomy
- **Desktop (>= 1280px):**
  - **Left Rail (System & Labels):** Fixed `240px` width. Collapsible via shortcut to a `56px` icon-only anchor.
  - **Middle Pane (Thread Feed):** Fluid width with a minimum of `380px` and maximum of `480px`.
  - **Right Pane (Reading & Editor Canvas):** Flexible remainder filling `100%` remaining viewport width, with thread content constrained to a `720px` reading container.
- **Tablet (768px – 1279px):** Left rail transforms into a floating overlay drawer triggered via keyboard or gesture. Feed and thread reader split `40% / 60%`.
- **Mobile (< 768px):** View transitions into a sequential drill-down hierarchy: Inbox Feed view fills `100vw`; thread selection shifts the viewport to a full-bleed Reading Pane with native back gesture support.
- **Rhythm Principle:** Internal component margins and vertical row heights remain anchored to `36px` compact rows for high-density efficiency, or `44px` for touch-friendly interfaces.

## Elevation & Depth

Visual hierarchy relies on structural planes and directional ambient dissipation rather than heavy drop shadows. Surfaces feel machined, matte, and precise.

### Layer Hierarchy
1. **Canvas (Level 0):** Pure base canvas (`#ffffff` light / `#161914` dark). Flat surface for background canvas and collapsed sidebars.
2. **Structural Panels (Level 1):** Delimited entirely by a `1px` border. No blur or shadow; segregation is structural.
3. **Floating Overlays & Context Menus (Level 2):** Hovering popovers, autocomplete dropdowns, and flyouts. Supported by an ultra-fine shadow.
4. **Command Palette & Modal Dialogs (Level 3):** Backdrop utilizes a hardware-accelerated frost filter over a semi-transparent scrim.

## Shapes

The design system enforces a soft, modern geometry (Level 1: `0.25rem` / `4px` base) that reinforces systematic precision without sharp brutality.

### Geometry Specifications
- **Controls & Small Badges (`rounded-sm` / `4px`):** Used for keyboard shortcut badges, thread check boxes, status dots, and inline tags.
- **Inputs & Row Containers (`rounded-md` / `6px`):** Form inputs, action buttons, thread list selection envelopes, and search bars.
- **Floating Modals & Cards (`rounded-lg` / `8px`):** Command palette, flyout sheets, rich message cards, and toast alerts.
- **Pill Exception (`rounded-full`):** Reserved exclusively for avatar silhouettes, live recording/online status badges, and floating bottom quick-action indicators.

## Components

### Buttons
- **Primary:** Solid `#216B4D` fill with white text. Subtle hover brightness shift of `+5%`. Height `32px` for toolbar, `28px` for inline context actions. Inner padding: `0 12px`.
- **Secondary / Ghost:** Transparent background with subtle structural border. Hover produces a muted wash.
- **Shortcut Anchor:** Every secondary and ghost button incorporates an optional right-aligned `<kbd>` container displaying the key binding (e.g., `E`, `⌘K`).

### Command Palette
- Centered overlay positioned `15vh` from top edge, width `640px`.
- Embedded instant search input at the top (`headline-md`) without native outlines, separated by a `1px` horizontal border.
- Filtered item list with category dividers (Actions, Navigation, Labels).
- Active item highlight uses a forest green accent wash with a `2px` left border marker.

### Thread Feed Item (List Row)
- Layout: 3-column inline flex: Sender Identity (width `180px`), Subject & Snippet Preview (flex-1), Timestamp & Flags (width `100px`, right-aligned).
- Active/Selected State: Full row highlight using a soft slate tone and a `2px` solid forest green inset border on the leading left edge.
- Unread Indicator: An unread thread renders the sender and subject in `headline-sm` weight `500`, accompanied by a `6px` solid `#216B4D` dot positioned `8px` left of the sender name.

### Chips & Badges
- **Status Chips:** Low-saturation backgrounds with high-contrast text. 
  - Neutral tag: Soft background with muted text.
  - Starred: Transparent background with accent fill icon.
- **Keyboard Badges:** Background `#ffffff` (light) with `1px` structural border. Monospace-styled font `11px`, padding `1px 4px`, radius `3px`.

### Inputs & Composer Fields
- Height `36px` for standard single-line fields. In composer mode, borderless expansive fields with subtle placeholder typography.
- Focus State: Zero outline glow; focus is represented exclusively by border color transition to `#216B4D` and a crisp `1px` inner shadow.

### Checkboxes & Selection Controls
- Compact dimensions: `14px x 14px`, radius `3px`.
- Border `1.5px` solid neutral. 
- Checked state: Smooth morph into solid `#216B4D` fill containing a crisp white vector checkmark.