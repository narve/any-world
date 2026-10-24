# One malformed request URL crashes the whole server

- **Severity:** critical
- **Area:** server/app.ts
- **Status:** fixed

## Evidence
`handler()` ran `new URL(req.url ?? '/', 'http://local')` before its `try`, and `createServer` called
`void handler(req, res)`. Node's HTTP parser accepts absolute-form request targets, so a raw request such
as `GET http://[ HTTP/1.1` (also `http://a:99999/`, `//[x`) made `new URL` throw `TypeError: Invalid URL`.
That became an unhandled promise rejection, which exits the process on Node 22. One unauthenticated
request could take the server down.

## Fix
- The URL is parsed inside the `try`; a parse failure is answered `400 bad_request` ("Invalid request target").
- `createServer` now attaches a `.catch` to every `handler()` call: it logs (redacted) and answers 500, or
  destroys the socket if headers were already sent, so no future throw can kill the process.

## Regression test
`tests/server/hardening.test.ts` ("answers 400 to invalid absolute-form targets and keeps serving") sends
the three raw targets over a socket, expects 400 each time, no unhandled rejections, and a working
`/api/health` afterwards.
