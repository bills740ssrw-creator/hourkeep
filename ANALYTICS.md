# HourKeep analytics — event interface (no provider configured)

No analytics provider or tracking script is installed. Pages expose a
queue-only interface so events can be wired later without code changes:

```js
window.hkQueue  // array; every tracked event is appended here
window.hkTrack(eventName, props)  // appends {event, props, at}
```

Landing page auto-tracks clicks on any `[data-event]` element, recording
the event name plus the link target. The tracker (`app.js`) calls
`hkTrack()` directly.

## Canonical event names

| Event | When |
|---|---|
| `cta_nav_start`, `cta_hero_start`, `cta_how_start`, `cta_pricing_free` | Landing CTA → tracker clicked |
| `cta_hero_how` | "See how it works" clicked |
| `cta_pricing_pro`, `cta_pricing_team` | Pricing waitlist CTA clicked |
| `waitlist_submit` | (form posts to FormSubmit; track on thank-you page if added) |
| `timer_started` / `timer_stopped` | Tracker timer start/stop |
| `first_timer_started` | First start in this browser (retention signal) |
| `manual_entry_created` / `manual_entry_edited` | Manual entry saved/edited |
| `first_project_created` | First client/project created |
| `onboarding_role` / `onboarding_completed` / `onboarding_skipped` | Onboarding funnel |
| `report_exported` | CSV downloaded (`{format, count}`) |
| `data_exported` | Full JSON backup downloaded |

## Rules for any future provider

- Never send entry descriptions, client/project names, emails, or amounts.
  Props are limited to counts, plan-agnostic flags, and link targets.
- Day-1 / day-7 return must be derived from first-seen timestamp stored
  locally — no fingerprinting, no cross-site identifiers.
- Adding a provider requires a cookie-consent mechanism and a Privacy
  Policy update first (see `privacy.html`, "Analytics and cookies").
