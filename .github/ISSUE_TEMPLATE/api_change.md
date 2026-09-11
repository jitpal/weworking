---
name: API change / new capability
about: A WeWork endpoint changed, or you captured requests for a space type we do not support yet
title: "api: "
labels: upstream-api
---

<!--
READ THIS FIRST.

A raw HAR file contains your access token, your cookies, your email, and your account UUIDs.
NEVER attach an unredacted HAR to a public issue.

docs/CAPTURE_GUIDE.md has copy-pasteable sed and node commands that redact
Authorization, WeWorkAuth, Cookie, JWTs, emails, and UUIDs. Run them, then read the
file yourself before attaching it. Building names, addresses and time zones are public
and should stay; names, emails, phone numbers and MailData recipients must go.
-->

## Type of change

- [ ] An endpoint we use changed (renamed parameter, new required field, different response shape)
- [ ] An endpoint we use was removed or now 404s / 403s
- [ ] Capture for a space type we do not support yet (meeting room / private office)
- [ ] Other

## What broke, or what is new

## Error code observed

<!-- Usually UPSTREAM_ERROR or UPSTREAM_AUTH. Include the error envelope, redacted. -->

## Endpoint(s) involved

<!-- e.g. GET /workplaceone/api/common-booking/inventory-details -->

## When you noticed it

Date observed (UTC):
Last known working date, if you know it:

## Context

- City / country, and the location's `accountType` if you know it:
- Space type (`desk`, `meeting_room`, `private_office`):
- Membership type (All Access, On Demand, team account, ...):
- Client used to capture (Chrome on members.wework.com, the iOS app, ...):

## Redacted capture

<!-- Attach capture.redacted.har, or paste request/response pairs below.
     For a new space type we need four: get-spaces (with room params),
     inventory-details, quote, booking. See docs/CAPTURE_GUIDE.md. -->

### Request

```http

```

### Response

```json

```

## Redaction checklist

- [ ] `Authorization`, `WeWorkAuth`, `Cookie`, `Set-Cookie` values replaced
- [ ] No `eyJ...` JWTs anywhere in the file
- [ ] Email addresses, real names and phone numbers replaced
- [ ] `MailData` / recipient blocks checked
- [ ] UUIDs replaced (consistently, if you used the node snippet)
- [ ] I opened the file and read it before attaching it

## Anything else

<!-- If you are willing, a PR adding the redacted responses to test/fixtures/wework/
     plus a failing test is most of the work. See CONTRIBUTING.md. -->
