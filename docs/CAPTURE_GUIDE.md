# Capture guide: help add meeting rooms and private offices

Phase 1 books hot desks only. The schemas already carry `space_type` (`desk` | `meeting_room` | `private_office`) and anything other than `desk` returns `UNSUPPORTED_SPACE_TYPE`, because nobody has captured the request/response shapes for rooms and offices yet.

If you have a WeWork membership that can book a meeting room or a private office (day office), you can fix that in about fifteen minutes by recording the requests your browser makes and opening an issue. You do not need to write any code.

**You will be booking a real room and spending real credits.** Book something cheap and short, and cancel it afterwards if WeWork lets you. Nobody here can reimburse you.

## What we need

Four requests, in order, from one real booking:

1. **`get-spaces` with room parameters.** `GET /workplaceone/api/spaces/get-spaces?...` as issued when you browse meeting rooms rather than desks. The important part is which parameters change: `type` is `0` for desks, and we need the value (and any extra parameters such as `capacity`, duration, or a room-specific flag) for rooms and offices. Include the full response.
2. **`inventory-details`.** `GET /workplaceone/api/common-booking/inventory-details?...` for the space you are about to book. This is where `kubeSpaceId` comes from, and the parameter names changed in August 2026, so the exact query string matters.
3. **`quote`.** `POST /workplaceone/api/common-booking/quote`, the full request body and response. We need to know which id goes in `SpaceID` for a room, and where the credit cost appears (`grandTotal.creditRatio` for desks).
4. **`booking`.** `POST /workplaceone/api/common-booking/`, the full request body and response. For desks the body contains `SpaceType: 4`; rooms almost certainly differ, along with `MailData`, `LocationType`, and the time fields.

Bonus, if you can get them: the **cancel** request (`POST /common-booking/cancel?...`) for the same booking, and one **upcoming bookings** response (`GET /common-booking/get-app-upcoming-bookings?...`) that contains the room booking, so we can map its fields.

## How to record it

1. Open Chrome (or Edge) and sign in to `https://members.wework.com`.
2. Open DevTools with F12, go to the **Network** tab.
3. Tick **Preserve log**. Leave **Disable cache** on.
4. In the filter box type `workplaceone/api` so only the API calls are captured.
5. Now do the booking in the UI: browse meeting rooms at a location, pick a date and time, open the room, and complete the booking.
6. Right-click anywhere in the request list and choose **Save all as HAR with content** (older Chrome: "Copy all as HAR" and paste into a file).
7. Save it as `capture.har`.

Firefox and Safari can export HAR too; Chrome's filter behaviour is just the easiest to describe.

If you would rather not deal with a HAR at all, "Copy as cURL" on each of the four requests plus the pretty-printed response JSON is equally useful. Redact them the same way.

## Redact it before sharing

A raw HAR contains your access token, your cookies, your email, and your account UUIDs. **Never attach an unredacted HAR to a public issue.** The token in it is live for about 12 hours and is enough to book on your account.

Strip the obvious credentials:

```sh
# headers and cookies
sed -i'' -E 's/("name" *: *"[Aa]uthorization" *, *"value" *: *")[^"]*/\1REDACTED/g' capture.har
sed -i'' -E 's/("name" *: *"[Ww]e[Ww]ork[Aa]uth" *, *"value" *: *")[^"]*/\1REDACTED/g' capture.har
sed -i'' -E 's/("name" *: *"[Cc]ookie" *, *"value" *: *")[^"]*/\1REDACTED/g' capture.har
sed -i'' -E 's/("name" *: *"[Ss]et-[Cc]ookie" *, *"value" *: *")[^"]*/\1REDACTED/g' capture.har

# any JWT that survived elsewhere in the file
sed -i'' -E 's/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/REDACTED.JWT.VALUE/g' capture.har

# bearer tokens in bodies or query strings
sed -i'' -E 's/([Bb]earer )[A-Za-z0-9._~+\/-]{20,}=*/\1REDACTED/g' capture.har

# email addresses
sed -i'' -E 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/redacted@example.com/g' capture.har

# UUIDs: optional, but replace them if you would rather not publish account identifiers.
# This makes every UUID the same value, which loses the "same id appears in two places"
# signal we care about, so prefer the script below if you can.
sed -i'' -E 's/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/00000000-0000-4000-8000-000000000000/g' capture.har
```

On macOS `sed -i''` already works as written; on GNU `sed` use `sed -i -E`.

Consistent UUID replacement, which keeps the cross-references intact (this is what we actually want):

```sh
node -e '
const fs=require("fs");let f=fs.readFileSync("capture.har","utf8"),m=new Map(),n=0;
f=f.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,u=>{
  const k=u.toLowerCase();
  if(!m.has(k))m.set(k,String(++n).padStart(8,"0")+"-0000-4000-8000-000000000000");
  return m.get(k);});
fs.writeFileSync("capture.redacted.har",f);
console.error("mapped "+m.size+" uuids");'
```

Then **read the file** before you post it:

```sh
grep -Eio 'bearer [a-z0-9]{8}|eyJ[a-z0-9_-]{10,}|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}' capture.redacted.har | sort -u
```

That should print nothing. Also skim for your real name, phone number, employer name, and anything in a `MailData` block, since WeWork puts recipient details there. Building names, addresses, and time zones are public and should stay.

## Send it

Open an issue using the **API change / new capability** template (`.github/ISSUE_TEMPLATE/api_change.md`) and include:

- which space type you booked (`meeting_room` or `private_office`) and the city, so we know the `accountType` involved
- the date and time you booked, and your local time zone
- the redacted HAR as an attachment, or the four request/response pairs inline in fenced code blocks
- whether the booking succeeded, and what the UI said the cost was in credits
- the cancel request too, if you made one

If you are comfortable going further, open a PR: drop the redacted responses into `test/fixtures/wework/` (see [CONTRIBUTING.md](../CONTRIBUTING.md#adding-a-fixture)), add a failing test against them, and that is most of the implementation work done.

What happens next: the raw shapes become `src/wework/raw-types.ts` entries and mappers, `space_type` gains a real branch in the booking service, the quote payload grows whatever extra ids rooms need, and `UNSUPPORTED_SPACE_TYPE` stops being returned for that type.

## If you would rather not share a capture

That is fine and reasonable. A description is still useful: which ids the UI sends, whether `type` changes, what the credit cost looked like. Open an issue and say what you saw. Do not send a token to anyone, ever, including maintainers.
