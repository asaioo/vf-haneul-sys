# Cloudflare Tunnel deployment

Cloudflare Tunnel publishes the loopback-only vf-kapo server without opening an inbound port or managing a TLS certificate:

```text
GitHub/browser -> https://kapo.example.com -> Cloudflare Tunnel -> 127.0.0.1:3000 -> vf-kapo
```

The existing `compose.yaml` already binds port 3000 to `127.0.0.1`, so no Compose network change is required.

## Choose a tunnel

- **Quick Tunnel**: no account or domain, but its random `trycloudflare.com` hostname changes when restarted. Use it only for a connectivity test.
- **Named Tunnel**: requires a domain managed by Cloudflare and provides a stable hostname. Use this for GitHub OAuth and webhooks.

## 1. Start vf-kapo locally

Follow [DEPLOY.md](DEPLOY.md) to create `.env.production`, place the GitHub App key at `secrets/github-app.pem`, and start the container:

```sh
docker compose config
docker compose build
docker compose up -d
docker compose ps
curl -i http://127.0.0.1:3000/
```

Do not continue until the container is healthy and the local request succeeds.

## 2. Install `cloudflared`

Ubuntu/Debian on x86-64:

```sh
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cloudflared.deb
sudo dpkg -i /tmp/cloudflared.deb
cloudflared --version
```

For ARM64, use `cloudflared-linux-arm64.deb`. On macOS, run `brew install cloudflared`; on Windows, run `winget install --id Cloudflare.cloudflared`.

## 3. Optional quick connectivity test

```sh
cloudflared tunnel --url http://127.0.0.1:3000
```

Copy the printed URL, such as `https://random-words.trycloudflare.com`, into `.env.production`:

```dotenv
APP_ORIGIN=https://random-words.trycloudflare.com
```

Recreate the application so it reads the new origin, then test the public URL:

```sh
docker compose up -d --force-recreate
curl -i https://random-words.trycloudflare.com/
```

Keep the `cloudflared` process running. The URL changes whenever Quick Tunnel is restarted, so do not use it as a permanent GitHub App URL.

## 4. Create a stable named tunnel

1. Add a domain to Cloudflare and wait until its nameservers show as active.
2. In Cloudflare Zero Trust, open **Networks > Tunnels** (sometimes shown under **Networks > Connectors**) and create a Cloudflared tunnel named `vf-kapo`.
3. Run the connector installation command shown by Cloudflare. On Linux it normally resembles:

   ```sh
   sudo cloudflared service install YOUR_TUNNEL_TOKEN
   ```

   The token is a credential. Do not put it in this repository or `.env.production`.
4. Add a Public Hostname with these values:

   | Setting | Value |
   | --- | --- |
   | Hostname | `kapo.example.com` |
   | Path | empty |
   | Service type | `HTTP` |
   | Service URL | `localhost:3000` |

5. Set the exact public origin, with no trailing slash, in `.env.production`:

   ```dotenv
   APP_ORIGIN=https://kapo.example.com
   ```

6. Recreate and verify the application:

   ```sh
   docker compose up -d --force-recreate
   sudo systemctl status cloudflared
   curl -i http://127.0.0.1:3000/
   curl -i https://kapo.example.com/
   ```

Enable both services across reboots:

```sh
sudo systemctl enable --now docker
sudo systemctl enable --now cloudflared
```

## 5. Update the GitHub App

Use the same hostname everywhere:

```text
Homepage URL: https://kapo.example.com
Callback URL: https://kapo.example.com/auth/github/callback
Webhook URL:  https://kapo.example.com/webhooks/github
```

The GitHub webhook secret must exactly match `GITHUB_WEBHOOK_SECRET` in `.env.production`. Save the GitHub App settings, then redeliver a recent webhook and confirm a `2xx` response.

Do not put Cloudflare Access, Under Attack Mode, or an interactive challenge in front of `/webhooks/github`; GitHub cannot pass a browser challenge. The application independently validates the webhook HMAC signature. The simplest initial configuration is to leave Cloudflare Access disabled for this hostname.

## Network and security notes

- Do not open or forward port 3000 on the router or host firewall.
- Permit outbound HTTPS and Cloudflare Tunnel traffic. Cloudflared normally uses port 7844 and can fall back to HTTPS transport.
- The tunnel only handles inbound traffic. The host must separately reach GitHub and `GOVERNANCE_MODEL_BASE_URL`.
- If the model endpoint is internal or IP-allowlisted, run vf-kapo on a machine that can reach that network.
- Do not send private repository evidence over a public plain-HTTP model connection.

## Troubleshooting

### Cloudflare returns 502

```sh
curl -i http://127.0.0.1:3000/
docker compose ps
docker compose logs --tail=200 vf-kapo
sudo systemctl status cloudflared
sudo journalctl -u cloudflared --since "10 minutes ago"
```

Confirm that the Public Hostname service is `http://localhost:3000`. This address is correct when `cloudflared` runs as a host service; a separately containerized connector would need the Docker service name instead.

### OAuth redirect mismatch or CSRF 403

Confirm all browser traffic uses the public hostname and that these values match exactly:

```text
APP_ORIGIN=https://kapo.example.com
Callback=https://kapo.example.com/auth/github/callback
```

Do not include a trailing slash in `APP_ORIGIN`.

### Webhook delivery fails

Check that:

- the URL ends in `/webhooks/github`;
- GitHub and `.env.production` use the same webhook secret;
- the GitHub App is installed on the configured repository;
- no Cloudflare Access or challenge blocks the path;
- `docker compose logs -f vf-kapo` shows no signature or repository mismatch.
