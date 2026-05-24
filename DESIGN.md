Act as a Senior Frontend Engineer and Expert UI Designer.
Your task is to code a complete Landing Page on the first attempt.
- Landing Page Theme: <INSERT THEME>
- Sections to add: <INSERT SECTIONS>

Generate the final code immediately following these definitions:

## Style

- **Name:** Portfolio Dev Full-Stack
- **Type:** Minimal, Dark, Professional
- **Keywords:** developer portfolio, full-stack, projects gallery, clean layout, minimal, dark and cyan, code, tech stack, personal brand
- **Era:** 2020s Developer
- **Light/Dark:** ✗ No / ✓ Full

## Color Palette

- **Primary:** Black #000000, Dark Grey #1A1A1A, Cyan #00BCD4
- **Secondary:** White #FFFFFF, Light Grey #E0E0E0, Charcoal #333333

## Visual Effects

Layout duas colunas desktop (bio/projetos), cards de projetos com tech stack badges, hover com underline animado e escala suave, CSS grid/flex para galeria.

## AI Visual Direction

developer portfolio, full-stack, projects gallery, clean layout, minimal, dark and cyan, code, tech stack, personal brand.

## CSS Technical

```css
background: #1A1A1A, color: #FFFFFF, border-radius: 8px, box-shadow: 0 2px 10px rgba(0,0,0,0.3), font-family: 'JetBrains Mono, monospace', accent color: #00BCD4, animated underline on hover, tech badges with border.
```

## Design System Variables

```css
--black: #000000, --dark-bg: #1A1A1A, --cyan: #00BCD4, --white: #FFFFFF, --radius-card: 8px, --font-dev: 'JetBrains Mono, monospace'.
```

## Implementation Checklist

- ☐ Navbar + Hero (bio + CTA), ☐ Projetos + Stack/Skills, ☐ Experiência + Depoimentos, ☐ CTA 'Fale comigo', ☐ Meta tags SEO, ☐ Background escuro legível, ☐ Microinterações discretas, ☐ Ícones SVG (Git, terminal, frameworks).

## Execution Rules

1. Strictly follow the defined visual style.
2. Use high-quality inline SVG icons (Heroicons or Lucide style) — NEVER use emojis as icons.
3. Add `cursor-pointer` and smooth `hover` states (transition-all) on all interactive elements.
4. Required Page Structure:
   - Navbar (Logo + Links + CTA)
   - Hero Section (Impactful Headline + Subtitle + 2 buttons + 3D/Abstract visual element via CSS)
   - Features (3 cards with icons)
   - Testimonials (3 cards)
   - Pricing (3 tiers, highlight the middle one)
   - Final CTA
   - Full Footer with social links, privacy policy, terms of use, contact and SEO links.
5. All text content must be in English.
6. The visual must be CLEARLY distinct — do not create a "default Bootstrap" design. Force the use of the provided design system variables.
7. Use `<style>` tags in the head for custom classes (especially for complex backdrop-filter effects and animations) that Tailwind CDN doesn't cover.
8. Full Responsiveness: Layout must adapt perfectly to Mobile, Tablet and Desktop (vertical stack on mobile).
9. Include basic SEO, Viewport and Open Graph meta tags in `<head>`.
10. Footer must contain: Copyright 2026, Secondary navigation links and Social media icons.
11. Make the creative decisions needed to deliver the complete, functional result now.
