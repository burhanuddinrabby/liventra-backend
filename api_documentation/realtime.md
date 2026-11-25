# Liventra Backend — Request ids, realtime and jobs

## Request id

Every response has `X-Request-Id: REQ-YYYYMMDD-xxxxxxxx` (UTC day; a client-sent id is ignored). Errors are logged with
it. The log has no query string or body. Browsers may read `X-Request-Id` and `Content-Disposition` (CORS).

## Socket.IO

Same origin as the API, default path `/socket.io`.

```ts
io("http://localhost:5000", { auth: { token: accessToken } });
```

- Only the access token in `auth.token`; cookies and query strings are not accepted. The account must be active.
- A refused handshake is a `connect_error` with `error.data.code`: `UNAUTHORIZED` (do not retry with this token) or
  `UNAVAILABLE` (retry later).
- The server disconnects the socket at token expiry, when the account is disabled or deleted, and when its platform
  role changes (the client may reconnect and is checked again).
- Messages are small hints (ids, type, status). Fetch details through REST; never depend on receiving a message.

| Direction | Event | Payload | Notes |
|---|---|---|---|
| automatic | – | – | every socket joins its own `user:<_id>` room |
| client → server | `audit.subscribe` | `{ farmId }` (`_id` or `FARM-00001`) + ack | Owner / Manager; ack `{ ok, farmId?, message? }` |
| client → server | `audit.unsubscribe` | `{ farmId }` (the `_id` from the ack) | |
| server → client | `audit.revoked` | `{ farmId }` | membership changed; subscribe again if still wanted |

`audit.created` arrives with plan 3, `notification.created` with plan 4.

Server helpers (`src/app/realtime/realtime.ts`), never throw, call **after commit**: `emitToUser`, `emitToAuditRoom`,
`removeUserFromFarm`, `closeFarmRooms`, `disconnectUser`. One backend process only: more need a Redis adapter.

## Jobs (`src/app/jobs/`)

- Add a job to the list in `scheduler.ts`. Schedules are in `APP_TIMEZONE`, one minute or coarser.
- `runJob` uses the `joblocks` collection: one start per tick across processes, the lease is renewed while working,
  errors are caught and stored in `lastResult`.
- `forEachActiveFarm` walks Active farms in batches and isolates failures.

## Environment

| Variable | Default when missing |
|---|---|
| `CLIENT_ORIGINS` (comma separated) | any origin; none in production |
| `APP_TIMEZONE` | `Asia/Dhaka` |
| `JOBS_ENABLED` | off |
| `TRUST_PROXY` (proxies in front) | `0` |
