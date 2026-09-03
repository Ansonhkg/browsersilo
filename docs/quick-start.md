# Quick start

## Run BrowserSilo

```sh
test -f .env || cp .env.example .env
make setup
make images
make up
```

Run this from the source repository root with Node.js 24+ and Docker running. Compose loads `.env` automatically. `make images` builds both the control plane and the disposable Brave worker image before startup. Change the host ports in `.env` if needed; the examples below use the defaults. The included tokens are public development defaults: keep the loopback binding and use test accounts only.

Open `http://127.0.0.1:4101` and enter `admin-local-development-token`. The overview shows capacity, encrypted identities, active browsers, artifacts, and alerts. The Live browsers page can watch a browser, request exclusive human control, and return control to the agent.

## Test without an AI agent

Check the gateway, then open a test identity with a 15-minute lease:

```sh
curl --fail http://127.0.0.1:4100/health

curl --fail-with-body http://127.0.0.1:4100/v1/browsers \
  -H 'Authorization: Bearer agent-local-development-token' \
  -H 'Content-Type: application/json' \
  -d '{"identity":"local-test","ttlSeconds":900,"allowedDomains":["example.com"]}'
```

Copy the returned `id` into `BROWSER_ID` below, then open a page:

```sh
BROWSER_ID=lease_replace_with_returned_id
curl --fail-with-body "http://127.0.0.1:4100/v1/browsers/$BROWSER_ID/actions" \
  -H 'Authorization: Bearer agent-local-development-token' \
  -H 'Content-Type: application/json' \
  -d '{"type":"navigate","url":"https://example.com/"}'
```

In the dashboard, open **Leases** and click **Watch**. You should see Example Domain running in Brave. No OpenAI or other AI-provider key is required. The first browser may take longer because the template starts with no idle workers.

When finished, close the browser to save its identity and destroy its worker:

```sh
curl --fail-with-body -X DELETE "http://127.0.0.1:4100/v1/browsers/$BROWSER_ID" \
  -H 'Authorization: Bearer agent-local-development-token'
```

Opening `local-test` again restores the saved identity in a new worker. If you changed the ports or tokens in `.env`, use those values in the commands and dashboard instead.

## Ask an agent to browse

Connect the agent to `http://127.0.0.1:4100/mcp` with bearer token `agent-local-development-token`, then use an ordinary prompt:

> Open my `weekly-groceries` browser and check whether my usual items are available on the supermarket’s real website. Do not add or buy anything. Close the browser when done.

BrowserSilo creates the identity on first use. Later prompts with the same name resume its cookies, history, logins, storage, and preferences in a new disposable worker.

## Sign in privately

Ask the agent to open the sign-in page, click Take over in HeroUI, enter credentials directly in Brave, then click Return control. Agent input is rejected while takeover is active. After return, the agent must read a fresh page snapshot before continuing.

## Collect evidence

Ask:

> Record this support workflow and collect the complete network and page evidence for the current domain. Stop before sending the form.

The resulting encrypted artifacts appear under Captures and Recordings. Export remains owner-authorized at request time.

## Stop

```sh
make down
```

The encrypted data volume remains. Use `docker compose down --volumes` only when you intentionally want to remove local persistent data.
