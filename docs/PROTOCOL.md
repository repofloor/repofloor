# Protocol

Source of truth: [`packages/protocol/src/index.ts`](../packages/protocol/src/index.ts). Current version: **1.0.0**.

## Status model

| `ActivityStatus` | Derived from | Rendered as |
|---|---|---|
| `offline` | no event in 2h, or `actor.leave` | dimmed, no icon |
| `idle` | present, no activity in 20 min | slow bob |
| `coding` | push, PR opened/updated, agent edits | typing |
| `reviewing` | review requested / submitted | 🔍 |
| `discussing` | issue/PR comment | 💬 |
| `building` | CI running / agent running tests | ⚙️ spinning |
| `blocked` | CI failed, changes requested | ❗ bouncing + bubble |
| `celebrating` | PR merged (30 s) | jumping + confetti |
| `in_room` | moved into a room / chatted | sits in the room |
| `focus` | moved into a focus room | 🎧, dimmed |

Priority (higher wins while the current status is fresh):
`offline < idle < in_room < discussing < reviewing < coding < building < blocked < focus < celebrating`.

### How priority is applied

For activity updates handled by the reducer's priority check, a fresh status is replaced only when the incoming status has an equal or higher rank. For example, a fresh `reviewing` status can become `coding`, but a fresh `blocked` status stays `blocked` when a lower-ranked `coding` update arrives. That lower-ranked event still advances `lastSeen`.

Freshness is measured from the incoming event timestamp to `lastSeen`: when the gap is greater than 20 minutes, the new activity replaces the old status regardless of rank. Thus, a `coding` update can replace an old `blocked` status after that stale interval. A current `celebrating` status is also replaced by the next priority-checked activity update, even if that update ranks lower. Room and focus moves have their own reducer rules; this table does not override those transitions.

## Event ids

Must be unique and stable per upstream fact so redelivery is idempotent:
- Webhooks: `<X-GitHub-Delivery>:<suffix>`
- Lite REST: `c:<sha>`, `pr:<n>:open|merged`, `i:<n>`, `run:<id>`
- Agents: `<session>:<seq>`

## Versioning

`protocolVersion` is semver. Minor = additive fields (consumers ignore unknown fields).
Major = anything else; consumers reject a different major (`assertOfficeState`).
