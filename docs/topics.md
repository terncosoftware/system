# Topics

Everything a screen shows is a topic: a name, `<provider>:<name>`, plus params
(`@terncosoftware/core/topics`). One `TopicDefinition` answers both a socket
subscription and an HTTP read, and checks `authorize` on every one.

| Kind | Carries | Frames |
|---|---|---|
| `list` | a page of rows, sorted, filtered and searched on the server | `ListFrame` ([list-topics.md](list-topics.md)) |
| `snapshot` | one value: figures, a chart's series, a record | `SnapshotFrame`, the whole value |
| `feed` | items appended newest first | `FeedFrame`, items on top, or `reset` |

## Params

Params are the ids, ranges and zones a tile fills from where it is placed. A
definition names each one `required` or `optional`; `normalizeTopicParams`
drops the rest and refuses a read missing a required one. Tenant never travels
as a param: it comes from the connection.

## Pushing on change

A write that may change what a topic shows publishes `core.topic.changed`
(`TopicChanged`): the topic, the tenant, and any params that narrow it. A
server re-reads each topic address with viewers that `topicChangeReaches`, and
sends a frame only when the version moved:

- a list page read from a store goes out as `listPageFrame(window)`, whose
  version fingerprints the page and its total;
- a snapshot goes out as `snapshotFrame(value)`;
- a feed sends the items after each subscriber's cursor.

## HTTP

`topicReadSearch` and `parseTopicRead` carry a read in a URL: each param is its
own key, a list's query is JSON in `q`, a feed's cursor is `after`. `format` is
kept for exports. A list read answers a `ListWindow`, a snapshot its value, a
feed a `FeedPage`.

## In the browser

`@terncosoftware/dashboards` gives the host one `TopicSource` and tiles three
hooks: `useListTopic`, `useSnapshotTopic` and `useFeedTopic`. `ListTable` draws
rows under sortable headers and turns them into labelled cards in a narrow
container; `ListTile` binds it to a list topic. `MemoryTopicSource` serves all
three kinds from memory for tests and previews.

Tiles have no refresh: a topic keeps every view current. When the host's
connection drops it calls the listener's `reconnecting()`, not `error()`. The
view keeps what it holds, its status reads `reconnecting`, and the next frame
after the host reconnects brings it up to date. `ListTile` says so in a neutral
`role="status"` line, apart from its error slot.
