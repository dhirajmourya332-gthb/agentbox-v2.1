# Onshape integration

Agents upload the CAD models they make into the owner's Onshape for review: one **private document per
part**, a **tab per version** (Onshape translates the STEP into a Part Studio), and an **Onshape version**
saved per upload so the owner can compare. The owner opens the link the agent sends, measures, sections
and comments.

| Piece | Where |
|---|---|
| The integration (Integrations → Design & CAD → Onshape) | `setup/modules/onshape/` (settings, the key step, verify) |
| The agents' tool | `setup/modules/onshape/bin/agentbox-onshape` (Python stdlib; `whoami`, `upload`, `docs`, `tabs`) |
| The agents' skill | `server/seed-skills/onshape` (refreshed at every start; given to roles mapped to the integration) |
| The helper's guide | `server/seed-skills/agentbox-setup` § 6b |
| Test | `setup/modules/onshape/test/test_agentbox_onshape.py` (a mock Onshape API) |

**Auth:** an Onshape API key (developer portal → API keys; scopes Read + Write), used with HTTP Basic
auth, stored in `<secrets>/onshape.env` (`ONSHAPE_ACCESS_KEY`, `ONSHAPE_SECRET_KEY`) through
`agentbox secret set`, never printed. `whoami` lists one document first: Onshape answers
`/users/sessioninfo` with an empty 200 even for a wrong key, while listing documents needs a valid one.

**API calls** (`/api/v12`, from Onshape's published OpenAPI): `GET /documents` (find by name),
`POST /documents` (create, `isPublic: false` unless `allow_public`), `POST /blobelements/d/{did}/w/{wid}`
(multipart upload with `translate=true`, `encodedFilename` = the tab name), `GET /translations/{tid}`
(poll until DONE), `POST /documents/d/{did}/versions`.

**Only adds:** the tool has no delete, rename, share or publish command. On a plan that can't make
private documents it stops and says so; it never makes a public document unless the owner set
`allow_public`.
