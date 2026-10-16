# Ansible Role: Uptime Kuma

This role installs the Uptime Kuma application. Uptime Kuma is an easy-to-use self-hosted monitoring tool designed to send alerts when monitored services go down and to track uptime statistics. This role is created for Debian 13 and for Uptime Kuma version 2.5.5; other versions are not tested.

After running the role, the `uptime-kuma` service will be available on the server. The application's web interface can be accessed at `http://{your-server-ip}:3001`.

## Requirements

Requires Node 22 or later to be installed on the server (you can use the geerlingguy.nodejs role to install Node if needed).

## Role Variables

Available variables are listed below, along with default values (see `defaults/main.yml`):

```yaml
app_repository_url: "https://github.com/louislam/uptime-kuma.git"
```

URL used in git clone command.

```yaml
app_repository_dir: "/opt/uptime-kuma"
```

Set repository destination path. If modified, ensure the `uptime-kuma` system user has permission to modify this directory.

```yaml
app_version: "2.5.5"
```

Set desired version of the app.

```yaml
systemd_template: "2.5.5"
```

The template to use when generating systemd service.

```yaml
uptime_kuma_admin_username: "admin"
uptime_kuma_admin_password: "{{ vault_uptime_kuma_admin_password }}"
```

Credentials for the initial administrator account. The account is created
automatically after the service starts, by `files/setup-uptime-kuma.js`, using the internal `Socket.IO API`. The password is expected to be stored in Ansible Vault, but it can also be defined as a variable.

```yaml
uptime_kuma_db_type: "mariadb" # or sqlite
## For mariadb only
uptime_kuma_db_hostname: db.example.com
uptime_kuma_db_port: "3306"
uptime_kuma_db_name: uptime_kuma
uptime_kuma_db_username: uptime_kuma
uptime_kuma_db_password: "{{ vault_uptime_kuma_db_password }}"
uptime_kuma_db_enable_ssl: false
```

Database connection settings written to `/etc/uptime-kuma/uptime-kuma.env`.

> [!NOTE]
> When using SQLite, only the db_type variable is required. Only use the remaining variables when db_type is set to mariadb.

```yaml
uptime_kuma_monitors: []
uptime_kuma_monitor_defaults:
  active: true
  interval: 60
  retryInterval: 60
  maxretries: 0
  resendInterval: 0
  upsideDown: false
```

Monitors to create, update or remove. Each entry uses Uptime Kuma's native
monitor fields, so any field supported by the application can be set. `name` and
`type` are required.
Only the fields present in an entry (plus `uptime_kuma_monitor_defaults`) are
reconciled, so values changed through the web UI are preserved unless the role
also manages them.

> [!WARNING]
> `name` must be unique and is used as the idempotency key.

The following helper keys are understood in addition to the native fields:

- `state`: `present` (default) or `absent`, to create/update or delete a monitor.
- `notifications`: list of notification names, resolved to their IDs. The named
  notifications must already exist in Uptime Kuma. A raw `notificationIDList`
  may be used instead.
- `tags`: list of tag names, or `{name, value}` mappings. Missing tags are
  created automatically.
- `parent`: parent monitor id, or the name of another monitor in the role.

> [!Note]
> `active` is applied too. A monitor paused in the web UI is resumed on
> the next role run unless it is set to `active: false`.

## Dependencies

None.

## Example Playbook

```yaml
- hosts: server
  vars_files:
    - vars/main.yml
    - vault.yml  # Path to your Ansible Vault file.
  roles:
    - uptime-kuma
```

*Inside `vars/main.yml`*:

```yaml
app_version: 2.5.5

uptime_kuma_db_type: sqlite

uptime_kuma_admin_username: uptime-kuma

uptime_kuma_monitors:
  - name: Example website
    type: http
    url: https://example.com
    notifications:
      - Email
      - Telegram
    tags:
      - production
  - name: Database
    type: tcp
    hostname: db.example.com
    port: 3306
    interval: 120
  - name: Old monitor
    state: absent
```

*Inside `vault.yml`*:

```yaml
# If using mariadb
vault_uptime_kuma_db_password: supersecurepassword

vault_uptime_kuma_admin_password: supersecurepassword

```

## License

## Author Information

This role was created in 2026 by [tonirp](https://github.com/tonirp26)
