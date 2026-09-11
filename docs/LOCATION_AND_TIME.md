# Location and time rules

WeWork's API is picky about places and clocks, and most of the bugs found in the first live run were about them. These are the rules the code follows. Contributors should keep them true; agents can rely on them.

## Places

1. **A building is identified by its `locationId`**, the UUID WeWork uses. Names and addresses are display text and are never used to route a request.
2. **Every building we see is remembered.** Any listing or search result writes the building's metadata (timezone, current offset, currency, account type, coordinates) to the Durable Object. The write is awaited, because Workers drop unawaited work once the response is sent. This is why a bare `location_id` works in any isolate, on any later day.
3. **Correctness never depends on the server having seen a building.** A city or coordinates search learns every building's zone from WeWork in the same call. A bare `location_id` should come with `timezone`, which `list_locations` returns and the agent already holds. Without it, the first request goes out with `+00:00`; if the results reveal a building in another zone the request is repeated at that offset, and if the first pass is empty the response says so and suggests a city or nearby search. The stored metadata is only an optimisation.
4. **City searches sweep at most ten buildings** per call, in the order WeWork returns them, and only the `limit` roomiest spaces across those buildings are priced, because pricing costs an upstream request each. Coordinates searches use the same fixed bounding box the web app sends and filter by our own great-circle distance in kilometres. WeWork's own `distance` field is in metres and, on a city search, measured from nowhere useful, so it is ignored.
5. **Currency comes from the building**, not the member. A pay-as-you-go account is quoted in the building's currency (GBP in London, USD in New York). The member's home-location currency is only informational.
6. **Eligibility is WeWork's call.** An empty result for a real building usually means the membership cannot book there, not that it is full. The response carries a `note` saying so.

## Clocks

7. **Agents speak building-local time.** Every `start_time`, `end_time`, `startLocal`, `endLocal`, and `cancelDeadlineLocal` is wall-clock time at the building, with the IANA zone alongside. Nothing is ever expressed in the agent's or the operator's own zone.
8. **The requested `date` is the building's calendar date.** A date is "in the past" if it is before today in the building's zone. There is no artificial limit on how far ahead a date may be; WeWork decides how far its inventory opens, and an out-of-window date comes back as an empty result with the note above.
9. **Offsets are computed for the requested date, not for today.** A search in September for a date in December sends the December offset. The same date-specific offset goes into the signed quote and the booking body.
10. **Times are snapped to the 30-minute grid** before anything is sent: starts floor, ends ceil. WeWork rejects anything else.
11. **Requests to WeWork carry UTC instants** (`...T07:30:00Z`) converted from building-local time on the specific date, so daylight-saving transitions are handled by the zone database, not by arithmetic on a stored offset.
12. **WeWork's bookings list is a trap.** Its times are the building's local wall clock with a `Z` stamped on the end. They are re-anchored in the building's zone, never converted. Cancel requests send that local wall clock back without a `Z`.
13. **Quotes are short-lived** (ten minutes) and expire on the UTC clock. An expired quote is refused; the agent searches again.

## What this means for an agent

- Search by city, or by coordinates with a max distance, when the user has not named a building. When they have, pass the building's `location_id` and its `timezone` from the listing.
- Give times as the building sees them. If the user is in another zone, say so when reporting.
- A future date is fine. If it returns nothing, try a nearer date before assuming the building is unavailable.
- Never do timezone arithmetic yourself; the server already did it and every result names its zone.
