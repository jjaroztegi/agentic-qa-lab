# Control room events

Every part of the lab reports to the control room through one endpoint. Pipelines, n8n, agents and tests all use the same contract, defined in `apps/control-room/src/shared/contract.ts`.

```
POST /api/events        one event or an array of up to 5000 (all or nothing)
```

| Field | Required | Notes |
|---|---|---|
| `run` | yes | Run id, up to 200 characters. Events with the same `run` form one run. |
| `source` | yes | `n8n`, `ci`, `agent`, `test` or `lab` |
| `kind` | yes | `run`, `stage`, `agent-line`, `step`, `note`, `result` or `artifact` |
| `stage` | for `kind: stage` | `intake`, `draft`, `pr`, `env`, `agent`, `prove`, `push`, `review`, `merge`, `triage`, `guard`, `report`, `compare` |
| `status` | no | `start`, `ok`, `fail`, `warn`, `info` |
| `title`, `detail` | no | Short text shown in the UI |
| `case`, `pr`, `url` | no | Links the run to a case, a pull request or a page |
| `data` | for `run`, `agent-line`, `step`, `artifact` | Object with kind-specific fields |
| `ts` | no | ISO timestamp; the server time is used when absent |

From a shell, use `tools/emit.mjs`, which never fails its caller and redacts secrets:

```bash
node tools/emit.mjs stage  <run> env start "Isolated environment"
node tools/emit.mjs run    <run> '{"workflow":"author","case":"CP-002"}'
node tools/emit.mjs file   <run> evidence/screen.mp4
claude -p ... --output-format stream-json | node tools/emit.mjs agent <run>
```

Without `QA_EVENTS_URL` it does nothing, so the pipelines run the same with or without a control room.
