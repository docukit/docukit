Visit [our website](https://docukit.dev) for documentation and more.

## Error and retry policy

DocSync reports every server response or transport-level request failure
immediately through the `sync` event. `QueryResult.error` has a narrower
meaning: it is set only when DocSync cannot make progress automatically. A
failed attempt does not change the query result while a retry or a newer queued
sync can still succeed.

| Failure or situation                                                        | Automatic policy                                                             | Query result exposed to applications                                                                 |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Server returns `AuthorizationError`                                         | Do not retry because the same request will be rejected again                 | Set `status: "error"` immediately and preserve existing data                                         |
| Server returns `ValidationError`                                            | Do not retry because the request must change first                           | Set `status: "error"` immediately and preserve existing data                                         |
| Server returns `DatabaseError`                                              | Retry eight times with exponential backoff for about 24 seconds              | Keep the current result with `fetchStatus: "fetching"`; set `error` only after retries are exhausted |
| A sync request fails at the transport level                                 | Convert it to `NetworkError` and use the same bounded retry policy           | Keep the current result with `fetchStatus: "fetching"`; set `error` only after retries are exhausted |
| Local storage or a configured local provider throws                         | Do not retry automatically                                                   | Set `status: "error"` immediately; the original error is preserved                                   |
| A document binding throws during sync                                       | Do not retry automatically; rethrow so the programming failure stays visible | Set `status: "error"` immediately unless a newer sync is already queued                              |
| Getting an authentication token fails                                       | Stop the connection attempt                                                  | Set `ConnectionError` immediately with `fetchStatus: "paused"`                                       |
| The server permanently rejects or ends the connection                       | Stop reconnecting automatically                                              | Set `ConnectionError` immediately with `fetchStatus: "paused"`                                       |
| The transport disconnects temporarily while Socket.IO is still reconnecting | Let Socket.IO reconnect; cancel document retry timers until it does          | Preserve `status`, `data`, and any existing `error`; set `fetchStatus: "paused"`                     |
| The application disconnects manually                                        | Do not treat an intentional action as a failure                              | Preserve the result without adding an error; set `fetchStatus: "paused"`                             |

The document retry delays are approximately `300ms`, `600ms`, `1.2s`, `2.4s`,
`4.8s`, then `5s` three times. A successful sync or transport reconnect resets
the retry budget. If a newer sync was queued while an attempt was in flight,
the queued sync runs before the failed attempt can become a terminal query
error.

For user interfaces, treat `error` as actionable and `paused` as potentially
temporary. An application can keep rendering stale data alongside an error and
may delay a connectivity notice to avoid flashing warnings during brief
interruptions. `fetchStatus: "fetching"` means work is active or waiting for a
scheduled retry; it does not by itself distinguish an ordinary sync from a
retry.
