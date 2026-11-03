<div align="center">

# Surge Tailscale Status Panel (`surge-tailscale-panel`)

<p>Real-time Tailscale node status panel for <strong>Surge iOS &amp; Surge Mac</strong>, with smart deduplication and optional auto-cleanup for ghost offline nodes (`-1`, `-2`, …).</p>

<p>
  <a href="./README.md"><img src="https://img.shields.io/badge/Language-English%20(Default)-007AFF?style=for-the-badge" alt="English"></a>
  <a href="./README.zh-CN.md"><img src="https://img.shields.io/badge/%E8%AF%AD%E8%A8%80-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-34C759?style=for-the-badge" alt="简体中文"></a>
</p>

<p>
  <img src="./assets/preview.png" alt="Surge Tailscale Panel Preview" width="264">
</p>

</div>

---

## ✨ Features

- **Native JavaScriptCore Compatibility**: Zero dependency on browser-only DOM APIs (`URLSearchParams`, `btoa`). Uses standard Tailscale API v2 `Bearer` authentication and safe parameter decoding (`try/catch` + `Object.create(null)`).
- **Explicit Online Detection**: Determines online state strictly from the API's explicit boolean status field (`connectedToControl` / `online` via `?fields=all`), never guessing online status from `lastSeen`.
- **Ghost Node Deduplication (`HIDE_DUP`)**: When Surge's built-in `[Tailscale]` client re-authenticates, Tailscale often leaves behind duplicate offline entries with numeric suffixes (`-1`, `-2`, …). This panel identifies duplicate offline entries sharing the same base name, `hostname`, `os`, and `user`, and hides them from the panel while keeping active/newest sessions visible.
- **Optional Cloud Auto-Cleanup (`CLEAN_DUP`)**: Safely disabled (`false`) by default. When explicitly enabled (`true`), the script calls `DELETE /api/v2/device/{id}` for verified older duplicate offline ghost nodes (requiring complete identity fields, explicit boolean online state, and a valid `lastSeen` timestamp) and reports the verified HTTP deletion result in the panel title.
- **Configurable Visible Node Count (`MAX_VISIBLE`)**: Customize how many device rows are displayed (`1`–`5`, default `5`). Online nodes are prioritized at the top, and remaining nodes are neatly folded into a single summary line while the title still displays the full `Online / Total` count.

---

## 📦 Files

| File | Description |
| :--- | :--- |
| [`Tailscale-Panel.sgmodule`](./Tailscale-Panel.sgmodule) | Surge module definition (`[Panel]` + `[Script]`). |
| [`tailscale-panel.js`](./tailscale-panel.js) | Standalone Surge panel script (ES5 / JavaScriptCore compatible). |
| [`README.md`](./README.md) | English documentation (default). |
| [`README.zh-CN.md`](./README.zh-CN.md) | Simplified Chinese documentation (简体中文文档). |
| [`LICENSE`](./LICENSE) | MIT License. |

---

## 🚀 Installation

### Option 1: Local / iCloud Drive Surge Directory
1. Copy both [`Tailscale-Panel.sgmodule`](./Tailscale-Panel.sgmodule) and [`tailscale-panel.js`](./tailscale-panel.js) into your Surge `Documents` directory (e.g., `iCloud Drive/Surge/`).
2. Enable **Tailscale 节点状态面板** in Surge **Modules**, click **Edit Arguments**, and fill in your `API_KEY` (leave `SCRIPT_PATH` as `tailscale-panel.js`).

### Option 2: Remote Subscription via HTTP(S) Raw URL
Surge resolves relative `script-path` values against your local Surge configuration directory. When installing the module via a remote URL without copying `tailscale-panel.js` locally, you **must** set `SCRIPT_PATH` (or replace `script-path` in `Tailscale-Panel.sgmodule` before hosting) to the full HTTP(S) Raw URL of `tailscale-panel.js`:
```text
https://raw.githubusercontent.com/flylocus/surge-tailscale-panel/main/tailscale-panel.js
```

---

## ⚙️ Module Arguments (`#!arguments`)

| Argument | Default | Description |
| :--- | :--- | :--- |
| `TAILNET` | `-` | Your Tailnet organization name. Keep the default `-` to automatically match the account of your API token. |
| `API_KEY` | `tskey-api-xxx` | **Required.** Your Tailscale API access token (`tskey-api-...`) or OAuth/trust credential access token. |
| `MAX_VISIBLE` | `5` | Maximum number of device rows shown in the panel (`1`–`5`, clamped automatically). Extra nodes are folded into a summary line. |
| `HIDE_DUP` | `true` | Hide older duplicate offline ghost nodes (`-1`, `-2`, …) in the panel display (`true` / `false`). Does **not** delete devices from Tailscale cloud. |
| `CLEAN_DUP` | `false` | Automatically call `DELETE /api/v2/device/{id}` to remove verified older duplicate offline ghost nodes from your Tailnet (`true` / `false`). Disabled by default for safety. |
| `SCRIPT_PATH` | `tailscale-panel.js` | Script path (`tailscale-panel.js` for local Surge directory, or full `https://...` Raw URL for remote subscription). |

---

## 🔑 Tailscale Credential Permissions & Safety Notes

> [!CAUTION]
> **Never commit, share, or screenshot a configured `.sgmodule` file, Surge profile, or request log containing your real `API_KEY`.** If a token is accidentally exposed, immediately revoke it in the [Tailscale Admin Console → Keys](https://login.tailscale.com/admin/settings/keys) and generate a new one.

- **Recommended (Least Privilege): OAuth Clients / Trust Credential Tokens (`devices:core:read`)**:
  - Prefer issuing a least-privilege token with **`devices:core:read`** scope when `CLEAN_DUP=false` (default read-only mode), or **`devices:core`** only if you explicitly enable `CLEAN_DUP=true`. Note that short-lived OAuth access tokens typically expire after 1 hour and are not auto-refreshed by this script; for unattended long-term panel use, rotate tokens externally or use an API access token with caution.
- **Higher Risk: Personal API Access Tokens (`tskey-api-...` from Admin Console → Keys)**:
  - Personal API access tokens inherit the full account role permissions of the user who created them and do not support fine-grained scopes. Keep `CLEAN_DUP=false` (the default) unless you intentionally want automatic cloud device deletion, and guard the token carefully.
- **Deletion Safety Guards (`CLEAN_DUP=true`)**:
  - Deleting a device permanently removes it from your Tailnet. The script only deletes a candidate node when all of the following hold:
    1. It has complete identity fields (`id`, `name`, `hostname`, `os`, `user`), an explicit boolean online state (`connectedToControl: false` / `online: false`), and a valid `lastSeen` timestamp;
    2. It shares the exact same base name, `hostname`, `os`, and `user` with an auto-numbered (`-N`) sibling node;
    3. Another node in that exact group is explicitly online (`connectedToControl: true`) or has a strictly newer `lastSeen` timestamp.

---

## 📄 License

[MIT](./LICENSE)
