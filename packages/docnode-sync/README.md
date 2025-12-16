# DocNode Sync Engine Documentation

## Architecture Overview

The sync engine follows this flow:

              ┌─────────────┐     ┌────────────┐     ┌────────┐     ┌────────────┐

user input -> │ Main thread │ <-> │ IndexedDB\* │ <-> │ Server │ <-> │ Central DB │
└─────────────┘ └────────────┘ └────────┘ └────────────┘

I may explore alternatives to reduce latency in RTC situations. For example, the order of IndexedDB and Server could be changed, or some things could be done at times from the main thread. I am skeptical that this will happen, because this unidirectional flow provides a much simpler and easier to implement thinking framework.

\*Note: future versions may include SQLite as an alternative or replacement for the IndexedDB provider.

## Why Shared Worker or a Similar Step?

Goals:

- Cross-tab synchronization
- Single websocket connection.
  - This shouldn't be so important. Different tabs can be "listening to different documents." The technical complexity of implementing or even installing software for DocNode users might not be worthwhile.

Conslusion
I will divide the development into the following milestones:

1. No tab synchronization:

   ┌─────────────┐ ┌───────────┐ ┌────────┐ ┌────────────┐
   │ Main thread │ <-> │ IndexedDB\*│ <-> │ Server │ <-> │ Central DB │
   └─────────────┘ └───────────┘ └────────┘ └────────────┘

   - I need to ensure that two tabs cannot store new operations without having the latest version of the document.

2. Add broadcast channel:
   - Option 1: pass the operations on to the other tabs for them to apply. I should prevent the operation from being sent to indexedDB twice. This option would involve sending a lot of potentially unnecessary information between tabs and threads (perhaps the other tab isn't even using that doc).
   - Option 2: notify to the other tabs that there have been changes to that document, so that if they have it open, they can update it from indexedDB. This option would not allow an “InMemoryClientProvider,” but if someone did not want to persist in indexedDB (server-first RTC app), they could clear indexedDB and use it only as the communication channel.
   - It is simpler than a Shared Worker or Service Worker because it does not require a separate file.
3. If I see that it can significantly reduce the server load, I'll evaluate SharedWorkers or ServiceWorkers.
   - As I said above, this would in no way help with cross-tab synchronization. The worker would have to propagate the operations so that the other tabs could apply them anyway. The only advantage it could offer is that if two tabs have the same document open, the server would not have to propagate changes to two clients, but only to one. But it seems like overkill for very little gain. And now that I think about it, the server could use a lead tab strategy in those cases (also probably overkill).

## Cross-tab synchronization

Options evaluated:

- Shared worker:
- Service worker:
  - Important: Regarding maintaining open Service Workers connections
  - https://groups.google.com/a/chromium.org/g/chromium-extensions/c/xjOMOpsBsdw
  - https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers#keep-sw-alive
- Broadcast channel:
- None (receive from the server)

## Document Categories

When a user connects to the app, their documents can be divided into 3 groups based on concurrent user activity.

### A. Multiple Active Users

- Scenario: There is at least one other user editing the same document.
- When the user requests the document for the first time, he pulls the entire document (because his local copy may be out of date),
- But after that we want the server to propagate the operations of any user, without them having having to pull the entire document (which would increase latency and data over the wire).

### B. Single Active Users

- Scenario: There is no other user connected to the network and using the same document at that time.
- As in group A, When the user requests the document for the first time, he pulls the entire document (because his local copy may be out of date),
- The difference is that the server does not need to squash and merge operations eagerly, nor return them to the user. Squash and merge operations can be postponed when a user pulls, and potentially also at debounced intervals.

### C. No Active Users

- Scenario: When the client connects to the app, it is possible that documents he did not request may be out of date in his local copy, either because they were modified by another user or on another device, or because local data was lost.
- This category is not as important as the other two. If we do nothing with these, when the user does request it, he will do a lazy pull with the logic implemented for the other two categories of documents. It is very likely that by that time in many cases he will have a full or partial copy of the document locally, making the request fast.
- However, due to possible connection failures or cold requests (i.e., without an up-to-date local copy), it would be ideal to perform eagerly pulls in the background.
- It would be possible to build an architecture on the server that synchronizes the 3 categories at the same time. The problem is that the prioritization and management of the queue becomes very complex, and the server would have to keep in memory too much information for each connected user (an index of all the user's documents and the last version he has).
- That is why we split the architecture of the sync engine in two parts:
  1. Real-time mechanism (Categories A & B)
     - No polling required
     - Direct operation handling
  2. Background thread (Category C)
     - Polling-based updates
     - Low priority, high interval
- Other observations:
  - Decoupling category C to a separate process would also allow us to do document-based sharding.
  - It is good for the user to have an indicator of which documents are being updated in the background. We could use a polling interval of about 2 minutes when the user is connected, and 1 h when not in a service worker.
