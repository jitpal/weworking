---
name: book-a-desk
description: Search for and book a WeWork hot desk through the weworking MCP server. Use when the user wants to find, reserve, check, or cancel a WeWork desk or coworking space - "book me a desk tomorrow", "is there space at WeWork in Shoreditch on Thursday", "what WeWork bookings do I have", "cancel my desk on Friday", "how many WeWork credits do I have left". Covers the whoami, list_locations, search_availability, create_booking, list_bookings and cancel_booking tools, and enforces the rule that a desk is never booked without showing the cost (credits or cash) and getting an explicit yes. Hot desks only; meeting rooms and private offices are not supported yet. Do not use for generic calendar scheduling or for non-WeWork coworking providers.
---

# Book a WeWork desk

Booking spends the user's real monthly credits. Treat every `create_booking` and `cancel_booking` as an action that needs explicit permission, every time.

Hot desks only. If the user asks for a meeting room or private office, say it is not supported.

## Workflow

1. **Establish state if you do not know it.** If this is the first booking action of the conversation, or anything has failed, call `whoami`. It returns the session state, credit balance, your scopes, the caps, and whether writes are enabled. If `session.state` is `none` or `expired`, stop and follow the reconnect rule below. If `writeEnabled` is false or your scopes lack `write`, you can still search. Say up front that you will not be able to complete the booking.
2. **Resolve the location only if the user named a building.** For "a desk in London" or "near this address", skip straight to searching by `city` or by `lat`/`lng` with `radius_km`. When they name a building, find its `location_id` and `timezone` with `list_locations`, or use `homeLocationId` from `whoami`. If several buildings plausibly match, ask rather than guess.
3. **Search.** Call `search_availability` with `city`, or `lat`/`lng` (nearest first), or `location_id` plus `timezone`, together with `date` and optional `start_time`/`end_time` in the building's local time. Default to a full working day only if the user did not say; if they said "the morning", use 09:00-13:00. Each result carries an opaque signed `quote`.
4. **Show the user the options.** Present at most three to five, each with: building name, space name, the date and **local** start/end times, the **cost** (credits, or the cash price with currency for pay-as-you-go accounts), and seats remaining. Never present a booking option without its cost. If the summary says "price unavailable", say so and let the user decide whether to search again.
5. **Get an explicit yes.** Ask which one, and wait for a clear confirmation of that specific option. "Yes", "book the first one", "do it" after you listed a specific desk all count. Silence, "sounds good" about something else, or an inferred preference do not.
6. **Book.** Call `create_booking` with the `quote` string from that exact result, copied verbatim, plus an `idempotency_key` (any unique string, e.g. a UUID). Pass `dry_run: true` first if the user asked what would happen, if you are near a cap, or if anything about the request was ambiguous - then repeat without `dry_run` once they confirm. Never re-run a real booking after a timeout or an unclear result; call `list_bookings` to see whether it landed.
7. **Report.** Give the booking id, the building, the local date and times, the credits charged, and the free-cancellation deadline (`cancelDeadlineLocal`). Mention remaining caps if one is now exhausted.

For "what do I have booked", just call `list_bookings`. For cancelling, call `list_bookings` first, confirm which booking by id and date with the user, then `cancel_booking`; tell them whether credits were refunded, since cancelling after the deadline usually refunds nothing.

## Rules

- **Never book without showing the cost and getting a yes.** No exceptions, no "I assumed", no booking as a side effect of another request.
- **One desk per day** unless the user explicitly asks for more. Do not book the same day twice, and do not book a range of days from a single "book me a desk" request - confirm the list first.
- **Prefer the user's home or favourite location.** Use `homeLocationId` from `whoami` as the default when they did not name a building, and say which one you chose.
- **Never ask for WeWork passwords or tokens in chat.** Do not accept them if offered; if the user pastes one, tell them not to, tell them to rotate it by signing out on `members.wework.com`, and do not repeat it back. Credentials go to the Worker's `/admin/connect` page in a browser, nowhere else.
- **On `SESSION_MISSING` or `SESSION_EXPIRED`**, stop and tell the user the deployment needs reconnecting: open `<worker-url>/admin/connect`, sign in with the admin password, and paste a fresh session from `members.wework.com`. The error's `hint` contains the exact URL. Do not retry until they say they have done it.
- **On `CAP_EXCEEDED`**, stop and explain the cap in plain terms ("this deployment allows one booking per day and you have used it"). The cap is a deliberate safety limit set by whoever deployed the Worker, changeable in `wrangler.jsonc`. Do not look for a way around it.
- **Times are local to the building.** Always quote local times to the user and never convert them into the user's own time zone without saying so. Future dates are fine; if a future date returns nothing, try a nearer one before concluding the building is unavailable.
- **Quotes are opaque and short-lived** (about 10 minutes). Never edit one, never reuse one from an earlier search, never try to construct one. If it expired, search again.
- **Never retry a failed booking automatically.** Reads are safe to retry once; writes are not.

## Errors

| Code | What it means | Do |
| --- | --- | --- |
| `SESSION_MISSING` | no WeWork session stored | send the user to `<worker>/admin/connect`; stop |
| `SESSION_EXPIRED` | session expired, refresh failed | same; stop |
| `UPSTREAM_BLOCKED` | Auth0 bot-check blocked automatic login | will not clear on retry; tell the user to reconnect at `/admin/connect` |
| `UPSTREAM_AUTH` | WeWork rejected the stored token | tell the user to reconnect; stop |
| `UPSTREAM_RATE_LIMITED` | WeWork returned 429 | wait, then at most one retry; never loop |
| `UPSTREAM_ERROR` | upstream failure | one retry for a read, none for a booking; then report |
| `QUOTE_EXPIRED` | quote older than ten minutes | re-run `search_availability`, re-confirm if the price changed, book again |
| `QUOTE_INVALID` | quote was altered or is from elsewhere | re-run `search_availability` and copy the quote exactly |
| `CAP_EXCEEDED` | daily/weekly cap or credit ceiling hit | explain the cap; stop |
| `NOT_AVAILABLE` | the desk went while you were asking | search again and offer the new options |
| `BOOKING_REFUSED` | WeWork refused (credits, policy, overlap) | nothing was charged; report the reason; do not retry blindly |
| `WRITE_DISABLED` | the deployment is read-only | searching still works; say booking is switched off |
| `FORBIDDEN_SCOPE` | the credential lacks `write` | say so; a human must mint a `read,write` key at `/admin/keys` |
| `UNAUTHORIZED` | bad or missing credential | the client config is wrong; a human must fix it |
| `UNSUPPORTED_SPACE_TYPE` | rooms and offices are not implemented | hot desks only |
| `NOT_FOUND` | unknown booking or location id | re-list and use a returned id |
| `VALIDATION` | bad arguments | fix the arguments from `message` and retry once |

Every error includes a `hint` written for you. Follow it, and pass its substance to the user instead of showing raw error codes.
