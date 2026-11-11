# Departments: connected groups

A group can be a **department**: #robotics led by robotics-lead, #software led by tech-lead,
#product-design led by design-lead. Connect them (the group's **Departments** button, or
`agentbox group connect #robotics #software`) and their leads work together the way department heads
would. Code: `server/src/departments.ts`.

| | How |
|---|---|
| **Know each other's work** | Every turn, a lead's instructions list each connected department: purpose, lead, live workspaces and their state, open requests. `read_department` gives more (their workspaces and the requests between you, or their latest group conversation); `read_linked_work` reads one of their workspaces in depth (progress, roadmap, conversation, documents). |
| **Ask** | `ask_department(#software, question)`: a turn for software's lead **in #software** (you see the question and the answer there). Their reply comes back to robotics' lead as a report **in #robotics**, where its reply tells you what matters. |
| **Hand work over** | `delegate_to_department(#product-design, title, brief)`: design's lead plans it like your own request (usually a workspace of its crew) and acknowledges at once (that comes back too). When it's done, `report_to_department(request, result)` wakes robotics' lead with the result. `done: false` sends an update. |
| **Requests** | Each ask or handover is a request (open → answered, or accepted → done; failed if the turn failed). The **Departments** tab lists them per group, with the question, the answer or result; `agentbox group departments #g` too. |

Rules the agents follow:
- Only a group's **lead**, in its own group, talks to other departments. The members and workspaces in a
  department ask their lead, as before, who can take it further.
- Only **connected** departments see or reach each other; only you connect or disconnect them.
  Disconnecting stops new requests at once; deleting a group drops its connections.
- Each department still launches work only with its **own crew**: handing work over means the other
  department's lead decides how its people do it.
- Decisions that are yours (spend, access, breaking changes, direction) still come to you, not to
  another department.
- At most 12 connections per group and 10 open requests from one department to another.

## Owner API

`GET /api/groups/:id/departments` (connections with each one's lead and live workspaces; requests in
and out), `POST /api/groups/:id/departments {group_id}`, `DELETE /api/group-connections/:id`,
`GET /api/departments` (every connection). The phone app reads a group's departments (read-only).

## Setting it up

1. Create the agents (robotics-lead, tech-lead, design-lead), ideally each with its crew of specialists.
2. Create a group per department with its lead (`agentbox group new robotics --members robotics-lead --lead robotics-lead`).
3. Connect them: in a group, **Departments → Connect another group**.
4. Talk to a department in its group as usual. Its lead asks or involves the others when it needs to.
